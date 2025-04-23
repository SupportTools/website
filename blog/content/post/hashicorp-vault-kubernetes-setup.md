---
title: "Secure Secret Management: Setting Up HashiCorp Vault on Kubernetes"
date: 2025-06-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HashiCorp Vault", "Secrets Management", "External Secrets", "Helm", "Traefik", "Ingress"]
categories:
  - Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to securely manage secrets in Kubernetes using HashiCorp Vault, Helm, and External Secrets with this step-by-step guide."
more_link: "yes"
url: "/hashicorp-vault-kubernetes-setup/"
---

Discover how to set up HashiCorp Vault on Kubernetes, integrating it with External Secrets to manage your application secrets securely.

<!--more-->

# Secure Secret Management: Setting Up HashiCorp Vault on Kubernetes

## Section 1: Introduction to HashiCorp Vault on Kubernetes

HashiCorp Vault is a powerful tool for securely managing secrets and sensitive data. This guide walks you through setting up Vault on Kubernetes and integrating it with External Secrets to streamline secret management for your applications.

## Section 2: Prerequisites

Before you begin, ensure you have the following:

*   **A Running Kubernetes Cluster:** You'll need access to a Kubernetes cluster.
*   **kubectl Installed and Configured:** Make sure `kubectl` is installed and configured to interact with your cluster.
*   **Helm Installed:** Helm is required for deploying Vault and External Secrets. You can find installation instructions on the Helm website ([https://helm.sh/docs/intro/install/](https://helm.sh/docs/intro/install/)).

## Section 3: Adding the HashiCorp Helm Repository

HashiCorp provides a Helm chart for installing Vault. Add their repository to Helm:

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update
```

This command adds the HashiCorp Helm repository and updates your local Helm chart index.

## Section 4: Installing Vault Using Helm

Deploy Vault into your Kubernetes cluster using Helm:

```bash
helm install vault hashicorp/vault -n vault --create-namespace
```

Where:

*   `vault`:  The name of the Helm release.
*   `hashicorp/vault`: Specifies the Vault Helm chart from the HashiCorp repository.
*   `-n vault`: Deploys Vault in the `vault` namespace.
*   `--create-namespace`: Creates the `vault` namespace if it doesn't exist.

Once deployed, Vault needs to be initialized and unsealed before it can be used.

## Section 5: Initializing Vault

Vault must be initialized before it can store and manage secrets. Run the following command to initialize Vault:

```bash
kubectl -n vault exec -it vault-0 -- vault operator init
```

This command generates unseal keys and an initial root token. *Important:* Securely store these tokens, as they are crucial for accessing Vault.

You'll see output similar to:

```text
Unseal Key 1: <key1>
Unseal Key 2: <key2>
Unseal Key 3: <key3>
Initial Root Token: <root-token>
```

## Section 6: Unsealing Vault

Vault operates in a "sealed" state by default. To make it operational, you need to "unseal" it using the unseal keys generated earlier. Enter the Vault pod and unseal it:

```bash
kubectl -n vault exec -it vault-0 -- sh
```

Then, run the following commands to unseal Vault:

```bash
vault operator unseal
<insert key1>
vault operator unseal
<insert key2>
vault operator unseal
<insert key3>
```

Paste each unseal key when prompted. Once all keys are entered, Vault will be unsealed and operational.

## Section 7: Logging In to Vault

Log in to Vault using the initial root token:

```bash
vault login <INITIAL_ROOT_TOKEN>
```

Replace `<INITIAL_ROOT_TOKEN>` with the token you saved earlier.

## Section 8: Enabling a Secret Engine

Vault organizes secrets using secret engines. Enable the KV (Key-Value) secret engine:

```bash
vault secrets enable --version=2 --path=kv kv
```

Where:

*   `--version=2`: Specifies version 2 of the KV engine.
*   `--path=kv`:  Sets the mount path for the engine to `kv`.

## Section 9: Adding Secrets to Vault

Add secrets to Vault using the KV engine. For example:

```bash
vault kv put -mount=kv medium-blog adminUser=test
vault kv put -mount=kv medium-blog adminPass='password'
```

Where:

*   `-mount=kv`: Refers to the KV engine enabled earlier.
*   `medium-blog`: The path under which the secrets are stored.
*   `adminUser` and `adminPass`: Key-value pairs representing your secrets.

Repeat this process for all the secrets your application needs.

## Section 10: Installing External Secrets Operator

External Secrets Operator bridges the gap between Kubernetes and external secret management systems, such as HashiCorp Vault. It syncs secrets from external systems into Kubernetes-native secrets.

Install External Secrets Operator in the `external-secrets` namespace:

```bash
helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace
```

## Section 11: Creating a Vault Token Secret in Kubernetes

External Secrets Operator needs a Vault token to authenticate with Vault. Create a Kubernetes secret with the token:

```yaml
apiVersion: v1
data:
  token: <your-token-base64>
kind: Secret
metadata:
  name: vault-token
  namespace: external-secrets
type: Opaque
```

Replace `<your-token-base64>` with the Base64-encoded token (use `echo -n "token" | base64` to generate it).

Save this file as `vaultTokenSecret.yaml` and apply it:

```bash
kubectl -n external-secrets apply -f vaultTokenSecret.yaml
```

## Section 12: Configuring External Secrets Operator to Access Vault

Create a `ClusterSecretStore` resource to configure External Secrets Operator to communicate with Vault:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend-access
spec:
  provider:
    vault:
      server: "https://vault.support.tools/"
      path: "kv"
      version: "v2"
      auth:
        tokenSecretRef:
          name: "vault-token"
          key: "token"
          namespace: external-secrets
```

Where:

*   `server`: The Vault server URL.
*   `path`: The KV engine path (`kv` in this setup).
*   `auth.tokenSecretRef`: Points to the secret containing the Vault token.

Save this as `clusterSecretStore.yaml` and apply it:

```bash
kubectl apply -f clusterSecretStore.yaml
```

## Section 13: Verifying and Using Secrets

Create `ExternalSecret` resources to sync Vault secrets into Kubernetes secrets. For example:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: medium-blog-secrets
  namespace: medium-blog-ns
spec:
  secretStoreRef:
    name: vault-backend-access
    kind: ClusterSecretStore
  target:
    name: medium-blog-k8s-secret
  data:
  - secretKey: ADMIN_USER
    remoteRef:
      key: kv/medium-blog
      property: adminUser
  - secretKey: ADMIN_PASS
    remoteRef:
      key: kv/medium-blog
      property: adminPass
```

Apply this file, and External Secrets Operator will create an `ExternalSecret` resource named `medium-blog-secrets` and a Kubernetes secret named `medium-blog-k8s-secret` in the `medium-blog-ns` namespace with the values pulled from Vault.

Verify the resources:

```bash
kubectl get externalsecret -n medium-blog-ns -o yaml
kubectl get secret -n medium-blog-ns -o yaml
```

## Section 14: Bonus: Exposing Vault with Ingress Using Traefik

To make Vault accessible externally, expose it using an Ingress. This ensures that Vault is accessible through a domain name (e.g., `vault.support.tools`).

### Step 1: Ensure Traefik is Deployed

Traefik is a popular Kubernetes Ingress Controller. If you don't have Traefik installed, follow these steps:

1.  **Add the Traefik Helm Repository:**

    ```bash
    helm repo add traefik https://traefik.github.io/charts
    helm repo update
    ```

2.  **Install Traefik:**

    ```bash
    helm install traefik traefik/traefik --namespace traefik --create-namespace
    ```

3.  **Verify Installation:**

    ```bash
    kubectl get pods -n traefik
    ```

    You should see pods like `traefik-<unique-id>` running successfully.

### Step 2: Expose Vault Using IngressRoute

Create an IngressRoute resource to expose Vault using Traefik. Save the following configuration as `vaultIngressRoute.yaml`:

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: vault-ingressroute
  namespace: vault
spec:
  entryPoints:
    - web
  routes:
  - match: Host(`vault.support.tools`)
    kind: Rule
    services:
    - name: vault
      port: 8200
      scheme: http
```

Where:

*   `entryPoints`: `web` indicates the HTTP entry point.  Modify to `websecure` for HTTPS.
*   `Host(`vault.support.tools`)`:  The domain that maps to the Vault service.  Ensure this domain points to your Kubernetes cluster via DNS.
*   `services`:
    *   `name`: `vault` refers to the Vault service created by the Helm chart.
    *   `port`: `8200` is the default Vault port.

### Step 3: Apply the IngressRoute

```bash
kubectl apply -f vaultIngressRoute.yaml
```

### Step 4: Update DNS or Hosts File

Point your domain (`vault.support.tools`) to the external IP of the Traefik LoadBalancer. If testing locally, edit your `/etc/hosts` file:

```text
<NODE-IP> vault.support.tools
```

### Step 5: Access Vault

You should now be able to access Vault in your browser using `http://vault.support.tools`.

### Step 6: Secure with HTTPS (Optional)

For production environments, secure the Ingress with TLS.

1.  Configure a certificate (e.g., via Let's Encrypt or a self-signed certificate).
2.  Update the Traefik entry point to `websecure`.
3.  Modify the IngressRoute to include a `tls` section:

```yaml
spec:
  entryPoints:
    - websecure
  tls:
    secretName: mysecret-cert
  routes:
  - match: Host(`vault.support.tools`)
    kind: Rule
    services:
    - name: vault
      port: 8200
      scheme: http
```

This ensures secure communication with Vault over HTTPS.

## Section 15: Wrapping Up

Congratulations! You have successfully set up HashiCorp Vault on Kubernetes, stored secrets, and integrated it with External Secrets for secure secret management in Kubernetes. This setup provides a robust foundation for securely managing application secrets.
