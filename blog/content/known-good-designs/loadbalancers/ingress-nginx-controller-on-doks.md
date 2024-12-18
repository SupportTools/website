---
title: "Ingress NGINX Controller on DOKS"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Load Balancers", "Ingress NGINX", "DOKS", "DigitalOcean"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Known good design for deploying Ingress NGINX Controller on DigitalOcean Kubernetes (DOKS)."
more_link: "yes"
url: "/known-good-designs/loadbalancers/ingress-nginx-controller-on-doks/"
---

![NGINX Architecture for DOKS](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-doks/arch_nginx-for_doks.png)

This is the known good design for deploying the Ingress NGINX Controller on DigitalOcean Kubernetes (DOKS).

<!--more-->

# [Overview](#overview)

## [Ingress NGINX Overview](#ingress-nginx-overview)
The Ingress NGINX Controller is a Kubernetes-native load balancer that manages external access to services in a cluster. On DOKS, it works seamlessly with DigitalOcean Load Balancers to provide robust HTTP(S) ingress capabilities.

### Key Features
- **Supports HTTP and HTTPS:** Handles secure and non-secure traffic.
- **Rule-Based Routing:** Route traffic based on host, path, or headers.
- **Custom Annotations:** Allows fine-grained control over NGINX configurations.
- **Integration with Let's Encrypt:** Automates TLS certificate provisioning.

For more details, refer to the [DigitalOcean Documentation](https://docs.digitalocean.com/products/kubernetes/getting-started/operational-readiness/install-nginx-ingress-controller/).

---

![Design of NGINX Ingress Controller](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-doks/design-of-NGINX-Ingress-Controller.png)

---

## [DigitalOcean Load Balancer Behavior](#digitalocean-load-balancer-behavior)

### How DigitalOcean Deploys a TCP Load Balancer

When a service is configured with `type: LoadBalancer` in a DOKS cluster, DigitalOcean automatically creates a TCP Load Balancer outside the cluster. This load balancer forwards external traffic to the node ports associated with the service.

- The Load Balancer assigns a random node port to the service for each defined port.
- Traffic is evenly distributed to the available cluster nodes via the Load Balancer, which then forwards the traffic to the actual service pods within the cluster.

Example:
- Service with port 80 and 443.
- External Load Balancer forwards traffic to random node ports, such as `31567` (HTTP) and `31568` (HTTPS), across all cluster nodes.

You can view the Load Balancer in the DigitalOcean control panel or via the DigitalOcean API for additional details.

For more information, see the [DigitalOcean Load Balancers Documentation](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/).

---

## [Helm Deployment Example](#helm-deployment-example)

### Step 1: Install the Ingress NGINX Controller with Helm

1. **Add the Helm Repository:**
   ```bash
   helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
   helm repo update
   ```

2. **Install the Ingress NGINX Controller:**
   Use Helm to install the controller in the `ingress-nginx` namespace:
   ```bash
   helm install ingress-nginx ingress-nginx/ingress-nginx \
     --namespace ingress-nginx \
     --create-namespace \
     --set controller.service.type=LoadBalancer
   ```

3. **Verify the Installation:**
   Check the pods and services in the `ingress-nginx` namespace:
   ```bash
   kubectl get pods -n ingress-nginx
   kubectl get svc -n ingress-nginx
   ```

Expected output for the service:
```plaintext
NAME                                 TYPE           CLUSTER-IP      EXTERNAL-IP      PORT(S)                      AGE
ingress-nginx-controller             LoadBalancer   10.245.89.53    123.45.67.89     80:31567/TCP,443:31568/TCP    2m
```

---

## [ArgoCD Deployment Example](#argocd-deployment-example)

### Deploying the Ingress NGINX Controller with ArgoCD

The following is an example of deploying the Ingress NGINX Controller using ArgoCD:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ingress-nginx
  namespace: argocd
spec:
  destination:
    namespace: ingress-nginx
    server: https://kubernetes.default.svc
  project: cluster-services
  source:
    chart: ingress-nginx
    helm:
      values: |
        controller:
          service:
            type: LoadBalancer
          publishService:
            enabled: true
          metrics:
            enabled: true
            prometheus:
              enabled: true
          allowSnippetAnnotations: true
          config:
            ssl-ciphers: "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:AES128-SHA256"
            ssl-protocols: "TLSv1.2 TLSv1.3"          
            proxy-connect-timeout: '15'
            proxy-read-timeout: '600'
            proxy-send-timeout: '600'
            hsts-include-subdomains: 'false'
            body-size: 64m
            server-name-hash-bucket-size: '256'
            client-max-body-size: 50m
          replicaCount: 3
          podAnnotations:
            "prometheus.io/scrape": "true"
            "prometheus.io/port": "10254"
    repoURL: https://kubernetes.github.io/ingress-nginx
    targetRevision: 4.10.1
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    retry:
      backoff:
        duration: 30m
        factor: 2
        maxDuration: 5m
      limit: 3
    syncOptions:
      - CreateNamespace=true
```

### Key Features in the Configuration
- **Load Balancer:** Configures the service type as `LoadBalancer` for external access.
- **Prometheus Metrics:** Enables metrics collection for monitoring with Prometheus.
- **Timeouts and Limits:** Configures proxy and client body limits to handle large requests.
- **Replicas:** Deploys three replicas of the Ingress NGINX controller for high availability.
- **Automated Sync:** Ensures that the deployment self-heals and prunes unused resources automatically.
- **Namespace Creation:** Automatically creates the `ingress-nginx` namespace if it doesn't exist.

---

## [Using Annotations to Customize the Load Balancer](#using-annotations-to-customize-the-load-balancer)

DigitalOcean provides annotations to customize the behavior of its Load Balancers. These annotations can be applied to the Kubernetes service record to fine-tune the Load Balancer's functionality.

### Example Service with Annotations
```yaml
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
  annotations:
    service.beta.kubernetes.io/do-loadbalancer-enable-proxy-protocol: "true"
    service.beta.kubernetes.io/do-loadbalancer-protocol: "http"
    service.beta.kubernetes.io/do-loadbalancer-sticky-sessions-type: "cookies"
    service.beta.kubernetes.io/do-loadbalancer-sticky-sessions-cookie-name: "example"
    service.beta.kubernetes.io/do-loadbalancer-sticky-sessions-cookie-ttl: "60"
spec:
  type: LoadBalancer
  selector:
    app.kubernetes.io/name: ingress-nginx
  ports:
    - port: 80
      targetPort: http
    - port: 443
      targetPort: https
```

---

## [References](#references)
- [Ingress NGINX Documentation](https://kubernetes.github.io/ingress-nginx/)
- [DigitalOcean Load Balancers Documentation](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/)
- [DigitalOcean Installation Guide for NGINX Ingress Controller](https://docs.digitalocean.com/products/kubernetes/getting-started/operational-readiness/install-nginx-ingress-controller/)
- [DigitalOcean Cloud Controller Manager Examples](https://github.com/digitalocean/digitalocean-cloud-controller-manager/tree/master/docs/controllers/services/examples)
