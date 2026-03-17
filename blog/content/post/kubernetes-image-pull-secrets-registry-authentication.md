---
title: "Kubernetes Image Pull Secrets and Registry Authentication Patterns"
date: 2029-09-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Container Registry", "Security", "ECR", "GCR", "Authentication", "imagePullSecrets"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes registry authentication covering imagePullSecrets, service account defaults, kubelet credential providers, ECR and GCR token refresh automation, and private registry proxy patterns for production environments."
more_link: "yes"
url: "/kubernetes-image-pull-secrets-registry-authentication/"
---

Container registry authentication in Kubernetes is a deceptively complex topic. The simple case — adding an `imagePullSecret` to a pod spec — works well for static credentials, but production environments invariably require more sophisticated approaches: short-lived tokens that must be refreshed (AWS ECR rotates every 12 hours), multi-cluster credential management, and private registry proxies that cache images to reduce egress costs and improve pull latency.

This guide covers the full spectrum of registry authentication patterns in Kubernetes, from the basics of `imagePullSecrets` through kubelet credential providers, automated token refresh for ECR and GCR, and enterprise private registry proxy architectures.

<!--more-->

# Kubernetes Image Pull Secrets and Registry Authentication Patterns

## Section 1: imagePullSecrets Fundamentals

### Creating Registry Credentials

The base Kubernetes approach uses a `docker-registry` type Secret containing encoded registry credentials.

```bash
# Create from command line
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=myuser \
  --docker-password=mypassword \
  --docker-email=myuser@example.com \
  --namespace=my-app

# Create from existing Docker config
kubectl create secret generic regcred \
  --from-file=.dockerconfigjson=$HOME/.docker/config.json \
  --type=kubernetes.io/dockerconfigjson

# Create for multiple registries from a config.json
cat > /tmp/multi-registry-config.json <<EOF
{
  "auths": {
    "registry.example.com": {
      "auth": "$(echo -n 'user:password' | base64)"
    },
    "private.registry.io": {
      "auth": "$(echo -n 'user2:password2' | base64)"
    }
  }
}
EOF

kubectl create secret generic multi-regcred \
  --from-file=.dockerconfigjson=/tmp/multi-registry-config.json \
  --type=kubernetes.io/dockerconfigjson
```

### The dockerconfigjson Format

Understanding the wire format helps diagnose authentication failures:

```bash
# Decode the secret to verify contents
kubectl get secret regcred -o jsonpath='{.data.\.dockerconfigjson}' | base64 --decode | jq .

# Expected output:
{
  "auths": {
    "registry.example.com": {
      "username": "myuser",
      "password": "mypassword",
      "email": "myuser@example.com",
      "auth": "bXl1c2VyOm15cGFzc3dvcmQ="  # base64(username:password)
    }
  }
}
```

### Pod-Level imagePullSecrets

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      imagePullSecrets:
        - name: regcred
      containers:
        - name: my-app
          image: registry.example.com/my-org/my-app:v1.2.3
```

### Limitations of Per-Pod imagePullSecrets

- Every workload must explicitly reference the secret
- Secrets are namespace-scoped, requiring duplication across namespaces
- Secret rotation requires updating all referencing workloads
- No central audit trail of what pulled what

## Section 2: Service Account Default imagePullSecrets

Rather than adding `imagePullSecrets` to every pod, you can add them to the ServiceAccount. Every pod using that ServiceAccount inherits the pull secrets automatically.

```bash
# Patch the default ServiceAccount to include pull secrets
kubectl patch serviceaccount default \
  --namespace my-app \
  -p '{"imagePullSecrets": [{"name": "regcred"}]}'

# Verify
kubectl get serviceaccount default -n my-app -o yaml
```

### Automating Across Namespaces

For cluster-wide rollout, use a controller or namespace initialization script:

```go
package registry

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

// PatchDefaultServiceAccount ensures all ServiceAccounts in
// target namespaces include the specified imagePullSecret.
func PatchDefaultServiceAccount(
    ctx context.Context,
    client kubernetes.Interface,
    namespace, secretName string,
) error {
    sa, err := client.CoreV1().ServiceAccounts(namespace).
        Get(ctx, "default", metav1.GetOptions{})
    if err != nil {
        return fmt.Errorf("failed to get service account: %w", err)
    }

    // Check if already patched
    for _, ref := range sa.ImagePullSecrets {
        if ref.Name == secretName {
            return nil // Already present
        }
    }

    sa.ImagePullSecrets = append(sa.ImagePullSecrets,
        corev1.LocalObjectReference{Name: secretName})

    _, err = client.CoreV1().ServiceAccounts(namespace).
        Update(ctx, sa, metav1.UpdateOptions{})
    return err
}

