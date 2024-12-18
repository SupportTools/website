---
title: "Ingress NGINX Controller on EKS"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Load Balancers", "Ingress NGINX", "EKS", "Amazon"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Known good design for deploying Ingress NGINX Controller on Amazon EKS."
more_link: "yes"
url: "/known-good-designs/loadbalancers/ingress-nginx-controller-on-eks/"
---

![NGINX Architecture for EKS](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-eks/arch_nginx-for_eks.png)

This is the known good design for deploying the Ingress NGINX Controller on Amazon EKS.

<!--more-->

# [Overview](#overview)

## [Ingress NGINX Overview](#ingress-nginx-overview)
The Ingress NGINX Controller is a Kubernetes-native load balancer that manages external access to services in a cluster. On EKS, it works seamlessly with Amazon Elastic Load Balancers (ELBs) to provide robust HTTP(S) ingress capabilities.

### Key Features
- **Supports HTTP and HTTPS:** Handles secure and non-secure traffic.
- **Rule-Based Routing:** Route traffic based on host, path, or headers.
- **Custom Annotations:** Allows fine-grained control over NGINX configurations.
- **Integration with ACM:** Automates TLS certificate provisioning via AWS Certificate Manager.

For more details, refer to the [AWS Documentation](https://docs.aws.amazon.com/eks/latest/userguide/).

---

![Design of NGINX Ingress Controller on EKS](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-eks/design-of-NGINX-Ingress-Controller-on-EKS.png)

---

## [AWS Load Balancer Behavior](#aws-load-balancer-behavior)

### How AWS Deploys a Load Balancer

When a service is configured with `type: LoadBalancer` in an EKS cluster, AWS automatically creates an Elastic Load Balancer (ELB) outside the cluster. This load balancer forwards external traffic to the node ports associated with the service.

- The Load Balancer maps to the cluster nodes and routes traffic to the relevant pods via node ports.
- By default, an Application Load Balancer (ALB) is used for HTTP/HTTPS traffic, while a Network Load Balancer (NLB) is preferred for TCP traffic.

Example:
- Service with ports 80 and 443.
- ELB forwards traffic to random node ports, such as `31567` (HTTP) and `31568` (HTTPS), on each node.

For more information, see the [AWS Load Balancers Documentation](https://docs.aws.amazon.com/eks/latest/userguide/load-balancing.html).

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

AWS Load Balancers can be customized using annotations on the Kubernetes service resource. The following example demonstrates commonly used annotations:

### Example Service with Annotations
```yaml
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "http"
    service.beta.kubernetes.io/aws-load-balancer-ssl-cert: "arn:aws:acm:region:account-id:certificate/certificate-id"
    service.beta.kubernetes.io/aws-load-balancer-ssl-ports: "443"
    service.beta.kubernetes.io/aws-load-balancer-access-log-enabled: "true"
    service.beta.kubernetes.io/aws-load-balancer-access-log-s3-bucket-name: "my-bucket"
    service.beta.kubernetes.io/aws-load-balancer-access-log-s3-bucket-prefix: "nginx-logs"
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

### Annotation Details
- `service.beta.kubernetes.io/aws-load-balancer-backend-protocol`: Specifies the protocol for the backend (`http` or `tcp`).
- `service.beta.kubernetes.io/aws-load-balancer-ssl-cert`: Associates an ACM certificate for HTTPS traffic.
- `service.beta.kubernetes.io/aws-load-balancer-ssl-ports`: Defines which ports should use SSL.
- `service.beta.kubernetes.io/aws-load-balancer-access-log-enabled`: Enables access logs for the load balancer.
- `service.beta.kubernetes.io/aws-load-balancer-access-log-s3-bucket-name`: Specifies the S3 bucket for storing access logs.
- `service.beta.kubernetes.io/aws-load-balancer-access-log-s3-bucket-prefix`: Defines the log prefix within the S3 bucket.

For a complete list of available annotations, see the [AWS Load Balancers Documentation](https://docs.aws.amazon.com/eks/latest/userguide/load-balancing.html).

---

## [References](#references)
- [Ingress NGINX Documentation](https://kubernetes.github.io/ingress-nginx/)
- [AWS Load Balancers Documentation](https://docs.aws.amazon.com/eks/latest/userguide/load-balancing.html)
- [AWS Installation Guide for NGINX Ingress Controller](https://aws.amazon.com/blogs/containers/nginx-ingress-controller-on-amazon-eks/)
