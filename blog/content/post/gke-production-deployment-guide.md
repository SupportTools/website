---
title: "GKE Production Deployment: Autopilot, Workload Identity, and Cost Controls"
date: 2027-08-05T00:00:00-05:00
draft: false
tags: ["GKE", "Google Cloud", "Kubernetes", "Cloud", "Production"]
categories:
- GKE
- Kubernetes
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth production guide for Google Kubernetes Engine covering Autopilot vs Standard mode, Workload Identity Federation, GKE Dataplane V2, Binary Authorization, multi-cluster Ingress, node auto-provisioning, and committed use discount strategies."
more_link: "yes"
url: "/gke-production-deployment-guide/"
---

Google Kubernetes Engine (GKE) offers some of the most mature Kubernetes-native features among managed cloud providers. From Autopilot mode that abstracts away node management entirely, to Dataplane V2 with Cilium-based networking, to deep Google Cloud service integration through Workload Identity, GKE provides a rich set of primitives for building production-grade platforms. This guide covers every major architectural decision for GKE in production.

<!--more-->

# [GKE Production Deployment](#gke-production-deployment)

## Section 1: GKE Standard vs Autopilot Mode

### Standard Mode

GKE Standard mode provides full control over node configuration, machine types, and node pool composition. Operators manage node pools, OS images, and scaling policies. This mode suits workloads requiring specific hardware (GPUs, high-memory instances, local SSD), custom OS configuration, or DaemonSets that must run on every node.

```bash
# Create a GKE Standard cluster
gcloud container clusters create prod-cluster \
  --project my-project \
  --region us-central1 \
  --cluster-version 1.30 \
  --release-channel regular \
  --enable-ip-alias \
  --network prod-vpc \
  --subnetwork prod-subnet \
  --cluster-secondary-range-name pods \
  --services-secondary-range-name services \
  --enable-private-nodes \
  --enable-private-endpoint \
  --master-ipv4-cidr 172.16.0.0/28 \
  --enable-master-authorized-networks \
  --master-authorized-networks 10.0.0.0/8 \
  --workload-pool my-project.svc.id.goog \
  --enable-shielded-nodes \
  --shielded-secure-boot \
  --shielded-integrity-monitoring \
  --logging=SYSTEM,API_SERVER,CONTROLLER_MANAGER,SCHEDULER,WORKLOAD \
  --monitoring=SYSTEM,DAEMONSET,DEPLOYMENT,STATEFULSET,STORAGE,HPA,POD,CADVISOR,KUBELET \
  --enable-dataplane-v2 \
  --enable-network-policy \
  --num-nodes 1 \
  --machine-type e2-standard-4 \
  --disk-type pd-ssd \
  --disk-size 100
```

### Autopilot Mode

GKE Autopilot removes node pool management entirely. Google provisions and manages nodes based on pod resource requests. Billing is per-pod rather than per-node, making it cost-efficient for variable workloads. Autopilot enforces security policies automatically and does not allow privileged pods, host namespace access, or DaemonSets.

```bash
# Create a GKE Autopilot cluster
gcloud container clusters create-auto prod-autopilot \
  --project my-project \
  --region us-central1 \
  --release-channel regular \
  --network prod-vpc \
  --subnetwork prod-subnet \
  --cluster-secondary-range-name pods \
  --services-secondary-range-name services \
  --enable-private-nodes \
  --enable-master-authorized-networks \
  --master-authorized-networks 10.0.0.0/8 \
  --workload-pool my-project.svc.id.goog
```

### Mode Selection Matrix

| Criterion | Standard | Autopilot |
|---|---|---|
| Node control | Full | None |
| DaemonSets | Supported | Not supported |
| Privileged pods | Configurable | Not allowed |
| GPU nodes | Supported | Supported (T4, A100) |
| Spot instances | Manual | Automatic |
| Billing | Per node | Per pod |
| Node OS customization | Supported | Not supported |
| Custom machine types | Any | Predefined |

## Section 2: Node Pool Configuration

### System Node Pool

Every Standard cluster should have a dedicated system node pool for cluster-critical workloads (kube-system components, Istio control plane, monitoring agents). Taint this pool to prevent application pods from landing on it.

