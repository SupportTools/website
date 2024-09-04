---
title: "Change Default HTTP Port for Bitnami/nginx Web Server Using ConfigMap in Kubernetes"  
date: 2024-10-12T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "NGINX", "Bitnami", "ConfigMap", "HTTP"]  
categories:  
- Kubernetes  
- NGINX  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to change the default HTTP port for a Bitnami/nginx web server by configuring it through a ConfigMap in Kubernetes."  
more_link: "yes"  
url: "/change-nginx-port-configmap-kubernetes/"  
---

When running a **Bitnami/nginx web server** in Kubernetes, you might need to change the default HTTP port (which is typically port 80) to a different port for various reasons, such as security policies, port conflicts, or custom routing requirements. In this post, we’ll show you how to modify the default port of an NGINX web server using a **ConfigMap** in Kubernetes.

<!--more-->

### Why Use a ConfigMap?

In Kubernetes, a **ConfigMap** allows you to manage configuration data independently of containerized applications. By externalizing configurations like the port number in a ConfigMap, you make your deployment more flexible, scalable, and easier to maintain. This approach also allows you to change configurations without modifying the container image itself.

### Step 1: Deploy Bitnami/nginx Web Server

First, we will deploy the **Bitnami/nginx** web server as a **Pod** in Kubernetes. You can either use `kubectl` directly or deploy it using a YAML configuration file.

Here’s a basic deployment of NGINX in a Kubernetes Pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-web
  labels:
    app: nginx-web
spec:
  containers:
  - name: nginx
    image: bitnami/nginx:latest
    ports:
    - containerPort: 8080  # Default is 80, but we'll change this via ConfigMap
```

### Step 2: Create a ConfigMap to Change the Default Port

Next, create a **ConfigMap** to update the NGINX configuration. The key here is to update the **nginx.conf** file to listen on a different port.

Here’s an example ConfigMap that changes the default HTTP port to **8080**:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
data:
  nginx.conf: |
    server {
      listen 8080;
      server_name localhost;

      location / {
        root   /usr/share/nginx/html;
        index  index.html index.htm;
      }

      error_page 500 502 503 504 /50x.html;
      location = /50x.html {
        root   /usr/share/nginx/html;
      }
    }
```

In this **ConfigMap**, the `nginx.conf` file is configured to make NGINX listen on port **8080** instead of the default **80**.

### Step 3: Mount the ConfigMap in the Pod

Now that the ConfigMap is ready, you need to mount it as a volume in the **nginx-web** Pod so that it replaces the default **nginx.conf** configuration.

Here’s how to modify the Pod configuration to mount the ConfigMap:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-web
  labels:
    app: nginx-web
spec:
  containers:
  - name: nginx
    image: bitnami/nginx:latest
    ports:
    - containerPort: 8080
    volumeMounts:
    - name: config-volume
      mountPath: /opt/bitnami/nginx/conf/nginx.conf
      subPath: nginx.conf
  volumes:
  - name: config-volume
    configMap:
      name: nginx-config
```

In this setup:
- We define a volume mount for the ConfigMap that mounts the `nginx.conf` file at `/opt/bitnami/nginx/conf/nginx.conf`, which is the expected configuration path for Bitnami/nginx.
- The **subPath** ensures that only the `nginx.conf` file from the ConfigMap is mounted.

### Step 4: Apply the Changes

Once you’ve updated the configuration, apply the ConfigMap and Pod changes using `kubectl`:

```bash
kubectl apply -f nginx-config.yaml
kubectl apply -f nginx-pod.yaml
```

This will start the NGINX web server with the updated configuration, listening on port **8080** instead of the default **80**.

### Step 5: Verify the Changes

You can verify that the NGINX server is running on port **8080** by either using `kubectl port-forward` or exposing the Pod as a service.

Here’s how to forward the port for testing:

```bash
kubectl port-forward pod/nginx-web 8080:8080
```

Now, you can access NGINX by visiting `http://localhost:8080` in your browser or using `curl`:

```bash
curl http://localhost:8080
```

If everything is configured correctly, you should see the default NGINX welcome page served over port **8080**.

### Conclusion

By using a **ConfigMap** to manage the NGINX configuration, you can easily change the default HTTP port (or any other configuration) in a Kubernetes environment. This method allows for greater flexibility and better separation of configuration from application code, making it easier to update and scale your Kubernetes deployments.

Whether you're running NGINX as a development server or in production, externalizing configurations with Kubernetes ConfigMaps simplifies your management process and ensures that changes can be made without rebuilding container images.
