---
title: "Kubernetes Workload Identity Federation: Keyless Cloud Auth for Pods"
date: 2029-01-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "OIDC", "AWS", "GCP", "Azure", "Workload Identity", "IRSA"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes Workload Identity Federation covering AWS IRSA, GKE Workload Identity, Azure Workload Identity, and keyless authentication patterns for eliminating static cloud credentials from pods."
more_link: "yes"
url: "/kubernetes-workload-identity-federation-keyless-cloud-auth-deep-dive/"
---

Static cloud credentials embedded in Kubernetes Secrets are a perennial source of security incidents: credentials expire or are rotated inconsistently, they appear in audit logs and container images, and a single compromised secret provides long-lived access to cloud resources. Workload Identity Federation solves this by binding Kubernetes ServiceAccounts to cloud IAM roles using short-lived OIDC tokens—pods prove their identity to cloud APIs without any pre-shared secret.

This post provides a complete technical guide to implementing Workload Identity Federation on AWS (IRSA), GKE (Workload Identity), and Azure (Azure Workload Identity), including the OIDC federation mechanics, cross-cloud patterns, RBAC hardening, token expiration behavior, and the operational runbook for migrating from static credentials.

<!--more-->

## The Problem with Static Credentials

Before Workload Identity Federation, the standard pattern for granting pod access to cloud resources looked like this:

```yaml
# INSECURE: static AWS credentials in a Kubernetes Secret
apiVersion: v1
kind: Secret
metadata:
  name: aws-credentials
  namespace: production
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: AKIAIOSFODNN7EXAMPLE
  AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

The problems with this approach:
1. **Credential longevity**: Static IAM access keys do not expire automatically. A leaked key provides access until manually rotated.
2. **Over-privilege**: Teams tend to grant broad permissions rather than per-pod least-privilege because managing dozens of IAM users is operationally expensive.
3. **Auditability**: Cloud audit logs show requests from `AKIAIOSFODNN7EXAMPLE`—not from `production/payment-service`. Attribution is difficult.
4. **Secret sprawl**: The credentials must be synchronized to Kubernetes Secrets and kept current across environments.

Workload Identity Federation replaces this with cryptographically-bound, short-lived tokens:

```
Pod (payment-service)
  → Presents Kubernetes ServiceAccount JWT to cloud STS
  → Cloud STS validates JWT signature against cluster OIDC endpoint
  → Cloud STS returns short-lived cloud credential (15–60 min TTL)
  → Pod uses cloud credential for API calls
  → Cloud audit logs show: assumed-role/payment-service-prod
```

## Mechanics: OIDC Federation

The federation relies on the Kubernetes API server acting as an OpenID Connect (OIDC) identity provider. Every ServiceAccount token includes:

```json
{
  "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE",
  "sub": "system:serviceaccount:production:payment-service",
  "aud": ["sts.amazonaws.com"],
  "exp": 1735689600,
  "iat": 1735686000,
  "kubernetes.io": {
    "namespace": "production",
    "pod": {
      "name": "payment-service-7d4f8b9c6-xkp2r",
      "uid": "550e8400-e29b-41d4-a716-446655440000"
    },
    "serviceaccount": {
      "name": "payment-service",
      "uid": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
    }
  }
}
```

The cloud STS validates:
1. The JWT signature using the cluster's public JWKS (published at `{issuerURL}/.well-known/jwks.json`)
2. The `iss` (issuer) claim matches a trusted OIDC provider registered in the cloud account
3. The `sub` (subject) claim matches the IAM role's trust policy condition
4. The `aud` (audience) claim matches the expected value
5. The token is not expired

## AWS: IRSA (IAM Roles for Service Accounts)

### Setting Up the OIDC Provider

For EKS clusters, AWS automatically creates an OIDC provider. For self-managed clusters:

```bash
#!/bin/bash
# setup-oidc-provider.sh — Register cluster OIDC issuer with AWS IAM