// NamespaceController watches for new namespaces and patches
// their default ServiceAccounts with pull secrets.
type NamespaceController struct {
    client     kubernetes.Interface
    secretName string
}

func (c *NamespaceController) OnNamespaceAdded(namespace *corev1.Namespace) error {
    // Copy the pull secret to the new namespace
    if err := c.copySecretToNamespace(context.Background(), namespace.Name); err != nil {
        return fmt.Errorf("failed to copy secret to namespace %s: %w", namespace.Name, err)
    }

    // Patch the default ServiceAccount
    return PatchDefaultServiceAccount(
        context.Background(),
        c.client,
        namespace.Name,
        c.secretName,
    )
}
```

## Section 3: Kubelet Credential Providers

Kubernetes 1.26+ supports kubelet credential providers — plugins that the kubelet calls to obtain dynamic credentials for image pulls. This is the recommended approach for cloud providers with short-lived credentials.

### Credential Provider Architecture

```
kubelet
  └─> credential provider exec plugin (runs per image pull)
        └─> fetches credentials from cloud provider API
              └─> returns credentials to kubelet
                    └─> kubelet uses credentials for image pull
```

### Kubelet Configuration for Credential Providers

```yaml
# /etc/kubernetes/kubelet-credential-provider-config.yaml
apiVersion: kubelet.config.k8s.io/v1
kind: CredentialProviderConfig
providers:
  - name: ecr-credential-provider
    matchImages:
      - "*.dkr.ecr.*.amazonaws.com"
      - "*.dkr.ecr-fips.*.amazonaws.com"
      - "*.dkr.ecr.us-iso-east-1.c2s.ic.gov"
      - "*.dkr.ecr.us-isob-east-1.sc2s.sgov.gov"
    defaultCacheDuration: "12h"
    apiVersion: credentialprovider.kubelet.k8s.io/v1
    args:
      - get-credentials
    env:
      - name: AWS_REGION
        value: "us-east-1"

  - name: gcr-credential-provider
    matchImages:
      - "gcr.io"
      - "*.gcr.io"
      - "*.pkg.dev"
    defaultCacheDuration: "1h"
    apiVersion: credentialprovider.kubelet.k8s.io/v1
    args:
      - get-credentials
```

```bash
# kubelet flags for credential providers
# Add to kubelet configuration:
# --image-credential-provider-config=/etc/kubernetes/kubelet-credential-provider-config.yaml
# --image-credential-provider-bin-dir=/usr/local/bin/

# On EKS-managed nodes, this is pre-configured
# On self-managed nodes:
cat >> /etc/kubernetes/kubelet.env <<EOF
KUBELET_EXTRA_ARGS="--image-credential-provider-config=/etc/kubernetes/kubelet-credential-provider-config.yaml --image-credential-provider-bin-dir=/usr/local/bin/"
EOF
```

### ECR Credential Provider Plugin

```go
// ecr-credential-provider/main.go
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "strings"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/ecr"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    credentialproviderv1 "k8s.io/kubelet/pkg/apis/credentialprovider/v1"
)

func main() {
    // Read CredentialProviderRequest from stdin
    var request credentialproviderv1.CredentialProviderRequest
    decoder := json.NewDecoder(os.Stdin)
    if err := decoder.Decode(&request); err != nil {
        fmt.Fprintf(os.Stderr, "failed to decode request: %v\n", err)
        os.Exit(1)
    }

    credentials, err := getECRCredentials(request.Image)
    if err != nil {
        fmt.Fprintf(os.Stderr, "failed to get credentials: %v\n", err)
        os.Exit(1)
    }

    // Return CredentialProviderResponse via stdout
    response := credentialproviderv1.CredentialProviderResponse{
        TypeMeta: metav1.TypeMeta{
            APIVersion: "credentialprovider.kubelet.k8s.io/v1",
            Kind:       "CredentialProviderResponse",
        },
        CacheKeyType:  credentialproviderv1.RegistryPluginCacheKeyType,
        CacheDuration: &metav1.Duration{Duration: 11 * time.Hour},
        Auth: map[string]credentialproviderv1.AuthConfig{
            extractRegistry(request.Image): {
                Username: "AWS",
                Password: credentials,
            },
        },
    }

    encoder := json.NewEncoder(os.Stdout)
    if err := encoder.Encode(response); err != nil {
        fmt.Fprintf(os.Stderr, "failed to encode response: %v\n", err)
        os.Exit(1)
    }
}

