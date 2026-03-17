---
title: "Kubernetes Workload Identity Federation: Keyless Authentication for Cloud APIs"
date: 2030-07-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Workload Identity", "IRSA", "GKE", "AKS", "SPIFFE", "OIDC", "IAM"]
categories:
- Kubernetes
- Security
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise workload identity guide: GKE Workload Identity, EKS IRSA, AKS Workload Identity, SPIFFE/SPIRE for multi-cloud, token projection volumes, and eliminating static credentials from Kubernetes workloads."
more_link: "yes"
url: "/kubernetes-workload-identity-federation-keyless-cloud-authentication/"
---

Static credentials in Kubernetes Secrets are a persistent security liability. Long-lived cloud API keys stored in Secrets are exfiltrated via exposed dashboards, leaked in log files, and forgotten in decommissioned namespaces. Workload Identity Federation eliminates this class of problem by binding cloud IAM identities directly to Kubernetes service accounts. Pods receive short-lived, automatically-rotated tokens that cloud providers verify against the cluster's OIDC issuer — no static credentials, no secrets to rotate, no exfiltration surface.

<!--more-->

## The Problem with Static Credentials

Before workload identity, Kubernetes workloads that needed cloud API access had two options:
1. Store long-lived credentials in Kubernetes Secrets
2. Run on nodes with instance profiles (granting all pods on a node the same permissions)

Neither is acceptable for production. Static credentials in Secrets:
- Have long lifetimes (often years before expiration)
- Lack pod-level granularity (a Secret accessible to one pod is accessible to all pods with the same RBAC)
- Cannot be scoped to specific workloads without complex external rotation processes
- Are easily leaked through environment variables, log output, or Kubernetes audit logs

Node-level instance profiles:
- Grant all pods on the node the same IAM permissions
- Cannot be scoped to individual applications
- Violate the principle of least privilege at every level

## Workload Identity Federation Architecture

All three major cloud providers use the same underlying mechanism: OIDC federation.

```
Kubernetes API Server
├── OIDC Issuer (e.g., https://oidc.eks.us-east-1.amazonaws.com/id/CLUSTER_ID)
│   └── Signing key: cluster-specific RSA key pair
│
└── ServiceAccount Token (projected volume)
    ├── iss: https://oidc.eks.us-east-1.amazonaws.com/id/CLUSTER_ID
    ├── sub: system:serviceaccount:production:my-service
    ├── aud: sts.amazonaws.com (or cloud-specific audience)
    └── exp: ~1 hour (automatically rotated by kubelet)
```

The pod presents this short-lived token to the cloud provider's STS (Security Token Service). The STS:
1. Downloads the JWKS (JSON Web Key Set) from the cluster's OIDC endpoint
2. Verifies the token's signature
3. Maps the `sub` claim to an IAM role or service account binding
4. Returns short-lived cloud credentials

The entire exchange requires no static secrets and produces credentials that expire in minutes to hours.

## GKE Workload Identity

### Enabling Workload Identity on GKE

```bash
# Enable Workload Identity on an existing cluster
gcloud container clusters update my-cluster \
    --region us-central1 \
    --workload-pool=my-project.svc.id.goog

# Create a cluster with Workload Identity from the start
gcloud container clusters create my-cluster \
    --region us-central1 \
    --workload-pool=my-project.svc.id.goog \
    --num-nodes=3 \
    --machine-type=n2-standard-4

# Verify Workload Identity is enabled
gcloud container clusters describe my-cluster \
    --region us-central1 \
    --format="value(workloadIdentityConfig.workloadPool)"
```

### Binding GCP Service Account to Kubernetes Service Account

```bash
# Create a GCP service account for the workload
gcloud iam service-accounts create storage-reader \
    --display-name="Storage Reader Service Account" \
    --project=my-project

# Grant the GCP service account necessary permissions
gcloud projects add-iam-policy-binding my-project \
    --member="serviceAccount:storage-reader@my-project.iam.gserviceaccount.com" \
    --role="roles/storage.objectViewer"

# Create the Kubernetes service account
kubectl create namespace production
kubectl create serviceaccount storage-reader -n production

# Bind the GCP service account to the Kubernetes service account
gcloud iam service-accounts add-iam-policy-binding \
    storage-reader@my-project.iam.gserviceaccount.com \
    --role="roles/iam.workloadIdentityUser" \
    --member="serviceAccount:my-project.svc.id.goog[production/storage-reader]"

# Annotate the Kubernetes service account
kubectl annotate serviceaccount storage-reader \
    -n production \
    iam.gke.io/gcp-service-account=storage-reader@my-project.iam.gserviceaccount.com
```