CLUSTER_NAME="production-us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION="us-east-1"

# Get the OIDC issuer URL from the cluster
OIDC_URL=$(aws eks describe-cluster \
    --name "${CLUSTER_NAME}" \
    --region "${REGION}" \
    --query "cluster.identity.oidc.issuer" \
    --output text)

echo "OIDC Issuer URL: ${OIDC_URL}"
# https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE

# Get the OIDC thumbprint (required for provider registration)
THUMBPRINT=$(echo | openssl s_client -connect \
    "oidc.eks.${REGION}.amazonaws.com:443" 2>/dev/null | \
    openssl x509 -fingerprint -noout -sha1 | \
    sed 's/SHA1 Fingerprint=//' | \
    tr -d ':' | tr '[:upper:]' '[:lower:]')

echo "Thumbprint: ${THUMBPRINT}"

# Register the OIDC provider with AWS IAM
aws iam create-open-id-connect-provider \
    --url "${OIDC_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "${THUMBPRINT}"

echo "OIDC provider registered: arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_URL#https://}"
```

### Creating IAM Roles with Trust Policies

```bash
#!/bin/bash
# create-irsa-role.sh — Create an IAM role for a specific ServiceAccount

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CLUSTER_NAME="production-us-east-1"
REGION="us-east-1"
NAMESPACE="production"
SERVICE_ACCOUNT_NAME="payment-service"
ROLE_NAME="eks-${CLUSTER_NAME}-${NAMESPACE}-${SERVICE_ACCOUNT_NAME}"

OIDC_URL=$(aws eks describe-cluster \
    --name "${CLUSTER_NAME}" \
    --region "${REGION}" \
    --query "cluster.identity.oidc.issuer" \
    --output text)

OIDC_PROVIDER="${OIDC_URL#https://}"
echo "OIDC Provider: ${OIDC_PROVIDER}"

# Create the trust policy — only this specific ServiceAccount can assume this role
cat > /tmp/trust-policy.json <<EOF
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
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT_NAME}",
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

# Create the role
ROLE_ARN=$(aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document file:///tmp/trust-policy.json \
    --description "IRSA role for ${NAMESPACE}/${SERVICE_ACCOUNT_NAME} in ${CLUSTER_NAME}" \
    --query "Role.Arn" \
    --output text)

echo "Created role: ${ROLE_ARN}"

# Attach the necessary permissions policy
aws iam put-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-name "payment-service-permissions" \
    --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:us-east-1:'"${ACCOUNT_ID}"':payment-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "arn:aws:kms:us-east-1:'"${ACCOUNT_ID}"':key/mrk-payment-encryption"
    }
  ]
}'

echo "Role ARN: ${ROLE_ARN}"
echo "Add this annotation to your ServiceAccount:"
echo "  eks.amazonaws.com/role-arn: ${ROLE_ARN}"
```

### ServiceAccount and Deployment Configuration

```yaml
# payment-service-irsa.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: production
  annotations:
    # The EKS Pod Identity Webhook injects AWS_WEB_IDENTITY_TOKEN_FILE
    # and AWS_ROLE_ARN environment variables based on this annotation
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/eks-production-us-east-1-production-payment-service"
    # Token expiration — default is 86400s (24h), minimum is 3600s (1h)
    eks.amazonaws.com/token-expiration: "3600"
    # Audience — defaults to sts.amazonaws.com
    eks.amazonaws.com/audience: "sts.amazonaws.com"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      serviceAccountName: payment-service
      # IMPORTANT: Do NOT mount the default service account token
      # The EKS webhook injects a separate projected token volume
      automountServiceAccountToken: false
      containers:
      - name: payment-service
        image: registry.example.com/payment-service:v3.2.1
        env:
        # The EKS Pod Identity Webhook injects these automatically
        # They are listed here for documentation purposes only:
        # - name: AWS_WEB_IDENTITY_TOKEN_FILE
        #   value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
        # - name: AWS_ROLE_ARN
        #   value: arn:aws:iam::123456789012:role/eks-production-us-east-1-...
        # - name: AWS_DEFAULT_REGION
        #   value: us-east-1
        - name: AWS_DEFAULT_REGION
          value: us-east-1
        - name: AWS_SDK_LOAD_CONFIG
          value: "true"
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 1Gi
```

## GKE: Workload Identity

GKE Workload Identity binds Kubernetes ServiceAccounts to Google Cloud Service Accounts (GSA) via a fixed `sub` claim format:

```bash
#!/bin/bash
# setup-gke-workload-identity.sh