func getECRCredentials(image string) (string, error) {
    ctx := context.Background()

    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        return "", fmt.Errorf("failed to load AWS config: %w", err)
    }

    client := ecr.NewFromConfig(cfg)
    output, err := client.GetAuthorizationToken(ctx,
        &ecr.GetAuthorizationTokenInput{})
    if err != nil {
        return "", fmt.Errorf("failed to get ECR authorization: %w", err)
    }

    if len(output.AuthorizationData) == 0 {
        return "", fmt.Errorf("no authorization data returned")
    }

    token := *output.AuthorizationData[0].AuthorizationToken
    // ECR token is base64(AWS:password)
    decoded, err := base64.StdEncoding.DecodeString(token)
    if err != nil {
        return "", fmt.Errorf("failed to decode token: %w", err)
    }

    // Extract just the password part
    parts := strings.SplitN(string(decoded), ":", 2)
    if len(parts) != 2 {
        return "", fmt.Errorf("unexpected token format")
    }

    return parts[1], nil
}

func extractRegistry(image string) string {
    // Extract registry hostname from image reference
    // e.g., "123456789.dkr.ecr.us-east-1.amazonaws.com/myrepo:tag"
    // -> "123456789.dkr.ecr.us-east-1.amazonaws.com"
    parts := strings.SplitN(image, "/", 2)
    if len(parts) > 1 && strings.Contains(parts[0], ".") {
        return parts[0]
    }
    return "docker.io"
}
```

## Section 4: ECR Token Refresh Automation

ECR authorization tokens expire every 12 hours. For clusters not using the kubelet credential provider, you need an automated refresh mechanism.

### CronJob-Based ECR Token Refresh

```yaml
# ecr-token-refresh-cronjob.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ecr-token-refresher
  namespace: kube-system
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/ECRReadOnlyRole"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ecr-token-refresher
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["get", "patch"]
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ecr-token-refresher
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ecr-token-refresher
subjects:
  - kind: ServiceAccount
    name: ecr-token-refresher
    namespace: kube-system
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ecr-token-refresh
  namespace: kube-system
spec:
  schedule: "0 */10 * * *"  # Every 10 hours (token lasts 12h)
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: ecr-token-refresher
          restartPolicy: OnFailure
          containers:
            - name: ecr-refresh
              image: amazon/aws-cli:2.15.0
              command:
                - /bin/bash
                - -c
                - |
                  set -euo pipefail

                  AWS_REGION="${AWS_REGION:-us-east-1}"
                  SECRET_NAME="ecr-registry-credentials"
                  REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

                  echo "Fetching ECR authorization token..."
                  TOKEN=$(aws ecr get-login-password --region "${AWS_REGION}")

                  DOCKERCONFIG=$(cat <<DOCKEREOF
                  {
                    "auths": {
                      "${REGISTRY}": {
                        "auth": "$(echo -n "AWS:${TOKEN}" | base64 -w 0)"
                      }
                    }
                  }
                  DOCKEREOF
                  )

                  echo "Updating secrets in all namespaces..."
                  for NAMESPACE in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
                    if kubectl get secret "${SECRET_NAME}" -n "${NAMESPACE}" &>/dev/null; then
                      echo "Updating secret in namespace: ${NAMESPACE}"
                      kubectl patch secret "${SECRET_NAME}" -n "${NAMESPACE}" \
                        --type='json' \
                        -p="[{\"op\": \"replace\", \"path\": \"/data/.dockerconfigjson\", \"value\": \"$(echo -n "${DOCKERCONFIG}" | base64 -w 0)\"}]"
                    else
                      echo "Creating secret in namespace: ${NAMESPACE}"
                      kubectl create secret docker-registry "${SECRET_NAME}" \
                        --namespace="${NAMESPACE}" \
                        --docker-server="${REGISTRY}" \
                        --docker-username="AWS" \
                        --docker-password="${TOKEN}"
                    fi
                  done

                  echo "ECR token refresh complete"
              env:
                - name: AWS_REGION
                  value: "us-east-1"
                - name: AWS_ACCOUNT_ID
                  value: "123456789012"
```

### Operator-Based Token Refresh

For production environments, a dedicated operator is more robust than a CronJob:

```go
package controller