### Kubernetes Service Account Manifest

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: storage-reader
  namespace: production
  annotations:
    iam.gke.io/gcp-service-account: "storage-reader@my-project.iam.gserviceaccount.com"
```

### Pod Configuration for GKE Workload Identity

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storage-app
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: storage-app
  template:
    metadata:
      labels:
        app: storage-app
    spec:
      serviceAccountName: storage-reader  # Reference the annotated KSA
      containers:
      - name: app
        image: registry.internal.company.com/storage-app:1.5.0
        env:
        # GKE injects GOOGLE_APPLICATION_CREDENTIALS automatically
        # The GCP SDK reads this and uses Workload Identity
        - name: GOOGLE_CLOUD_PROJECT
          value: my-project
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        securityContext:
          runAsNonRoot: true
          allowPrivilegeEscalation: false
          capabilities:
            drop: [ALL]
```

### Verifying GKE Workload Identity

```bash
# Test from within a pod
kubectl run -it --rm debug-wi \
    --image=google/cloud-sdk:slim \
    --serviceaccount=storage-reader \
    --namespace=production \
    -- bash

# Inside the pod:
gcloud auth list
# Should show the GCP service account

curl -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email
# Should return: storage-reader@my-project.iam.gserviceaccount.com

# Test GCS access
gsutil ls gs://my-production-bucket/
```

## EKS IAM Roles for Service Accounts (IRSA)

### Setting Up OIDC Provider

```bash
# Get the OIDC issuer URL for the cluster
OIDC_URL=$(aws eks describe-cluster \
    --name my-cluster \
    --query "cluster.identity.oidc.issuer" \
    --output text)

# Extract the OIDC issuer host
OIDC_ISSUER=$(echo $OIDC_URL | cut -d'/' -f3-)

# Check if OIDC provider exists
aws iam list-open-id-connect-providers | grep $OIDC_ISSUER

# Create the OIDC identity provider (one-time per cluster)
eksctl utils associate-iam-oidc-provider \
    --cluster my-cluster \
    --region us-east-1 \
    --approve

# Or via AWS CLI:
THUMBPRINT=$(openssl s_client -servername oidc.eks.us-east-1.amazonaws.com \
    -showcerts -connect oidc.eks.us-east-1.amazonaws.com:443 </dev/null 2>&1 | \
    openssl x509 -fingerprint -noout | cut -d= -f2 | tr -d ':' | tr 'A-Z' 'a-z')

aws iam create-open-id-connect-provider \
    --url "$OIDC_URL" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "$THUMBPRINT"
```

### Creating the IAM Role

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
OIDC_PROVIDER=$(aws eks describe-cluster \
    --name my-cluster \
    --query "cluster.identity.oidc.issuer" \
    --output text | sed -e "s/^https:\/\///")

# Create the trust policy document
cat > /tmp/trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com",
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:production:s3-reader"
        }
      }
    }
  ]
}
EOF

# Create the IAM role
aws iam create-role \
    --role-name eks-s3-reader \
    --assume-role-policy-document file:///tmp/trust-policy.json \
    --description "EKS S3 reader role for production/s3-reader service account"

# Attach permissions
aws iam attach-role-policy \
    --role-name eks-s3-reader \
    --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# Get the role ARN
ROLE_ARN=$(aws iam get-role \
    --role-name eks-s3-reader \
    --query Role.Arn \
    --output text)
echo "Role ARN: $ROLE_ARN"
```

### Kubernetes Service Account for IRSA

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: s3-reader
  namespace: production
  annotations:
    # The full IAM role ARN
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/eks-s3-reader"
    # Token expiration - default 86400s (24h), min 3600s (1h)
    eks.amazonaws.com/token-expiration: "3600"
```

### Pod Configuration for IRSA