```bash
# Create system node pool
gcloud container node-pools create system-pool \
  --cluster prod-cluster \
  --region us-central1 \
  --machine-type n2-standard-4 \
  --num-nodes 1 \
  --min-nodes 1 \
  --max-nodes 3 \
  --enable-autoscaling \
  --disk-type pd-ssd \
  --disk-size 100 \
  --image-type COS_CONTAINERD \
  --shielded-secure-boot \
  --shielded-integrity-monitoring \
  --node-taints CriticalAddonsOnly=true:NoSchedule \
  --node-labels role=system,node-pool=system \
  --workload-metadata GKE_METADATA
```

### Application Node Pool with Spot VMs

```bash
# Create application node pool with spot VM support
gcloud container node-pools create app-pool-spot \
  --cluster prod-cluster \
  --region us-central1 \
  --machine-type n2-standard-8 \
  --num-nodes 2 \
  --min-nodes 0 \
  --max-nodes 50 \
  --enable-autoscaling \
  --spot \
  --disk-type pd-ssd \
  --disk-size 100 \
  --image-type COS_CONTAINERD \
  --shielded-secure-boot \
  --shielded-integrity-monitoring \
  --node-taints cloud.google.com/gke-spot=true:NoSchedule \
  --node-labels role=application,cloud.google.com/gke-spot=true \
  --workload-metadata GKE_METADATA
```

Pod configuration for spot-tolerant workloads:

```yaml
spec:
  tolerations:
    - key: cloud.google.com/gke-spot
      operator: Equal
      value: "true"
      effect: NoSchedule
  terminationGracePeriodSeconds: 25
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: cloud.google.com/gke-spot
                operator: In
                values:
                  - "true"
```

### GPU Node Pool

```bash
# Create GPU node pool for ML workloads
gcloud container node-pools create gpu-pool \
  --cluster prod-cluster \
  --region us-central1 \
  --machine-type a2-highgpu-1g \
  --accelerator type=nvidia-tesla-a100,count=1,gpu-driver-version=default \
  --num-nodes 0 \
  --min-nodes 0 \
  --max-nodes 10 \
  --enable-autoscaling \
  --disk-type pd-ssd \
  --disk-size 200 \
  --node-taints nvidia.com/gpu=present:NoSchedule \
  --node-labels role=gpu,accelerator=nvidia-a100 \
  --workload-metadata GKE_METADATA
```

## Section 3: Workload Identity Federation

### How Workload Identity Works

Workload Identity Federation is the recommended way to allow GKE workloads to access Google Cloud services. Rather than distributing service account key files, pods bind to a Kubernetes service account that is linked to a Google service account. The GKE metadata server intercepts credentials requests and exchanges the Kubernetes service account token for a short-lived Google Cloud access token.

### Enabling Workload Identity

```bash
# Enable Workload Identity on an existing cluster
gcloud container clusters update prod-cluster \
  --region us-central1 \
  --workload-pool my-project.svc.id.goog

# Enable on a node pool
gcloud container node-pools update app-pool \
  --cluster prod-cluster \
  --region us-central1 \
  --workload-metadata GKE_METADATA
```

### Creating the IAM Binding

```bash
# Create a Google service account
gcloud iam service-accounts create app-gcs-reader \
  --project my-project \
  --display-name "App GCS Reader"

# Grant the GSA permissions on the resource
gcloud storage buckets add-iam-policy-binding gs://my-app-bucket \
  --member "serviceAccount:app-gcs-reader@my-project.iam.gserviceaccount.com" \
  --role roles/storage.objectViewer

# Bind the Kubernetes service account to the Google service account
gcloud iam service-accounts add-iam-policy-binding \
  app-gcs-reader@my-project.iam.gserviceaccount.com \
  --project my-project \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[production/app-sa]"
```

### Kubernetes Service Account Annotation

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-sa
  namespace: production
  annotations:
    iam.gke.io/gcp-service-account: app-gcs-reader@my-project.iam.gserviceaccount.com
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: app-sa
      containers:
        - name: app
          image: gcr.io/my-project/my-app:latest
          env:
            - name: GOOGLE_CLOUD_PROJECT
              value: my-project
```

### Verifying Workload Identity

```bash
# Test workload identity from within a pod
kubectl run -it --rm workload-identity-test \
  --image google/cloud-sdk:slim \
  --serviceaccount app-sa \
  --namespace production \
  -- gcloud auth list