import (
    "context"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "time"

    "github.com/aws/aws-sdk-go-v2/service/ecr"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

const (
    ecrSecretAnnotation = "registry.example.com/ecr-auto-refresh"
    refreshInterval     = 10 * time.Hour
)

type ECRTokenReconciler struct {
    client    client.Client
    ecrClient *ecr.Client
}

func (r *ECRTokenReconciler) Reconcile(ctx context.Context, namespace string) error {
    // Get ECR token
    token, expiry, err := r.getECRToken(ctx)
    if err != nil {
        return fmt.Errorf("failed to get ECR token: %w", err)
    }

    // Build dockerconfig JSON
    registry := fmt.Sprintf("%s.dkr.ecr.%s.amazonaws.com",
        r.accountID, r.region)
    auth := base64.StdEncoding.EncodeToString(
        []byte(fmt.Sprintf("AWS:%s", token)))

    dockerConfig := map[string]interface{}{
        "auths": map[string]interface{}{
            registry: map[string]string{
                "auth": auth,
            },
        },
    }

    configBytes, err := json.Marshal(dockerConfig)
    if err != nil {
        return fmt.Errorf("failed to marshal docker config: %w", err)
    }

    // Create or update the secret
    secret := &corev1.Secret{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "ecr-credentials",
            Namespace: namespace,
            Annotations: map[string]string{
                ecrSecretAnnotation:      "true",
                "registry.example.com/token-expiry": expiry.Format(time.RFC3339),
            },
        },
        Type: corev1.SecretTypeDockerConfigJson,
        Data: map[string][]byte{
            corev1.DockerConfigJsonKey: configBytes,
        },
    }

    existing := &corev1.Secret{}
    err = r.client.Get(ctx, client.ObjectKeyFromObject(secret), existing)
    if err != nil {
        // Create
        return r.client.Create(ctx, secret)
    }

    // Update
    existing.Data = secret.Data
    existing.Annotations = secret.Annotations
    return r.client.Update(ctx, existing)
}
```

## Section 5: GCR and Artifact Registry Authentication

### Workload Identity for GKE

For GKE clusters, Workload Identity is the recommended approach — no secret management required.

```bash
# Enable Workload Identity on the cluster
gcloud container clusters update my-cluster \
  --workload-pool=my-project.svc.id.goog

# Create a GCP service account for image pulls
gcloud iam service-accounts create gcr-reader \
  --display-name="GCR Image Reader"

# Grant it read access to Artifact Registry
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:gcr-reader@my-project.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"

# Bind to Kubernetes service account
gcloud iam service-accounts add-iam-policy-binding \
  gcr-reader@my-project.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:my-project.svc.id.goog[my-namespace/my-ksa]"
```

```yaml
# Kubernetes Service Account with Workload Identity annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-ksa
  namespace: my-namespace
  annotations:
    iam.gke.io/gcp-service-account: gcr-reader@my-project.iam.gserviceaccount.com
```

With Workload Identity, kubelet automatically obtains GCR/Artifact Registry credentials via the metadata server — no `imagePullSecrets` needed.

### GCR Token Refresh for Non-GKE Clusters

```bash
#!/bin/bash
# gcr-token-refresh.sh

PROJECT_ID="my-project"
SECRET_NAME="gcr-credentials"

# Get access token from service account key or metadata server
TOKEN=$(gcloud auth print-access-token)

DOCKERCONFIG=$(cat <<EOF
{
  "auths": {
    "gcr.io": {
      "auth": "$(echo -n "_token:${TOKEN}" | base64 -w 0)"
    },
    "us.gcr.io": {
      "auth": "$(echo -n "_token:${TOKEN}" | base64 -w 0)"
    },
    "us-central1-docker.pkg.dev": {
      "auth": "$(echo -n "_token:${TOKEN}" | base64 -w 0)"
    }
  }
}
EOF
)

for NAMESPACE in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  kubectl create secret docker-registry "${SECRET_NAME}" \
    --namespace="${NAMESPACE}" \
    --docker-server="gcr.io" \
    --docker-username="_token" \
    --docker-password="${TOKEN}" \
    --dry-run=client -o yaml | kubectl apply -f -