The EKS Pod Identity Webhook automatically injects the projected service account token and environment variables:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: s3-app
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: s3-reader
      containers:
      - name: app
        image: registry.internal.company.com/s3-app:2.0.0
        # These are injected automatically by the EKS Pod Identity Webhook:
        # - AWS_ROLE_ARN=arn:aws:iam::123456789012:role/eks-s3-reader
        # - AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/eks.amazonaws.com/serviceaccount/token
        # - A projected volume at /var/run/secrets/eks.amazonaws.com/serviceaccount/
        env:
        - name: AWS_DEFAULT_REGION
          value: us-east-1
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
```

### Verifying IRSA

```bash
# Check injected environment variables
kubectl exec -n production deployment/s3-app -- env | grep AWS

# Verify token file exists
kubectl exec -n production deployment/s3-app -- \
    ls -la /var/run/secrets/eks.amazonaws.com/serviceaccount/

# Test AWS CLI with IRSA credentials
kubectl exec -n production deployment/s3-app -- \
    aws sts get-caller-identity
# Expected: arn:aws:sts::123456789012:assumed-role/eks-s3-reader/...

kubectl exec -n production deployment/s3-app -- \
    aws s3 ls s3://my-production-bucket/
```

## AKS Workload Identity

AKS Workload Identity (formerly AAD Pod Identity v2) uses Azure AD federated credentials:

```bash
# Enable OIDC issuer on existing cluster
az aks update \
    --resource-group my-rg \
    --name my-cluster \
    --enable-oidc-issuer \
    --enable-workload-identity

# Get OIDC issuer URL
OIDC_ISSUER=$(az aks show \
    --resource-group my-rg \
    --name my-cluster \
    --query "oidcIssuerProfile.issuerUrl" \
    --output tsv)

# Create Azure managed identity
az identity create \
    --resource-group my-rg \
    --name storage-reader-identity

CLIENT_ID=$(az identity show \
    --resource-group my-rg \
    --name storage-reader-identity \
    --query clientId -o tsv)

# Grant the managed identity access to Azure Storage
az role assignment create \
    --role "Storage Blob Data Reader" \
    --assignee $CLIENT_ID \
    --scope "/subscriptions/SUB_ID/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/myaccount"

# Create federated credential linking Azure AD to Kubernetes service account
az identity federated-credential create \
    --name k8s-federation \
    --identity-name storage-reader-identity \
    --resource-group my-rg \
    --issuer "$OIDC_ISSUER" \
    --subject "system:serviceaccount:production:storage-reader" \
    --audiences "api://AzureADTokenExchange"
```

### AKS Service Account Annotation

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: storage-reader
  namespace: production
  annotations:
    azure.workload.identity/client-id: "<managed-identity-client-id>"
    azure.workload.identity/tenant-id: "<azure-tenant-id>"
```

### AKS Pod Labels

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storage-app
  namespace: production
spec:
  template:
    metadata:
      labels:
        app: storage-app
        azure.workload.identity/use: "true"  # Required label
    spec:
      serviceAccountName: storage-reader
      containers:
      - name: app
        image: registry.internal.company.com/storage-app:1.0.0
        # Injected automatically:
        # AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE
```

## SPIFFE/SPIRE for Multi-Cloud Workload Identity

SPIFFE (Secure Production Identity Framework For Everyone) and SPIRE (SPIFFE Runtime Environment) provide a cloud-agnostic workload identity framework. SPIRE issues X.509 SVIDs (SPIFFE Verifiable Identity Documents) that workloads can use with any service that supports mTLS.

### SPIRE Architecture

```
SPIRE Server (per cluster or per federation)
├── CA: Signs X.509 certificates
├── Datastore: Registered entries (workload identities)
└── OIDC Provider: Issues JWT SVIDs

SPIRE Agent (DaemonSet on each node)
├── Attests nodes to SPIRE Server
└── Workload API: Provides SVIDs to local workloads

Workload (pod)
├── Requests SVID from SPIRE Agent via Unix socket
└── Gets: X.509 SVID + JWKS + trust bundle
```

### Installing SPIRE

```bash
# Install SPIRE via Helm
helm repo add spiffe https://spiffe.github.io/helm-charts-hardened
helm repo update

helm install spire spiffe/spire \
    --namespace spire-system \
    --create-namespace \
    --values spire-values.yaml
```

```yaml
# spire-values.yaml
spire-server:
  replicaCount: 3
  persistence:
    enabled: true
    storageClass: gp3-xfs
    size: 10Gi
  ca_subject:
    country: US
    organization: MyCompany
    common_name: SPIRE CA
  federation:
    enabled: false  # Enable for multi-cluster federation

