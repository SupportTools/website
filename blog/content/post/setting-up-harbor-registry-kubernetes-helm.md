---
title: "Setting Up Harbor Registry on Kubernetes Using Helm Chart"
date: 2025-02-19T18:30:00-05:00
draft: true
tags: ["Harbor", "Kubernetes", "Registry", "Helm", "Containers"]
categories:
- Harbor
- Kubernetes
- Helm
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to deploy Harbor Registry on Kubernetes using Helm charts for a secure and efficient container image management."
more_link: "yes"
url: "/setting-up-harbor-registry-kubernetes-helm/"
---

Are you looking to set up a secure and efficient container image registry on your Kubernetes cluster? **Harbor** is an open-source container image registry that enhances security and performance with features like role-based access control, vulnerability scanning, and image signing. In this guide, we'll walk you through the steps to deploy Harbor on Kubernetes using Helm charts.

<!--more-->

# [Setting Up Harbor Registry on Kubernetes Using Helm Chart](#setting-up-harbor-registry-on-kubernetes-using-helm-chart)

## Section 1: Prerequisites  

Before we begin, ensure you have the following:

- **Kubernetes Cluster**: A running Kubernetes cluster (version 1.12 or higher).
- **Helm**: Helm 3 installed on your local machine.
- **kubectl**: Installed and configured to interact with your Kubernetes cluster.
- **Domain Name**: A domain name pointing to your Kubernetes cluster's load balancer IP.

## Section 2: Adding the Harbor Helm Repository  

First, add the official Harbor Helm repository to your Helm client and update it.

```bash
helm repo add harbor https://helm.goharbor.io
helm repo update
```

## Section 3: Creating a Namespace for Harbor  

Create a dedicated namespace for Harbor to keep the deployment organized.

```bash
kubectl create namespace harbor
```

## Section 4: Installing Harbor with Default Configuration  

You can deploy Harbor with the default settings using the following command:

```bash
helm install harbor harbor/harbor --namespace harbor
```

However, for production environments, it's recommended to customize the configuration to meet your specific needs.

## Section 5: Customizing Harbor Configuration  

### Step 5.1: Preparing SSL Certificates  

For secure communication, Harbor requires TLS certificates. You can obtain free SSL certificates from Let's Encrypt or use your own certificates.

- **Generate SSL Certificates** using Let's Encrypt or your preferred Certificate Authority.
- **Rename the certificate files** to `tls.crt` and `tls.key`.

Create a Kubernetes secret to store your TLS certificates:

```bash
kubectl create secret tls harbor-tls --cert=tls.crt --key=tls.key -n harbor
```

### Step 5.2: Creating a Custom Values File  

Create a `values.yaml` file to override the default configuration. Here's a basic example:

```yaml
expose:
  type: ingress
  tls:
    enabled: true
    certSource: secret
    secret:
      secretName: "harbor-tls"
      notarySecretName: "harbor-tls"
  ingress:
    hosts:
      core: harbor.yourdomain.com
      notary: notary.harbor.yourdomain.com

externalURL: https://harbor.yourdomain.com

harborAdminPassword: "YourStrongPassword"
```

- **expose.type**: We're using `ingress` to expose Harbor services.
- **tls.enabled**: Enable TLS for secure communication.
- **certSource**: Specify that we're using a secret for TLS certificates.
- **hosts**: Replace `harbor.yourdomain.com` with your actual domain name.
- **harborAdminPassword**: Set a strong initial password for the admin user.

### Step 5.3: Ensure Ingress Controller is Installed  

Make sure you have an ingress controller installed in your cluster, such as NGINX Ingress Controller.

## Section 6: Deploying Harbor with Custom Configuration  

Install Harbor using your custom `values.yaml` file:

```bash
helm install harbor harbor/harbor --namespace harbor -f values.yaml
```

## Section 7: Verifying the Installation  

Check the status of your Harbor deployment:

```bash
helm status harbor -n harbor
```

List the pods to ensure all components are running:

```bash
kubectl get pods -n harbor
```

You should see pods for core Harbor components like `harbor-core`, `harbor-database`, `harbor-portal`, etc.

## Section 8: Accessing Harbor  

After successful deployment, you can access the Harbor UI:

- Open a web browser and navigate to `https://harbor.yourdomain.com`.
- Log in using the username `admin` and the password you set in `values.yaml`.

## Section 9: Pushing and Pulling Images  

To push and pull images securely, configure your Docker client to trust the Harbor registry:

1. **Login to Harbor Registry**:

   ```bash
   docker login harbor.yourdomain.com
   ```

2. **Tag and Push an Image**:

   ```bash
   docker tag your-image:latest harbor.yourdomain.com/library/your-image:latest
   docker push harbor.yourdomain.com/library/your-image:latest
   ```

## Section 10: Additional Configuration for Production  

For a production-grade setup, consider the following:

- **External Database**: Configure Harbor to use an external database for scalability.
- **External Redis**: Use an external Redis instance for session management and caching.
- **Persistent Storage**: Ensure you have persistent volumes for data storage.
- **High Availability**: Deploy Harbor in a high-availability configuration.

## Conclusion  

Deploying Harbor on Kubernetes using Helm charts simplifies the process of setting up a secure and robust container registry. By customizing the configuration, you can tailor Harbor to fit your organization's needs, ensuring secure storage and management of your container images.