```

## Section 4: GKE Dataplane V2

### Architecture Overview

GKE Dataplane V2 (enabled with `--enable-dataplane-v2`) uses eBPF-based networking through a managed Cilium deployment. It replaces iptables-based kube-proxy with BPF programs that run directly in the Linux kernel, providing significant performance improvements and native Kubernetes NetworkPolicy enforcement without requiring a separate network policy controller.

```bash
# Enable Dataplane V2 on a new cluster
gcloud container clusters create prod-cluster \
  --enable-dataplane-v2 \
  --enable-network-policy \
  --region us-central1

# Verify Dataplane V2 is active
kubectl get pods -n kube-system -l k8s-app=cilium
kubectl exec -n kube-system cilium-XXXXX -- cilium status
```

### Network Policy with Dataplane V2

Dataplane V2 enables additional policy features including FQDN-based egress policies and enhanced logging:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-network-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              role: frontend
      ports:
        - protocol: TCP
          port: 8080
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: database
      ports:
        - protocol: TCP
          port: 5432
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 443
```

### Enabling Cilium Network Policy Observability

```bash
# Check network policy verdict logs (Dataplane V2)
kubectl exec -n kube-system cilium-XXXXX -- \
  cilium monitor --type policy-verdict

# View network flow logs
kubectl exec -n kube-system cilium-XXXXX -- \
  cilium monitor --type drop
```

## Section 5: GKE Ingress and Cloud Load Balancer

### GKE Ingress Controller

GKE provides a native Ingress controller that provisions Google Cloud HTTP(S) Load Balancers. The controller supports both external and internal load balancers and integrates with Google-managed SSL certificates.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: prod-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: gce
    kubernetes.io/ingress.global-static-ip-name: prod-ingress-ip
    networking.gke.io/managed-certificates: prod-cert
    kubernetes.io/ingress.allow-http: "false"
    networking.gke.io/v1beta1.FrontendConfig: prod-frontend-config
spec:
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
    - host: www.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-service
                port:
                  number: 80
```

### Google-Managed SSL Certificates

```yaml
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: prod-cert
  namespace: production
spec:
  domains:
    - api.example.com
    - www.example.com
```

### Frontend and Backend Configuration

```yaml
apiVersion: networking.gke.io/v1beta1
kind: FrontendConfig
metadata:
  name: prod-frontend-config
  namespace: production
spec:
  sslPolicy: prod-ssl-policy
  redirectToHttps:
    enabled: true
    responseCodeName: MOVED_PERMANENTLY_DEFAULT
---
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: api-backend-config
  namespace: production
spec:
  timeoutSec: 30
  connectionDraining:
    drainingTimeoutSec: 60
  healthCheck:
    checkIntervalSec: 15
    timeoutSec: 5
    healthyThreshold: 1
    unhealthyThreshold: 2
    type: HTTP
    requestPath: /healthz
    port: 8080
  sessionAffinity:
    affinityType: GENERATED_COOKIE
    affinityCookieTtlSec: 50
  cdn:
    enabled: false
  logging:
    enable: true
    sampleRate: 1.0
```

Annotate the Service to associate the BackendConfig:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    cloud.google.com/backend-config: '{"default": "api-backend-config"}'
    cloud.google.com/neg: '{"ingress": true}'
spec:
  type: ClusterIP
  selector:
    app: api
  ports:
    - port: 8080
      targetPort: 8080
```

## Section 6: Multi-Cluster Ingress

### Fleet Registration

Multi-Cluster Ingress routes traffic across multiple GKE clusters using Google's global load balancing infrastructure. Clusters must be registered to a fleet (Anthos/GKE Hub).

```bash
# Enable the Multi-Cluster Ingress API
gcloud services enable multiclusteringress.googleapis.com \
  --project my-project

# Register clusters to the fleet
gcloud container clusters update prod-cluster-us \
  --enable-fleet \
  --project my-project \
  --region us-central1

gcloud container clusters update prod-cluster-eu \
  --enable-fleet \
  --project my-project \
  --region europe-west1

# Set config cluster for Multi-Cluster Ingress
gcloud container fleet ingress enable \
  --config-membership projects/my-project/locations/us-central1/memberships/prod-cluster-us
```

### MultiClusterIngress Resource

```yaml
# Apply this in the config cluster only
apiVersion: networking.gke.io/v1
kind: MultiClusterIngress
metadata:
  name: global-ingress
  namespace: production
spec:
  template:
    spec:
      backend:
        serviceName: global-api-mcs
        servicePort: 8080
      rules:
        - host: api.example.com
          http:
            paths:
              - path: /
                backend:
                  serviceName: global-api-mcs
                  servicePort: 8080
---
apiVersion: networking.gke.io/v1
kind: MultiClusterService
metadata:
  name: global-api-mcs
  namespace: production
spec:
  template:
    spec:
      selector:
        app: api
      ports:
        - name: http
          protocol: TCP
          port: 8080
```