spire-agent:
  fullnameOverride: spire-agent
  nodeAttestor:
    k8sPsat:
      serviceAccountAllowList:
      - spire-system/spire-agent

controllerManager:
  enabled: true
  identities:
    clusterSPIFFEIDs:
    - name: default
      spiffeIDTemplate: "spiffe://company.com/k8s/cluster/{{.TrustDomain}}/ns/{{.PodMeta.Namespace}}/sa/{{.PodSpec.ServiceAccountName}}"
      podSelector: {}
```

### Registering Workloads

```yaml
# SPIRE ClusterSPIFFEID (via SPIRE Controller Manager)
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: payment-service
spec:
  spiffeIDTemplate: "spiffe://company.com/k8s/production/payment-service"
  podSelector:
    matchLabels:
      app.kubernetes.io/name: payment-service
      app.kubernetes.io/component: api
  namespaceSelector:
    matchLabels:
      environment: production
  ttl: 1h
```

### Federated Trust Between Clusters

```yaml
# spire-values.yaml for multi-cluster federation
spire-server:
  federation:
    enabled: true
    bundleEndpoint:
      address: "0.0.0.0"
      port: 8443
      acme:
        tosAccepted: true
        email: platform@company.com
    federatesWith:
    - trustDomain: "cluster-b.company.com"
      bundleEndpointURL: "https://spire.cluster-b.company.com:8443"
      bundleEndpointProfile: "https_spiffe"
```

## Token Projection Volumes

Service account tokens are delivered to pods via projected volumes. Understanding the projection configuration helps debug authentication issues:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: token-demo
  namespace: production
spec:
  serviceAccountName: my-service
  volumes:
  - name: token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600
          # Audience must match what the cloud provider expects:
          # AWS: sts.amazonaws.com
          # GCP: (uses default kubernetes audience)
          # Azure: api://AzureADTokenExchange
          audience: sts.amazonaws.com
      - configMap:
          name: kube-root-ca.crt
          items:
          - key: ca.crt
            path: ca.crt
      - downwardAPI:
          items:
          - path: namespace
            fieldRef:
              fieldPath: metadata.namespace
  containers:
  - name: app
    image: myapp:1.0
    volumeMounts:
    - name: token
      mountPath: /var/run/secrets/token
      readOnly: true
    env:
    - name: AWS_WEB_IDENTITY_TOKEN_FILE
      value: /var/run/secrets/token/token
    - name: AWS_ROLE_ARN
      value: "arn:aws:iam::123456789012:role/my-role"
```

### Inspecting the Token

```bash
# Decode the projected service account token
TOKEN=$(kubectl exec token-demo -n production -- \
    cat /var/run/secrets/token/token)

# Decode JWT payload (without verification)
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq .

# Expected output:
# {
#   "aud": ["sts.amazonaws.com"],
#   "exp": 1720000000,
#   "iat": 1719996400,
#   "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/CLUSTER_ID",
#   "kubernetes.io": {
#     "namespace": "production",
#     "pod": {"name": "token-demo", "uid": "..."},
#     "serviceaccount": {"name": "my-service", "uid": "..."}
#   },
#   "nbf": 1719996400,
#   "sub": "system:serviceaccount:production:my-service"
# }
```

## Eliminating All Static Credentials

### Audit for Remaining Secrets

```bash
# Find Secrets that might contain cloud credentials
kubectl get secrets -A -o json | \
  jq -r '.items[] |
    select(.data | keys[] | test("AWS_|GCP_|AZURE_|TOKEN|KEY|SECRET|CRED")) |
    "\(.metadata.namespace)/\(.metadata.name): \(.data | keys | join(", "))"'

# Check for AWS access key patterns in secret values
kubectl get secrets -A -o json | \
  jq -r '.items[] |
    .metadata.namespace as $ns |
    .metadata.name as $name |
    .data // {} |
    to_entries[] |
    select(.value | @base64d | test("(?i)(aws_access_key|aws_secret)")) |
    "\($ns)/\($name): \(.key)"' 2>/dev/null

# Find Deployments still using Secrets for cloud credentials
kubectl get deployments -A -o json | \
  jq -r '.items[] |
    .metadata.namespace as $ns |
    .metadata.name as $name |
    select(.spec.template.spec.containers[].env[]? |
      .valueFrom.secretKeyRef != null and
      (.name | test("AWS_|GCP_|AZURE_|TOKEN"))) |
    "\($ns)/\($name): uses secret for cloud credentials"' 2>/dev/null
```