PROJECT_ID="my-production-project"
CLUSTER_NAME="production-us-central1"
NAMESPACE="production"
KSA_NAME="payment-service"  # Kubernetes Service Account
GSA_NAME="payment-service-gsa"  # Google Service Account

# Enable Workload Identity on the cluster (if not already enabled)
gcloud container clusters update "${CLUSTER_NAME}" \
    --workload-pool="${PROJECT_ID}.svc.id.goog" \
    --region=us-central1

# Create the Google Service Account
gcloud iam service-accounts create "${GSA_NAME}" \
    --project="${PROJECT_ID}" \
    --description="GSA for ${NAMESPACE}/${KSA_NAME} in ${CLUSTER_NAME}" \
    --display-name="${KSA_NAME}"

GSA_EMAIL="${GSA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Grant the Google SA the necessary GCP roles
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${GSA_EMAIL}" \
    --role="roles/pubsub.publisher"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${GSA_EMAIL}" \
    --role="roles/cloudkms.cryptoKeyEncrypterDecrypter" \
    --condition="expression=resource.name.startsWith('projects/${PROJECT_ID}/locations/us-central1/keyRings/payment'),title=payment-kms-only"

# Bind the Kubernetes SA to the Google SA
# This grants the KSA permission to impersonate the GSA
gcloud iam service-accounts add-iam-policy-binding "${GSA_EMAIL}" \
    --project="${PROJECT_ID}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="serviceAccount:${PROJECT_ID}.svc.id.goog[${NAMESPACE}/${KSA_NAME}]"

echo "Binding complete. Annotate your Kubernetes ServiceAccount with:"
echo "  iam.gke.io/gcp-service-account: ${GSA_EMAIL}"
```

```yaml
# gke-payment-service.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: production
  annotations:
    # GKE metadata server uses this annotation to map KSA → GSA
    iam.gke.io/gcp-service-account: "payment-service-gsa@my-production-project.iam.gserviceaccount.com"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      serviceAccountName: payment-service
      containers:
      - name: payment-service
        image: gcr.io/my-production-project/payment-service:v3.2.1
        # GKE Metadata Server (169.254.169.254) handles credential exchange automatically
        # No additional environment variables needed
        env:
        - name: GOOGLE_CLOUD_PROJECT
          value: my-production-project
```

## Azure: Azure Workload Identity

Azure Workload Identity uses the Azure AD OIDC federation (formerly AAD Pod Identity v2):

```bash
#!/bin/bash
# setup-azure-workload-identity.sh

SUBSCRIPTION_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
RESOURCE_GROUP="rg-production-eastus"
CLUSTER_NAME="aks-production-eastus"
NAMESPACE="production"
SERVICE_ACCOUNT_NAME="payment-service"
MANAGED_IDENTITY_NAME="mi-payment-service-prod"

