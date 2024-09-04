---
title: "Change Default Ingress Port to HTTP for Bitnami/nginx in Kubernetes"  
date: 2024-10-11T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "NGINX", "Bitnami", "Ingress", "HTTP"]  
categories:  
- Kubernetes  
- Networking  
- Ingress  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to change the default Ingress port to HTTP in Bitnami/nginx when using Kubernetes, optimizing your configuration for easier management of services."  
more_link: "yes"  
url: "/change-default-ingress-port-http-bitnami-nginx-kubernetes/"  
---

When setting up **Bitnami/nginx** as your Ingress controller in a Kubernetes environment, the default configuration may use HTTPS (port 443). However, there are cases where you might want to change the default Ingress port to **HTTP (port 80)**, especially if you're dealing with non-HTTPS traffic or need to expose services through standard HTTP.

In this post, we will walk through how to modify the default Ingress port for Bitnami/nginx in Kubernetes to use **HTTP (port 80)** instead of HTTPS, allowing you to handle non-encrypted traffic effectively.

<!--more-->

### Why Change the Default Ingress Port to HTTP?

By default, the Bitnami/nginx Helm chart for Kubernetes may be set up to handle secure traffic via HTTPS on port 443. While HTTPS is essential for production environments where security is a priority, there are several reasons why you might want to configure your Ingress controller to use **HTTP (port 80)** instead:
- **Local Development**: For development and testing environments where encryption isn't necessary.
- **Non-HTTPS Services**: Some legacy services or APIs may not require HTTPS traffic.
- **Custom Routing**: You may want to expose services over HTTP for specific internal use cases or to offload SSL termination elsewhere.

### Step 1: Install Bitnami/nginx Ingress Controller

First, install the **Bitnami/nginx** Ingress controller using Helm, which is a common way to manage Kubernetes packages.

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm install my-nginx-ingress bitnami/nginx-ingress-controller -n ingress-controller --create-namespace
```

This command installs the **nginx-ingress-controller** from the Bitnami Helm repository into the `ingress-controller` namespace.

### Step 2: Modify Values to Use HTTP (Port 80)

By default, the controller handles HTTPS traffic, but we can modify the `values.yaml` file or pass values via the Helm command line to change the port to HTTP.

#### Option 1: Update `values.yaml`

Create or edit the `values.yaml` file to configure the Ingress controller to listen on port **80** by specifying the `controller.service` configuration:

```yaml
controller:
  service:
    ports:
      http: 80
      https: 443
    type: LoadBalancer
```

In this configuration:
- **http: 80**: This line tells the Ingress controller to listen on port **80** for HTTP traffic.
- **https: 443**: You can keep HTTPS configured if you want dual support or remove it entirely for an HTTP-only setup.

Once you’ve modified the `values.yaml` file, apply the changes with Helm:

```bash
helm upgrade my-nginx-ingress bitnami/nginx-ingress-controller -n ingress-controller -f values.yaml
```

#### Option 2: Pass Values Inline via Helm

Alternatively, you can pass the HTTP port directly as a Helm value without modifying the `values.yaml` file:

```bash
helm upgrade my-nginx-ingress bitnami/nginx-ingress-controller -n ingress-controller --set controller.service.ports.http=80 --set controller.service.type=LoadBalancer
```

This command tells the Helm chart to configure the Ingress controller to listen on port **80** for HTTP traffic.

### Step 3: Update Ingress Resources to Use HTTP

Once the Ingress controller is listening on port **80**, you can update your **Ingress resources** to serve traffic over HTTP. A typical Ingress resource might look like this:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: my-app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-app
            port:
              number: 80
```

This Ingress rule configures traffic to be routed to the **my-app** service on port **80**. The `nginx.ingress.kubernetes.io/rewrite-target` annotation is used to handle URL path rewrites if needed.

### Step 4: Verify HTTP Traffic

After updating your configuration, ensure that HTTP traffic is flowing through the NGINX Ingress controller. You can use tools like **curl** to check if the application is accessible over HTTP:

```bash
curl http://my-app.example.com
```

If the Ingress and service are configured correctly, you should receive a response from your application on port **80**.

### Step 5: Optional—Disable HTTPS

If you only want to expose HTTP traffic and have no need for HTTPS, you can completely remove the HTTPS port configuration from the Ingress controller.

In `values.yaml`, simply remove the HTTPS configuration:

```yaml
controller:
  service:
    ports:
      http: 80
    type: LoadBalancer
```

You can apply the configuration using the same Helm command as before, and NGINX will no longer listen on port **443**.

### Conclusion

Configuring the **Bitnami/nginx** Ingress controller to use **HTTP (port 80)** in Kubernetes is a simple process that allows you to handle non-secured traffic for development, internal services, or custom routing purposes. By modifying the Helm values or `values.yaml` file, you can quickly adjust the NGINX Ingress controller to fit your specific use case.

For environments where HTTPS is not a priority, setting up NGINX to listen on port **80** streamlines access to services without the overhead of SSL configuration. However, it’s always best practice to secure production environments with SSL/TLS, even if SSL termination occurs outside of Kubernetes.