## Section 7: Config Connector

### Overview

Config Connector is a GKE add-on that allows managing Google Cloud resources as Kubernetes custom resources. Teams using GitOps workflows can declare GCP resources alongside Kubernetes manifests.

```bash
# Enable Config Connector add-on
gcloud container clusters update prod-cluster \
  --update-addons ConfigConnector=ENABLED \
  --region us-central1

# Create Config Connector service account and binding
gcloud iam service-accounts create config-connector-sa \
  --project my-project

gcloud projects add-iam-policy-binding my-project \
  --member "serviceAccount:config-connector-sa@my-project.iam.gserviceaccount.com" \
  --role roles/owner

gcloud iam service-accounts add-iam-policy-binding \
  config-connector-sa@my-project.iam.gserviceaccount.com \
  --member "serviceAccount:my-project.svc.id.goog[cnrm-system/cnrm-controller-manager]" \
  --role roles/iam.workloadIdentityUser
```

### Config Connector Resources

```yaml
# ConfigConnectorContext per namespace
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: production
spec:
  googleServiceAccount: config-connector-sa@my-project.iam.gserviceaccount.com
---
# Create a Cloud SQL instance via Config Connector
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: prod-db
  namespace: production
spec:
  region: us-central1
  databaseVersion: POSTGRES_15
  settings:
    tier: db-custom-4-15360
    availabilityType: REGIONAL
    backupConfiguration:
      enabled: true
      pointInTimeRecoveryEnabled: true
      backupRetentionSettings:
        retainedBackups: 7
    ipConfiguration:
      ipv4Enabled: false
      privateNetworkRef:
        name: prod-vpc
      requireSsl: true
    maintenanceWindow:
      day: 7
      hour: 3
    databaseFlags:
      - name: max_connections
        value: "500"
---
# Create a GCS bucket
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-app-assets
  namespace: production
spec:
  location: US
  storageClass: STANDARD
  uniformBucketLevelAccess: true
  versioning:
    enabled: true
  lifecycleRule:
    - action:
        type: Delete
      condition:
        numNewerVersions: 3
        withState: ARCHIVED
```

## Section 8: GKE Release Channels

### Release Channel Configuration

GKE release channels automate minor version upgrades based on validation cadence. Production clusters should use the Regular channel for a balance of stability and feature availability.

```bash
# Enroll cluster in Regular release channel
gcloud container clusters update prod-cluster \
  --release-channel regular \
  --region us-central1

# Configure maintenance window
gcloud container clusters update prod-cluster \
  --region us-central1 \
  --maintenance-window-start "2027-01-01T02:00:00Z" \
  --maintenance-window-end "2027-01-01T06:00:00Z" \
  --maintenance-window-recurrence "FREQ=WEEKLY;BYDAY=SA,SU"

# Exclude specific dates from maintenance
gcloud container clusters update prod-cluster \
  --region us-central1 \
  --add-maintenance-exclusion-name "year-end-freeze" \
  --add-maintenance-exclusion-start "2027-12-20T00:00:00Z" \
  --add-maintenance-exclusion-end "2028-01-02T23:59:59Z"
```

### Manual Version Upgrades

```bash
# List available versions for the Regular channel
gcloud container get-server-config \
  --region us-central1 \
  --format "yaml(channels)"

# Upgrade control plane manually within the channel
gcloud container clusters upgrade prod-cluster \
  --region us-central1 \
  --master \
  --cluster-version 1.31.0-gke.1000001

# Upgrade a specific node pool
gcloud container clusters upgrade prod-cluster \
  --region us-central1 \
  --node-pool app-pool \
  --cluster-version 1.31.0-gke.1000001
```

## Section 9: Node Auto-Provisioning

### Enabling Node Auto-Provisioning

Node Auto-Provisioning (NAP) dynamically creates and deletes node pools in response to pending pod requirements. NAP eliminates the need to manually configure node pools for every workload type.