done
```

## Section 6: Private Registry Proxy

A registry proxy (or mirror/cache) sits between your Kubernetes cluster and the upstream registry. Benefits:
- Reduces egress costs from cloud to external registries
- Improves pull latency (LAN speed vs internet speed)
- Provides resilience against upstream registry outages
- Centralized audit log of all image pulls
- Ability to scan images before they reach workloads

### Harbor as Registry Proxy

```yaml
# harbor-proxy-cache-project.yaml
# Configure Harbor to proxy Docker Hub
apiVersion: v1
kind: ConfigMap
metadata:
  name: harbor-proxy-config
  namespace: harbor
data:
  setup.sh: |
    #!/bin/bash
    # Create proxy cache project for Docker Hub
    curl -X POST -u "admin:${HARBOR_ADMIN_PASSWORD}" \
      -H "Content-Type: application/json" \
      -d '{
        "project_name": "dockerhub-proxy",
        "registry_id": 1,
        "public": false,
        "metadata": {
          "proxy_speed_kb": "-1"
        }
      }' \
      "https://harbor.example.com/api/v2.0/projects"
```

### Configuring Kubernetes Nodes to Use Registry Mirror

```bash
# For containerd-based nodes
cat > /etc/containerd/certs.d/docker.io/hosts.toml <<EOF
server = "https://registry-1.docker.io"

[host."https://harbor.example.com/v2/dockerhub-proxy"]
  capabilities = ["pull", "resolve"]
  ca = ["/etc/certs/harbor-ca.crt"]
EOF

# For all registries, point to Harbor
cat > /etc/containerd/certs.d/_default/hosts.toml <<EOF
[host."https://harbor.example.com"]
  capabilities = ["pull", "resolve", "push"]
  ca = ["/etc/certs/harbor-ca.crt"]
  skip_verify = false
EOF

systemctl restart containerd
```

### Kubernetes Node Bootstrapping DaemonSet for Registry Config

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: registry-mirror-config
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: registry-mirror-config
  template:
    metadata:
      labels:
        name: registry-mirror-config
    spec:
      hostPID: true
      tolerations:
        - operator: Exists
      initContainers:
        - name: configure-registry
          image: busybox
          command:
            - sh
            - -c
            - |
              mkdir -p /host/etc/containerd/certs.d/docker.io
              cat > /host/etc/containerd/certs.d/docker.io/hosts.toml <<TOML
              server = "https://registry-1.docker.io"
              [host."https://harbor.example.com/v2/dockerhub-proxy"]
                capabilities = ["pull", "resolve"]
              TOML
              # Signal containerd to reload
              nsenter -t 1 -m -u -i -n -p -- kill -HUP $(pgrep containerd)
          volumeMounts:
            - name: host-etc
              mountPath: /host/etc
          securityContext:
            privileged: true
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.9
      volumes:
        - name: host-etc
          hostPath:
            path: /etc
```

## Section 7: Debugging Image Pull Failures

### Common Failure Modes

```bash
# 1. Check the pod events for image pull errors
kubectl describe pod <pod-name> | grep -A5 "Events:"
# Common errors:
# "Failed to pull image: unauthorized: authentication required"
# "Failed to pull image: 403 Forbidden"
# "Failed to pull image: context deadline exceeded" (network issue)
# "ImagePullBackOff" (repeated failures)

# 2. Verify the secret exists and is correctly formatted
kubectl get secret regcred -o jsonpath='{.data.\.dockerconfigjson}' | \
  base64 --decode | jq .

# 3. Test credentials manually from a node
# Get the node where the pod is scheduled
NODE=$(kubectl get pod <pod-name> -o jsonpath='{.spec.nodeName}')
kubectl debug node/${NODE} -it --image=alpine -- sh
# Inside the debug container:
crictl pull \
  --auth "$(kubectl get secret regcred -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq -r '.auths."registry.example.com".auth')" \
  registry.example.com/myorg/myapp:latest

# 4. Check kubelet logs for credential provider errors
journalctl -u kubelet -f | grep -i "credential\|auth\|pull"

# 5. Verify the secret is attached to the service account
kubectl get serviceaccount <sa-name> -o yaml | grep -A5 imagePullSecrets
```

### Debugging ECR Authentication

```bash
# Test ECR authentication from a node
aws ecr get-login-password --region us-east-1 | \
  docker login \
  --username AWS \
  --password-stdin \
  123456789012.dkr.ecr.us-east-1.amazonaws.com

# Check token expiry
aws ecr describe-repositories --region us-east-1 \
  --query 'repositories[0].repositoryUri'

# Verify IAM role can access ECR
aws sts get-caller-identity
aws ecr describe-repositories --region us-east-1

# Check the credential provider binary is present and executable
ls -la /usr/local/bin/ecr-credential-provider
/usr/local/bin/ecr-credential-provider --help

# Test the credential provider manually
echo '{"kind":"CredentialProviderRequest","apiVersion":"credentialprovider.kubelet.k8s.io/v1","image":"123456789012.dkr.ecr.us-east-1.amazonaws.com/myrepo:latest"}' | \
  /usr/local/bin/ecr-credential-provider get-credentials
```