### Migration Checklist

```bash
# For each workload using static credentials:

# 1. Identify the IAM permissions needed
aws iam simulate-principal-policy \
    --policy-source-arn arn:aws:iam::123456789012:user/old-user \
    --action-names "s3:GetObject" "s3:PutObject" \
    --resource-arns "*"

# 2. Create appropriately scoped IAM role
# (see IRSA section above)

# 3. Create Kubernetes service account with annotation

# 4. Update Deployment to use serviceAccountName

# 5. Remove Secret reference from Deployment

# 6. Test that workload functions correctly

# 7. Delete the Secret
kubectl delete secret old-cloud-credentials -n production

# 8. Revoke the static credentials in the cloud provider
aws iam delete-access-key \
    --user-name old-user \
    --access-key-id <access-key-id>
```

## Troubleshooting Workload Identity

### IRSA Not Working

```bash
# Check if OIDC provider is configured
aws iam list-open-id-connect-providers

# Verify trust policy condition matches the service account
aws iam get-role --role-name eks-s3-reader \
  --query Role.AssumeRolePolicyDocument

# Check the actual sub claim in the token
kubectl exec -n production deployment/s3-app -- sh -c '
  TOKEN_FILE=$AWS_WEB_IDENTITY_TOKEN_FILE
  if [ -z "$TOKEN_FILE" ]; then
    echo "ERROR: AWS_WEB_IDENTITY_TOKEN_FILE not set"
  else
    echo "Token file: $TOKEN_FILE"
    cat $TOKEN_FILE | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
  fi
'

# Common mismatch: trust policy says "namespace:serviceaccount" but token has different format
# Token sub: "system:serviceaccount:production:s3-reader"
# Trust policy condition: "${OIDC_PROVIDER}:sub": "system:serviceaccount:production:s3-reader"
```

### GKE Workload Identity Not Working

```bash
# Verify the metadata server is accessible from the pod
kubectl exec -n production deployment/storage-app -- \
    curl -s -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"

# Check that the node pool has Workload Identity enabled
gcloud container node-pools describe default-pool \
    --cluster my-cluster \
    --region us-central1 \
    --format="value(config.workloadMetadataConfig.mode)"
# Should be: GKE_METADATA

# Verify the IAM binding
gcloud iam service-accounts get-iam-policy \
    storage-reader@my-project.iam.gserviceaccount.com \
    --format=json | \
    jq -r '.bindings[] | select(.role == "roles/iam.workloadIdentityUser")'
```

## Production Security Best Practices

**Principle of least privilege**: Create one IAM role per workload with only the specific permissions required. Avoid wildcard permissions in production IAM policies.

**Namespace isolation**: The IRSA trust policy condition includes both namespace and service account name. Ensure applications are in isolated namespaces to prevent lateral movement via service account impersonation.

**Token expiration**: Use short token expiration (1 hour for IRSA, which is the minimum). Shorter tokens limit the blast radius of a token leak.

**Audit logging**: Enable CloudTrail (AWS), Cloud Audit Logs (GCP), or Azure Monitor for all STS AssumeRoleWithWebIdentity calls. Anomalous service accounts calling STS from unexpected regions or at unusual times are detectable.

**Secret scanning**: Run tools like `truffleHog` or `detect-secrets` in CI pipelines to detect accidental static credential commits.

**IRSA with Session Tags**: For complex authorization scenarios, use session tags to pass Kubernetes metadata (namespace, pod name) into IAM conditions:

```json
{
  "Condition": {
    "StringEquals": {
      "aws:RequestedRegion": "us-east-1",
      "sts:ExternalId": "production"
    },
    "StringLike": {
      "aws:PrincipalTag/kubernetes-namespace": "production-*"
    }
  }
}
```

Workload Identity Federation is the foundation of a zero-static-credentials Kubernetes security posture. The migration from static credentials to IRSA/GKE WI/AKS WI is a one-time investment per workload that permanently eliminates the credential rotation, expiration, and exfiltration risks that make static credentials so dangerous in long-lived production environments.