```bash
# Enable node auto-provisioning
gcloud container clusters update prod-cluster \
  --enable-autoprovisioning \
  --min-cpu 4 \
  --max-cpu 1000 \
  --min-memory 16 \
  --max-memory 4000 \
  --autoprovisioning-scopes https://www.googleapis.com/auth/cloud-platform \
  --autoprovisioning-service-account nap-sa@my-project.iam.gserviceaccount.com \
  --region us-central1

# Configure auto-provisioning defaults
gcloud container clusters update prod-cluster \
  --autoprovisioning-defaults \
  disk-size=100,disk-type=pd-ssd,image-type=COS_CONTAINERD,shielded-secure-boot=true,shielded-integrity-monitoring=true \
  --region us-central1
```

### AutoprovisioningNodePoolDefaults via Terraform

```hcl
resource "google_container_cluster" "prod" {
  name     = "prod-cluster"
  location = "us-central1"

  cluster_autoscaling {
    enabled = true

    auto_provisioning_defaults {
      disk_size    = 100
      disk_type    = "pd-ssd"
      image_type   = "COS_CONTAINERD"
      oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
      service_account = "nap-sa@my-project.iam.gserviceaccount.com"

      shielded_instance_config {
        enable_secure_boot          = true
        enable_integrity_monitoring = true
      }

      management {
        auto_repair  = true
        auto_upgrade = true
      }

      upgrade_settings {
        strategy        = "SURGE"
        max_surge       = 1
        max_unavailable = 0
      }
    }

    resource_limits {
      resource_type = "cpu"
      minimum       = 4
      maximum       = 1000
    }

    resource_limits {
      resource_type = "memory"
      minimum       = 16
      maximum       = 4000
    }

    resource_limits {
      resource_type = "nvidia-tesla-t4"
      minimum       = 0
      maximum       = 10
    }
  }
}
```

## Section 10: Binary Authorization

### Policy Configuration

Binary Authorization enforces that only cryptographically signed container images are deployed to GKE. An attestation authority signs images after they pass build and vulnerability scanning checks.

```bash
# Enable Binary Authorization on the cluster
gcloud container clusters update prod-cluster \
  --binauthz-evaluation-mode PROJECT_SINGLETON_POLICY_ENFORCE \
  --region us-central1

# Enable Binary Authorization API
gcloud services enable binaryauthorization.googleapis.com \
  --project my-project
```

### Creating an Attestor

```bash
# Create KMS key ring and key for signing
gcloud kms keyrings create binauthz-keys \
  --location us-central1 \
  --project my-project

gcloud kms keys create attestor-key \
  --location us-central1 \
  --keyring binauthz-keys \
  --purpose asymmetric-signing \
  --default-algorithm ec-sign-p256-sha256 \
  --project my-project

# Get the key version resource name
KEY_VERSION=$(gcloud kms keys versions list \
  --key attestor-key \
  --keyring binauthz-keys \
  --location us-central1 \
  --format "value(name)" \
  --filter "state=ENABLED")

# Create attestor
gcloud container binauthz attestors create build-verified \
  --attestation-authority-note projects/my-project/notes/build-verified \
  --project my-project

# Add the KMS key to the attestor
gcloud container binauthz attestors public-keys add \
  --attestor build-verified \
  --keyversion "${KEY_VERSION}" \
  --project my-project
```

### Binary Authorization Policy

```yaml
# binauthz-policy.yaml
admissionWhitelistPatterns:
  - namePattern: gcr.io/google_containers/*
  - namePattern: gcr.io/google-containers/*
  - namePattern: k8s.gcr.io/*
  - namePattern: gke.gcr.io/*
  - namePattern: gcr.io/stackdriver-agents/*
defaultAdmissionRule:
  evaluationMode: REQUIRE_ATTESTATION
  enforcementMode: ENFORCED_BLOCK_AND_AUDIT_LOG
  requireAttestationsBy:
    - projects/my-project/attestors/build-verified
clusterAdmissionRules:
  us-central1.prod-cluster:
    evaluationMode: REQUIRE_ATTESTATION
    enforcementMode: ENFORCED_BLOCK_AND_AUDIT_LOG
    requireAttestationsBy:
      - projects/my-project/attestors/build-verified
  us-central1.dev-cluster:
    evaluationMode: ALWAYS_ALLOW
    enforcementMode: ENFORCED_BLOCK_AND_AUDIT_LOG
```

```bash
# Apply the policy
gcloud container binauthz policy import binauthz-policy.yaml \
  --project my-project
```

### Signing Images in CI/CD

