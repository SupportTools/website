---
title: "Kubernetes Secrets Management: External Secrets Operator with Vault, AWS, and GCP"
date: 2029-12-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "External Secrets", "Vault", "AWS", "GCP", "Secrets Management", "Security", "ESO"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering External Secrets Operator installation, SecretStore backends for Vault, AWS SSM/Secrets Manager, and GCP Secret Manager, ExternalSecret templating, refresh intervals, and secret rotation automation."
more_link: "yes"
url: "/kubernetes-secrets-management-external-secrets-operator-vault-aws-gcp/"
---

Storing secrets directly in Kubernetes Secrets objects — even when base64 encoded and encrypted at rest with KMS — leaves sensitive values in etcd and accessible to anyone with `kubectl get secret` RBAC rights. External Secrets Operator (ESO) shifts the source of truth entirely outside Kubernetes to purpose-built secrets managers: HashiCorp Vault, AWS Secrets Manager, AWS SSM Parameter Store, GCP Secret Manager, and others. ESO continuously syncs secrets into Kubernetes, handles rotation, and keeps your etcd free of long-lived credentials.

<!--more-->

## External Secrets Operator Architecture

ESO introduces three CRDs:

- **SecretStore**: Namespace-scoped backend configuration (credentials, endpoint, auth method)
- **ClusterSecretStore**: Cluster-scoped backend, usable from any namespace
- **ExternalSecret**: Describes which keys to fetch, how to map them into a Kubernetes Secret, and the refresh interval

The operator watches ExternalSecret resources and reconciles the corresponding Kubernetes Secrets on a configurable schedule. When the upstream secret value changes, ESO detects the drift on the next refresh cycle and updates the Kubernetes Secret automatically.

## Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --set webhook.port=9443 \
  --set certController.requeueInterval=5m \
  --wait

# Verify installation
kubectl get pods -n external-secrets
kubectl get crds | grep external-secrets
```

## HashiCorp Vault Backend

### Vault Configuration

```bash
# Enable KV v2 secrets engine
vault secrets enable -path=secret kv-v2

# Create application secrets
vault kv put secret/payment-service \
  DB_PASSWORD=<your-db-password> \
  API_KEY=<your-api-key> \
  STRIPE_SECRET=<your-stripe-secret>

# Create a policy for the ESO service account
vault policy write eso-payment-service - <<EOF
path "secret/data/payment-service" {
  capabilities = ["read"]
}
path "secret/metadata/payment-service" {
  capabilities = ["read", "list"]
}
EOF

# Enable Kubernetes auth method
vault auth enable kubernetes

# Configure Kubernetes auth (run inside the cluster)
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc.cluster.local:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"

# Create a Vault role binding ESO's service account to the policy
vault write auth/kubernetes/role/eso-payment-service \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=eso-payment-service \
  ttl=24h
```

### ClusterSecretStore for Vault

```yaml
# vault-cluster-secret-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.internal.example.com"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "eso-payment-service"
          serviceAccountRef:
            name: "external-secrets"
            namespace: "external-secrets"
      caBundle: |
        -----BEGIN CERTIFICATE-----
        # Your Vault CA certificate here
        -----END CERTIFICATE-----
```

### ExternalSecret from Vault

```yaml
# payment-service-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payment-service-secrets
  namespace: payment-service
spec:
  refreshInterval: "5m"
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: payment-service-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
    template:
      engineVersion: v2
      metadata:
        annotations:
          reloader.stakater.com/match: "true"
      type: Opaque
      data:
        # Direct key mapping
        DB_PASSWORD: "{{ .db_password }}"
        API_KEY: "{{ .api_key }}"
        # Composed value using template
        DATABASE_URL: "postgresql://app:{{ .db_password }}@postgres.payment-service.svc.cluster.local:5432/payments"
  data:
    - secretKey: db_password
      remoteRef:
        key: payment-service
        property: DB_PASSWORD
    - secretKey: api_key
      remoteRef:
        key: payment-service
        property: API_KEY
  dataFrom:
    # Bulk fetch all keys from a Vault path
    - extract:
        key: payment-service
