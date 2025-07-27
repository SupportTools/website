---
title: "OpenVPN Server on Kubernetes"  
date: 2024-10-01T19:26:00-05:00  
draft: false  
tags: ["OpenVPN", "Kubernetes", "Networking", "VPN"]  
categories:  
- Kubernetes  
- Networking  
- VPN  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to set up and configure an OpenVPN server on Kubernetes to secure your network traffic and access your cluster remotely."  
more_link: "yes"  
url: "/openvpn-server-kubernetes/"  
---

Setting up an OpenVPN server on Kubernetes allows you to secure your network traffic and provide remote access to resources within your cluster. By deploying OpenVPN as a containerized service, you can easily manage and scale your VPN infrastructure within a Kubernetes environment. In this post, we’ll walk through the steps to deploy an OpenVPN server on Kubernetes and configure clients to connect securely.

<!--more-->

### Why Use OpenVPN on Kubernetes?

OpenVPN is a popular open-source VPN solution that provides secure remote access to networks over the internet. Deploying it on Kubernetes offers several advantages:

- **Scalability**: Easily scale your OpenVPN deployment as your needs grow.
- **Management**: Manage your VPN infrastructure with Kubernetes' built-in orchestration and monitoring tools.
- **Security**: Secure access to resources in your Kubernetes cluster without exposing services directly to the internet.

### Step 1: Deploy OpenVPN on Kubernetes

#### 1. **Create a Kubernetes Deployment for OpenVPN**

First, we need to create a Kubernetes deployment for the OpenVPN server. You can use a pre-built OpenVPN Docker image, or build your own if you have specific requirements.

Here’s an example `openvpn-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openvpn-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: openvpn
  template:
    metadata:
      labels:
        app: openvpn
    spec:
      containers:
      - name: openvpn
        image: kylemanna/openvpn
        ports:
        - containerPort: 1194
        volumeMounts:
        - name: openvpn-config
          mountPath: /etc/openvpn
      volumes:
      - name: openvpn-config
        emptyDir: {}
```

This creates a single OpenVPN server pod using the `kylemanna/openvpn` image. It mounts an empty directory volume for storing OpenVPN configuration files.

#### 2. **Create a Service for OpenVPN**

Expose the OpenVPN server using a Kubernetes service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: openvpn-service
spec:
  selector:
    app: openvpn
  ports:
  - protocol: UDP
    port: 1194
    targetPort: 1194
  type: LoadBalancer
```

This service uses a `LoadBalancer` type to expose the OpenVPN server on port `1194` using UDP.

### Step 2: Configure OpenVPN Server

Now that the OpenVPN server is deployed, we need to configure it for client access.

#### 1. **Initialize OpenVPN Configuration**

Use the `kylemanna/openvpn` image to initialize the server configuration and generate certificates:

```bash
kubectl exec -it <openvpn-pod-name> -- bash
ovpn_genconfig -u udp://<EXTERNAL-IP>
ovpn_initpki
```

Make sure to replace `<EXTERNAL-IP>` with the external IP assigned to your OpenVPN service by Kubernetes.

#### 2. **Create Client Certificates**

Generate client certificates for each user that needs access to the VPN:

```bash
easyrsa build-client-full <client-name> nopass
ovpn_getclient <client-name> > /etc/openvpn/<client-name>.ovpn
```

This will generate an `.ovpn` configuration file for the client, which contains all the necessary certificates and keys to connect to the OpenVPN server.

### Step 3: Set Up Persistent Storage for OpenVPN

To avoid losing configuration files when the OpenVPN pod is restarted or redeployed, it’s a good idea to use persistent storage.

#### 1. **Create a Persistent Volume and Claim**

Define a persistent volume and persistent volume claim for the OpenVPN server:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openvpn-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

Mount this volume in the OpenVPN deployment by updating the volume definition:

```yaml
volumes:
- name: openvpn-config
  persistentVolumeClaim:
    claimName: openvpn-pvc
```

This ensures that OpenVPN configuration files are stored persistently across pod restarts.

### Step 4: Connect Clients to the OpenVPN Server

Once the OpenVPN server is running and configured, distribute the `.ovpn` configuration files to your clients.

#### 1. **Install OpenVPN on the Client**

On the client machine, install OpenVPN (available on Linux, macOS, and Windows):

```bash
sudo apt-get install openvpn  # On Debian-based systems
brew install openvpn  # On macOS using Homebrew
```

#### 2. **Connect to the VPN**

Use the `.ovpn` file generated earlier to connect to the VPN:

```bash
sudo openvpn --config <client-name>.ovpn
```

This will establish a secure connection to the OpenVPN server running on Kubernetes.

### Step 5: Set Up Monitoring and Alerts (Optional)

To ensure the OpenVPN server is running smoothly, you can set up monitoring using Prometheus and Grafana. By monitoring key metrics such as connection status and network traffic, you can ensure the reliability of your VPN infrastructure.

### Final Thoughts

Setting up an OpenVPN server on Kubernetes is an effective way to manage secure remote access to your cluster or internal network. With Kubernetes' built-in scalability and orchestration capabilities, you can easily manage and scale your VPN infrastructure while ensuring high availability. This solution provides a secure and efficient way to access resources without exposing them to the internet.