```bash
# After building and pushing image to Artifact Registry
IMAGE_DIGEST=$(gcloud artifacts docker images describe \
  us-central1-docker.pkg.dev/my-project/app-repo/api@sha256:DIGEST \
  --format "value(image_summary.digest)")

FULL_IMAGE="us-central1-docker.pkg.dev/my-project/app-repo/api@${IMAGE_DIGEST}"

# Create attestation
gcloud container binauthz attestations sign-and-create \
  --artifact-url "${FULL_IMAGE}" \
  --attestor build-verified \
  --attestor-project my-project \
  --keyversion "${KEY_VERSION}" \
  --project my-project
```

## Section 11: Cost Optimization with Commitments

### Committed Use Discounts

Compute Engine Committed Use Discounts (CUDs) provide 37-55% discounts for committed resource usage over one or three years. For GKE Standard clusters, CUDs apply to the underlying Compute Engine VMs.

```bash
# Purchase a 1-year CUD for CPU and memory
gcloud compute commitments create prod-commitment-2027 \
  --region us-central1 \
  --plan 12-month \
  --resources vcpu=100,memory=400GB \
  --type GENERAL_PURPOSE_N2
```

### Cluster Autoscaler Scale-Down Settings

```bash
# Configure aggressive scale-down for cost savings
kubectl patch deployment cluster-autoscaler \
  -n kube-system \
  --type=json \
  -p='[
    {"op":"add","path":"/spec/template/spec/containers/0/command/-","value":"--scale-down-delay-after-add=5m"},
    {"op":"add","path":"/spec/template/spec/containers/0/command/-","value":"--scale-down-unneeded-time=3m"},
    {"op":"add","path":"/spec/template/spec/containers/0/command/-","value":"--scale-down-utilization-threshold=0.4"},
    {"op":"add","path":"/spec/template/spec/containers/0/command/-","value":"--max-node-provision-time=15m"}
  ]'
```

### Vertical Pod Autoscaler for Right-Sizing

```bash
# Install VPA components
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler
./hack/vpa-install.sh
```

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4
          memory: 4Gi
        controlledResources:
          - cpu
          - memory
        controlledValues: RequestsAndLimits
```

### Cost Monitoring with GKE Cost Allocation

```bash
# Enable GKE cost allocation
gcloud container clusters update prod-cluster \
  --region us-central1 \
  --enable-cost-allocation
```

Once enabled, cost allocation exports per-namespace and per-label breakdowns to Cloud Billing and BigQuery. Query cost data:

```sql
-- BigQuery query for namespace-level GKE cost breakdown
SELECT
  namespace,
  SUM(cost) AS total_cost,
  SUM(credits.amount) AS total_credits,
  SUM(cost + credits.amount) AS net_cost
FROM
  `my-project.billing_export.gcp_billing_export_resource_v1_BILLING_ACCOUNT_ID`
WHERE
  DATE(_PARTITIONTIME) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND service.description = "Kubernetes Engine"
  AND labels.key = "k8s-namespace"
GROUP BY
  namespace
ORDER BY
  net_cost DESC
LIMIT 20;
```

## Section 12: GKE Monitoring with Google Cloud Observability

### Managed Prometheus

GKE Managed Service for Prometheus (GMP) provides a fully managed Prometheus-compatible monitoring backend. It integrates with Google Cloud Managed Service for Prometheus and requires no infrastructure to operate.

```bash
# Enable managed Prometheus on a cluster
gcloud container clusters update prod-cluster \
  --enable-managed-prometheus \
  --region us-central1
```

```yaml
# PodMonitoring resource for GMP
apiVersion: monitoring.googleapis.com/v1
kind: PodMonitoring
metadata:
  name: api-monitoring
  namespace: production
spec:
  selector:
    matchLabels:
      app: api
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
      timeout: 10s
```

### Custom Rules in GMP

```yaml
apiVersion: monitoring.googleapis.com/v1
kind: Rules
metadata:
  name: api-rules
  namespace: production
spec:
  groups:
    - name: api.slo
      interval: 60s
      rules:
        - record: api:request_error_rate:5m
          expr: |
            rate(http_requests_total{status=~"5.."}[5m]) /
            rate(http_requests_total[5m])
        - alert: APIErrorRateHigh
          expr: api:request_error_rate:5m > 0.01
          for: 5m
          labels:
            severity: page
          annotations:
            summary: "API error rate exceeds 1%"
            runbook: "https://runbooks.example.com/api-errors"