```

## AWS Secrets Manager Backend

### IRSA Authentication

ESO uses IAM Roles for Service Accounts (IRSA) to authenticate to AWS without static credentials:

```bash
# Create the IAM policy for ESO
aws iam create-policy \
  --policy-name ExternalSecretsOperatorPolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ],
        "Resource": [
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:production/*",
          "arn:aws:ssm:us-east-1:123456789012:parameter/production/*"
        ]
      }
    ]
  }'

# Associate the policy with the ESO service account via IRSA
eksctl create iamserviceaccount \
  --name external-secrets \
  --namespace external-secrets \
  --cluster my-eks-cluster \
  --attach-policy-arn arn:aws:iam::123456789012:policy/ExternalSecretsOperatorPolicy \
  --approve \
  --override-existing-serviceaccounts
```

### ClusterSecretStore for AWS Secrets Manager

```yaml
# aws-secretsmanager-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secretsmanager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

### ExternalSecret from AWS Secrets Manager

```yaml
# api-gateway-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: api-gateway-secrets
  namespace: api-gateway
spec:
  refreshInterval: "15m"
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: api-gateway-secrets
    creationPolicy: Owner
    template:
      type: Opaque
  data:
    - secretKey: JWT_SIGNING_KEY
      remoteRef:
        key: production/api-gateway
        property: jwt_signing_key
    - secretKey: OAUTH_CLIENT_SECRET
      remoteRef:
        key: production/api-gateway
        property: oauth_client_secret
    # Fetch a JSON secret and extract a nested property
    - secretKey: DATABASE_PASSWORD
      remoteRef:
        key: production/rds/api-gateway-db
        property: password
```

## AWS SSM Parameter Store Backend

```yaml
# aws-ssm-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-ssm
spec:
  provider:
    aws:
      service: ParameterStore
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
---
# ssm-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: feature-flags-config
  namespace: frontend
spec:
  refreshInterval: "2m"
  secretStoreRef:
    name: aws-ssm
    kind: ClusterSecretStore
  target:
    name: feature-flags-config
    creationPolicy: Owner
  dataFrom:
    # Fetch all parameters under /production/frontend/
    - find:
        path: /production/frontend
        name:
          regexp: ".*"
        tags:
          environment: production
          application: frontend
```

## GCP Secret Manager Backend

### Workload Identity Authentication

```bash
# Create a GCP service account for ESO
gcloud iam service-accounts create external-secrets-operator \
  --project=my-gcp-project \
  --display-name="External Secrets Operator"

# Grant Secret Manager access
gcloud projects add-iam-policy-binding my-gcp-project \
  --member="serviceAccount:external-secrets-operator@my-gcp-project.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Bind Kubernetes service account to GCP service account via Workload Identity
gcloud iam service-accounts add-iam-policy-binding \
  external-secrets-operator@my-gcp-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-gcp-project.svc.id.goog[external-secrets/external-secrets]"

# Annotate the Kubernetes service account
kubectl annotate serviceaccount external-secrets \
  --namespace external-secrets \
  iam.gke.io/gcp-service-account=external-secrets-operator@my-gcp-project.iam.gserviceaccount.com
```

### ClusterSecretStore for GCP

```yaml
# gcp-secretmanager-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: gcp-secretmanager
spec:
  provider:
    gcpsm:
      projectID: "my-gcp-project"
      auth:
        workloadIdentity:
          clusterLocation: us-central1
          clusterName: my-gke-cluster
          clusterProjectID: my-gcp-project
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

### ExternalSecret from GCP Secret Manager

```yaml
# notification-service-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: notification-service-secrets
  namespace: notification-service
spec:
  refreshInterval: "10m"
  secretStoreRef:
    name: gcp-secretmanager
    kind: ClusterSecretStore
  target:
    name: notification-service-secrets
    creationPolicy: Owner
    template:
      type: Opaque
      data:
        # GCP Secret Manager stores entire secret as a string
        SENDGRID_API_KEY: "{{ .sendgrid_api_key }}"
        TWILIO_AUTH_TOKEN: "{{ .twilio_auth_token }}"
  data:
    - secretKey: sendgrid_api_key
      remoteRef:
        key: notification-service-sendgrid-api-key
        # Optionally pin to a specific version
        version: latest
    - secretKey: twilio_auth_token
      remoteRef:
        key: notification-service-twilio-auth-token
        version: latest
```

## Multi-Backend PushSecret for Replication

ESO's `PushSecret` resource syncs a Kubernetes Secret *to* an external backend — useful for replicating generated certificates or tokens across multiple backends:

```yaml
# push-tls-cert-to-vault.yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-tls-cert
  namespace: cert-manager
spec:
  refreshInterval: "1h"
  secretStoreRefs:
    - name: vault-backend
      kind: ClusterSecretStore
  selector:
    secret:
      name: wildcard-tls-cert
  data:
    - match:
        secretKey: tls.crt
        remoteRef:
          remoteKey: infrastructure/wildcard-tls
          property: cert
    - match:
        secretKey: tls.key
        remoteRef:
          remoteKey: infrastructure/wildcard-tls
          property: key
```

## Secret Rotation Automation

### Detect Rotation Events via Annotations

Annotate ExternalSecrets to trigger pod restarts when the upstream secret rotates. The `reloader` sidecar (Stakater Reloader) monitors the Kubernetes Secret and restarts pods:

```yaml
# payment-service-deployment.yaml (snippet)
metadata:
  annotations:
    secret.reloader.stakater.com/reload: "payment-service-secrets"
```

### Force Immediate Refresh

```bash
# Trigger an immediate refresh without waiting for the interval
kubectl annotate externalsecret payment-service-secrets \
  --namespace payment-service \
  force-sync=$(date +%s) \
  --overwrite

# Check sync status
kubectl get externalsecret payment-service-secrets \
  --namespace payment-service \
  -o jsonpath='{.status.conditions[*]}'
```

## Monitoring and Alerting

ESO exposes Prometheus metrics. Create alerts for sync failures:

```yaml
# eso-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-secrets-operator
  namespace: external-secrets
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: external-secrets
      interval: 30s
      rules:
        - alert: ExternalSecretSyncFailed
          expr: |
            externalsecret_status_condition{type="Ready",status="False"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "ExternalSecret sync failed"
            description: "ExternalSecret {{ $labels.name }} in namespace {{ $labels.namespace }} has been failing to sync for 5 minutes."

        - alert: ExternalSecretRefreshTooOld
          expr: |
            (time() - externalsecret_sync_calls_total) > 3600
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "ExternalSecret has not synced recently"
            description: "ExternalSecret {{ $labels.name }} has not synced in the last hour."
```

## RBAC for ExternalSecret Management

Restrict who can create ExternalSecrets to prevent namespace-scoped privilege escalation:

```yaml
# eso-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: external-secrets-editor
rules:
  - apiGroups: ["external-secrets.io"]
    resources: ["externalsecrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["external-secrets.io"]
    resources: ["secretstores"]
    verbs: ["get", "list", "watch"]
  # Deny ClusterSecretStore access to namespace-scoped users
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cluster-secret-store-admin
rules:
  - apiGroups: ["external-secrets.io"]
    resources: ["clustersecretstores"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

## Summary

External Secrets Operator provides a clean separation between secret storage and Kubernetes workloads. Each backend (Vault, AWS, GCP) uses native authentication mechanisms — Kubernetes auth for Vault, IRSA for AWS, Workload Identity for GCP — eliminating static credentials entirely. The templating engine in ExternalSecret allows composing Kubernetes Secret values from multiple upstream sources, and the refresh interval ensures automated rotation propagation. Combined with Stakater Reloader for pod restart signaling and Prometheus alerts for sync failure detection, ESO delivers a robust, audit-friendly secrets lifecycle.
