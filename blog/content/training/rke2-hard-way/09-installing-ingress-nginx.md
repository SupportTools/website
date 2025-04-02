---
title: "RKE2 the Hard Way: Part 9 - Installing Ingress-Nginx"
description: "Installing and configuring Ingress-Nginx for external access to Kubernetes services."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 9
---

## Part 9 - Installing Ingress-Nginx

In this part of the "RKE2 the Hard Way" training series, we will install and configure Ingress-Nginx. Ingress-Nginx is a popular ingress controller for Kubernetes that uses Nginx as a reverse proxy and load balancer. It allows you to expose your services to the outside world by routing external HTTP/HTTPS traffic to services within your cluster.

We will deploy Ingress-Nginx to enable external access to our Kubernetes services.

### 1. Download Ingress-Nginx Manifest

Download the recommended manifest for Ingress-Nginx from the Kubernetes community repository. We will use the "裸金属" (Bare-metal) manifest.

```bash
INGRESS_NGINX_VERSION=v4.9.0
wget https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v${INGRESS_NGINX_VERSION}/deploy/static/provider/baremetal/deploy.yaml
mv deploy.yaml ingress-nginx-manifest.yaml
```

These commands will:

*   Download the Ingress-Nginx manifest file for bare-metal deployments from GitHub.
*   Rename the manifest file to `ingress-nginx-manifest.yaml` for clarity.

### 2. Modify Ingress-Nginx Manifest (Optional)

Review the downloaded `ingress-nginx-manifest.yaml` file. For basic setup, the default manifest should work without modifications.

However, you might want to adjust the following:

*   `namespace`: Ensure it is deployed in the `ingress-nginx` namespace (default).
*   `controller.serviceAccountName`: Using the `ingress-nginx-controller` service account (default).
*   `controller.image.image`: Verify the Ingress-Nginx controller image version if needed. The default image is `registry.k8s.io/ingress-nginx/controller:v4.9.0`.
*   `controller.args`: Review the arguments passed to the Ingress-Nginx controller container. The default configuration should be suitable for most setups.
*   `controller.hostNetwork`:  The default manifest uses `hostNetwork: true`. For this "hard way" guide, we will keep using host network for simplicity.

For this guide, we will use the default manifest without modifications.

### 3. Deploy Ingress-Nginx

Create the `ingress-nginx` namespace and then use `kubectl` to deploy Ingress-Nginx to the cluster using the downloaded manifest:

```bash
kubectl create namespace ingress-nginx
kubectl apply -f ingress-nginx-manifest.yaml
```

These commands will:

*   Create the `ingress-nginx` namespace.
*   Deploy the Ingress-Nginx controller and related resources (Deployments, Services, RBAC rules, etc.) in the `ingress-nginx` namespace.

### 4. Verify Ingress-Nginx Deployment

Verify that the Ingress-Nginx controller pods are running correctly in the `ingress-nginx` namespace:

```bash
kubectl get pods -n ingress-nginx -l app.kubernetes.io/component=controller
```

You should see output similar to this, with one Ingress-Nginx controller pod running:

```
NAME                                        READY   STATUS    RESTARTS   AGE
ingress-nginx-controller-xxxxxxxxxx-xxxxx   1/1     Running   0          5m
```

Also, verify the Ingress-Nginx service:

```bash
kubectl get service -n ingress-nginx ingress-nginx-controller
```

Output should be similar to:

```
NAME                       TYPE           CLUSTER-IP      EXTERNAL-IP   PORT(S)                      AGE
ingress-nginx-controller   LoadBalancer   10.96.xxx.xxx   <pending>     80:32493/TCP,443:31271/TCP   5m
```

The `TYPE` is `LoadBalancer` but in our bare-metal setup, it will remain in `<pending>` state as we don't have an external load balancer configured.  Ingress-Nginx will be accessible on the node's IP addresses on ports 80 and 443 (due to `hostNetwork: true`).

### 5. Test Ingress-Nginx (After Cluster is More Complete)

Full Ingress-Nginx testing will be more relevant once we have deployed a sample application and configured an Ingress resource. We will revisit Ingress-Nginx testing in the next part of this series when we verify the cluster and deploy a test application.

**Next Steps:**

In the final part, we will perform cluster verification and deploy a sample application to test external access via Ingress-Nginx.