```

### Cloud Logging Integration

```bash
# Configure log-based metrics
gcloud logging metrics create pod-error-count \
  --description "Count of pod-level errors" \
  --log-filter 'resource.type="k8s_container" severity>=ERROR'

# Create alerting policy on log-based metric
gcloud alpha monitoring policies create \
  --policy-from-file log-alert-policy.json
```

## Section 13: Security Hardening

### Shielded GKE Nodes

```bash
# Enable Shielded Nodes cluster-wide
gcloud container clusters update prod-cluster \
  --enable-shielded-nodes \
  --region us-central1

# Verify shielded node status
gcloud container node-pools describe app-pool \
  --cluster prod-cluster \
  --region us-central1 \
  --format "yaml(config.shieldedInstanceConfig)"
```

### Intranode Visibility

```bash
# Enable intranode visibility for VPC flow logs between pods on same node
gcloud container clusters update prod-cluster \
  --enable-intra-node-visibility \
  --region us-central1
```

### GKE Sandbox (gVisor)

```bash
# Create sandbox node pool using gVisor
gcloud container node-pools create sandbox-pool \
  --cluster prod-cluster \
  --region us-central1 \
  --machine-type n2-standard-4 \
  --sandbox type=gvisor \
  --num-nodes 2 \
  --min-nodes 1 \
  --max-nodes 10 \
  --enable-autoscaling \
  --node-taints gvisor=true:NoSchedule
```

```yaml
# Use gVisor sandbox for untrusted workloads
apiVersion: v1
kind: Pod
metadata:
  name: sandboxed-app
spec:
  runtimeClassName: gvisor
  tolerations:
    - key: gvisor
      operator: Equal
      value: "true"
      effect: NoSchedule
  containers:
    - name: app
      image: untrusted-app:latest
```

## Section 14: GKE Upgrade Best Practices

### Blue-Green Node Pool Upgrade

For zero-downtime node pool upgrades, create a new node pool with the target version, migrate workloads, then delete the old pool.

```bash
# Step 1: Create new node pool with target version
gcloud container node-pools create app-pool-v131 \
  --cluster prod-cluster \
  --region us-central1 \
  --machine-type n2-standard-8 \
  --num-nodes 3 \
  --cluster-version 1.31.0-gke.1000001 \
  --disk-type pd-ssd \
  --disk-size 100 \
  --node-labels role=application,pool-version=131

# Step 2: Cordon old node pool nodes
for node in $(kubectl get nodes -l cloud.google.com/gke-nodepool=app-pool -o name); do
  kubectl cordon "${node}"
done

# Step 3: Drain old nodes (in batches to respect PDB)
for node in $(kubectl get nodes -l cloud.google.com/gke-nodepool=app-pool -o name); do
  kubectl drain "${node}" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=120 \
    --timeout=300s
done

# Step 4: Verify workloads on new pool
kubectl get pods -o wide --all-namespaces | grep app-pool-v131

# Step 5: Delete old node pool
gcloud container node-pools delete app-pool \
  --cluster prod-cluster \
  --region us-central1
```

## Section 15: Production Readiness Checklist

Before taking a GKE cluster to production, verify the following:

**Cluster Configuration:**
- Private cluster with master authorized networks configured
- Workload Identity enabled on all node pools
- Shielded nodes with Secure Boot and Integrity Monitoring
- Dataplane V2 for improved network performance and policy enforcement
- Release channel enrollment for automated upgrades
- Maintenance windows configured to avoid business hours

**Security:**
- Binary Authorization policy in ENFORCED mode
- Pod Security Standards enforced at namespace level
- NetworkPolicy applied to all production namespaces
- Container images scanned in Artifact Registry before deployment
- Secrets managed via Secret Manager with Config Connector or External Secrets Operator

**Reliability:**
- Node pools spread across three zones
- PodDisruptionBudgets defined for all stateful and critical workloads
- Cluster Autoscaler or NAP configured with appropriate limits
- VPA recommendations reviewed and applied
- Liveness, readiness, and startup probes configured on all containers

**Observability:**
- Managed Prometheus enabled with PodMonitoring resources
- System and workload logging enabled
- Alert policies configured for critical error rates and resource saturation
- SLO dashboards in Cloud Monitoring
- Cost allocation enabled and monitored in BigQuery

**Cost:**
- Committed Use Discounts purchased for baseline node count
- Spot VM node pools for burst workloads
- Namespace-level cost allocation labels applied
- Unused node pools deleted