# Get the OIDC issuer URL for the AKS cluster
# (Requires --enable-oidc-issuer flag during cluster creation)
OIDC_ISSUER=$(az aks show \
    --name "${CLUSTER_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "oidcIssuerProfile.issuerUrl" \
    --output tsv)

echo "OIDC Issuer: ${OIDC_ISSUER}"

# Create a User Assigned Managed Identity
az identity create \
    --name "${MANAGED_IDENTITY_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --location eastus

CLIENT_ID=$(az identity show \
    --name "${MANAGED_IDENTITY_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "clientId" \
    --output tsv)

OBJECT_ID=$(az identity show \
    --name "${MANAGED_IDENTITY_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "principalId" \
    --output tsv)

echo "Managed Identity Client ID: ${CLIENT_ID}"

# Assign Azure roles to the managed identity
az role assignment create \
    --assignee-object-id "${OBJECT_ID}" \
    --assignee-principal-type ServicePrincipal \
    --role "Storage Blob Data Contributor" \
    --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Storage/storageAccounts/stpaymentprod"

# Create the federated credential — binds KSA to the managed identity
az identity federated-credential create \
    --name "fc-${NAMESPACE}-${SERVICE_ACCOUNT_NAME}" \
    --identity-name "${MANAGED_IDENTITY_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --issuer "${OIDC_ISSUER}" \
    --subject "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT_NAME}" \
    --audiences "api://AzureADTokenExchange"

echo ""
echo "Annotate your Kubernetes ServiceAccount with:"
echo "  azure.workload.identity/client-id: ${CLIENT_ID}"
```

```yaml
# azure-payment-service.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: production
  annotations:
    azure.workload.identity/client-id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    azure.workload.identity/tenant-id: "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
  labels:
    azure.workload.identity/use: "true"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: payment-service
      containers:
      - name: payment-service
        image: myregistry.azurecr.io/payment-service:v3.2.1
        # Azure Workload Identity mutating webhook injects:
        # - AZURE_CLIENT_ID
        # - AZURE_TENANT_ID
        # - AZURE_FEDERATED_TOKEN_FILE
        # - AZURE_AUTHORITY_HOST
```

## Cross-Cloud Workload Identity: AWS from GKE

For multi-cloud architectures, pods on GKE can assume AWS IAM roles by chaining GCP → AWS federation:

```bash
#!/bin/bash
# gke-to-aws-federation.sh — Allow GKE pods to access AWS resources

GCP_PROJECT_ID="my-production-project"
GKE_OIDC_ISSUER="https://container.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/us-central1/clusters/production-us-central1"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
NAMESPACE="production"
KSA_NAME="data-pipeline"

# Register GKE's OIDC provider in AWS IAM
GKE_THUMBPRINT=$(echo | openssl s_client -connect "container.googleapis.com:443" 2>/dev/null | \
    openssl x509 -fingerprint -noout -sha1 | \
    sed 's/SHA1 Fingerprint=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')

aws iam create-open-id-connect-provider \
    --url "${GKE_OIDC_ISSUER}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "${GKE_THUMBPRINT}"

GKE_OIDC_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/container.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/us-central1/clusters/production-us-central1"

# Create AWS IAM role with trust policy for GKE service account
cat > /tmp/gke-aws-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${GKE_OIDC_ARN}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "container.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/us-central1/clusters/production-us-central1:sub": "system:serviceaccount:${NAMESPACE}:${KSA_NAME}"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
    --role-name "gke-${NAMESPACE}-${KSA_NAME}" \
    --assume-role-policy-document file:///tmp/gke-aws-trust.json
```

## Security Hardening

### Namespace Isolation

```yaml
# Restrict which ServiceAccounts can use workload identity annotations
# This prevents any namespace from creating SAs annotated with privileged roles
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: restrict-workload-identity-annotations
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: [""]
      apiVersions: ["v1"]
      resources: ["serviceaccounts"]
      operations: ["CREATE", "UPDATE"]
  validations:
  - expression: |
      !has(object.metadata.annotations) ||
      !object.metadata.annotations.exists(k, k == "eks.amazonaws.com/role-arn") ||
      object.metadata.annotations["eks.amazonaws.com/role-arn"].startsWith(
        "arn:aws:iam::123456789012:role/eks-" + object.metadata.namespace + "-"
      )
    message: "ServiceAccount role ARN must match the namespace prefix convention"
    reason: Forbidden
```

### Auditing Token Usage

```bash
#!/bin/bash
# audit-workload-identity.sh — Review IRSA token usage in CloudTrail

START_TIME=$(date -u -d '24 hours ago' '+%Y-%m-%dT%H:%M:%SZ')
END_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

echo "=== IRSA AssumeRoleWithWebIdentity calls (last 24h) ==="
aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
    --start-time "${START_TIME}" \
    --end-time "${END_TIME}" \
    --query 'Events[].{
        Time: EventTime,
        Role: Resources[?ResourceType==`AWS::IAM::Role`].ResourceName | [0],
        Pod: replace(CloudTrailEvent, `"sub": "system:serviceaccount:`, `` ) | split(`"`) | [0]
    }' \
    --output table

echo ""
echo "=== Top callers by role ==="
aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
    --start-time "${START_TIME}" \
    --end-time "${END_TIME}" \
    --query 'Events[].Resources[?ResourceType==`AWS::IAM::Role`].ResourceName | []' \
    --output text | \
    tr '\t' '\n' | sort | uniq -c | sort -rn | head -20
```

## Migration from Static Credentials

```bash
#!/bin/bash
# migrate-to-workload-identity.sh — Migration checklist

NAMESPACE="${1:-production}"

echo "=== Workload Identity Migration Audit: ${NAMESPACE} ==="
echo ""

echo "--- Deployments with AWS credential env vars ---"
kubectl get deployments -n "${NAMESPACE}" -o json | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
for deploy in data['items']:
    name = deploy['metadata']['name']
    for container in deploy['spec']['template']['spec'].get('containers', []):
        env_names = [e['name'] for e in container.get('env', [])]
        for cred_env in ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET']:
            if cred_env in env_names:
                print(f'  FOUND: {name}/{container[\"name\"]} uses {cred_env}')
"

echo ""
echo "--- Secrets with cloud credential patterns ---"
kubectl get secrets -n "${NAMESPACE}" -o json | \
    python3 -c "
import sys, json, base64
data = json.load(sys.stdin)
for secret in data['items']:
    name = secret['metadata']['name']
    for key in secret.get('data', {}):
        if any(x in key.upper() for x in ['ACCESS_KEY', 'SECRET_KEY', 'CREDENTIAL', 'PASSWORD', 'TOKEN']):
            print(f'  CANDIDATE: {name}/{key}')
"

echo ""
echo "--- ServiceAccounts already using workload identity ---"
kubectl get serviceaccounts -n "${NAMESPACE}" -o json | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
for sa in data['items']:
    name = sa['metadata']['name']
    annotations = sa.get('metadata', {}).get('annotations', {})
    for anno in ['eks.amazonaws.com/role-arn', 'iam.gke.io/gcp-service-account', 'azure.workload.identity/client-id']:
        if anno in annotations:
            print(f'  MIGRATED: {name} -> {annotations[anno]}')
"
```

## Summary

Workload Identity Federation eliminates static cloud credentials by replacing them with cryptographically-bound, short-lived tokens. The implementation is now mature and well-supported on all major cloud providers:

- **AWS IRSA**: EKS automatically handles the OIDC provider and token injection via the Pod Identity Webhook. Tokens default to 24-hour TTL (configurable to 1 hour for higher security).
- **GKE Workload Identity**: Google's implementation requires annotating the Google Cloud Service Account and the Kubernetes ServiceAccount. The GKE Metadata Server (running as a DaemonSet) handles token exchange transparently.
- **Azure Workload Identity**: Requires the workload identity webhook and a federated credential binding. The `azure.workload.identity/use: "true"` pod label triggers token injection.

The migration path from static credentials is systematic: audit Secrets and env vars for credential patterns, create per-service IAM roles with narrow trust policies, annotate ServiceAccounts, validate credential-free pod startup, then delete the static Secrets. The result is a cluster where cloud access is fully auditable by service account identity, credentials expire automatically, and there are no secrets to rotate or leak.