## Section 8: Multi-Registry Secret Management with External Secrets Operator

For organizations managing credentials at scale, the External Secrets Operator (ESO) synchronizes registry credentials from secret stores (Vault, AWS Secrets Manager, GCP Secret Manager) into Kubernetes secrets automatically.

```yaml
# ExternalSecret for ECR credentials from AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ecr-credentials
  namespace: my-app
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: ecr-pull-secret
    creationPolicy: Owner
    template:
      type: kubernetes.io/dockerconfigjson
      data:
        .dockerconfigjson: |
          {{- $creds := .ecrCreds | fromJSON -}}
          {
            "auths": {
              "{{ $creds.registry }}": {
                "auth": "{{ printf "AWS:%s" $creds.token | b64enc }}"
              }
            }
          }
  data:
    - secretKey: ecrCreds
      remoteRef:
        key: /prod/ecr/credentials
        version: AWSCURRENT
```

## Section 9: Image Pull Policy and Pull Secrets Interaction

Understanding how `imagePullPolicy` interacts with pull secrets prevents subtle failures:

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      image: registry.example.com/myapp:v1.0.0
      imagePullPolicy: IfNotPresent  # Only pulls if image not cached on node
      # WARNING: If imagePullPolicy=IfNotPresent and image is already cached,
      # imagePullSecrets are NOT used — the cached image is used regardless
      # of whether the node's cached copy came from an authorized pull

    - name: app-always
      image: registry.example.com/myapp:latest
      imagePullPolicy: Always  # Always authenticates and pulls
      # Use with pull secrets when you need to ensure fresh image
      # and validate authorization on every pod start
```

### Security Implication

If a node has an image cached without authentication (e.g., pulled during an interval when credentials were invalid), using `IfNotPresent` will allow that pod to start using the cached image without re-authenticating. For sensitive workloads:

```yaml
# Force authentication on every pull for security-sensitive workloads
imagePullPolicy: Always
```

## Section 10: Admission Controller for Pull Secret Enforcement

Enforce that all pods in certain namespaces have pull secrets:

```yaml
# OPA Gatekeeper constraint for required pull secrets
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredImagePullSecrets
metadata:
  name: require-pull-secrets
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaces:
      - "production"
      - "staging"
  parameters:
    requiredSecrets:
      - "ecr-pull-secret"
    exemptImages:
      - "gcr.io/google_containers/*"
      - "k8s.gcr.io/*"
      - "registry.k8s.io/*"
---
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredimagepullsecrets
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredImagePullSecrets
      validation:
        openAPIV3Schema:
          type: object
          properties:
            requiredSecrets:
              type: array
              items:
                type: string
            exemptImages:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredimagepullsecrets

        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          container := input.review.object.spec.containers[_]
          not is_exempt(container.image)
          not has_required_secret(input.review.object.spec)
          msg := sprintf("Pod must have imagePullSecrets: %v", [input.parameters.requiredSecrets])
        }

        is_exempt(image) {
          exempt := input.parameters.exemptImages[_]
          glob.match(exempt, [], image)
        }

        has_required_secret(spec) {
          required := input.parameters.requiredSecrets[_]
          secret := spec.imagePullSecrets[_]
          secret.name == required
        }
```

## Summary

Kubernetes registry authentication spans from simple static credentials to sophisticated automated token refresh systems. Key architectural decisions:

- Use kubelet credential providers for cloud registries (ECR, GCR) on managed Kubernetes offerings — they handle token refresh transparently and are the most operationally clean approach
- Use service account `imagePullSecrets` rather than per-pod references to reduce configuration duplication
- For ECR on self-managed clusters, use the CronJob or operator pattern for token refresh — 12-hour ECR tokens are the most common source of "random" image pull failures in production
- Deploy a registry proxy/mirror to reduce egress costs and improve resilience — Harbor and Nexus are the most commonly used solutions
- Use External Secrets Operator for centralized credential management when multiple secret stores are involved
- Enforce pull secret requirements via admission controllers to prevent security policy drift
