---
title: "Install MetalLB and Istio Ingress Gateway with Mutual TLS for Kubernetes"  
date: 2024-09-27T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "MetalLB", "Istio", "Ingress", "Mutual TLS", "MTLS"]  
categories:  
- Kubernetes  
- Networking  
- Security  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to install and configure MetalLB and Istio Ingress Gateway with Mutual TLS on Kubernetes to secure and manage external traffic."  
more_link: "yes"  
url: "/install-metallb-istio-ingress-mtls-kubernetes/"  
---

When deploying services in Kubernetes, managing external traffic securely is a critical task. By using MetalLB for load balancing and Istio Ingress Gateway with Mutual TLS (mTLS), you can ensure secure communication between your services and external clients. In this guide, we’ll walk through the steps to install MetalLB, configure Istio Ingress Gateway, and enable mTLS for external traffic.

<!--more-->

### Why Use MetalLB and Istio Ingress with Mutual TLS?

- **MetalLB**: Provides network load balancing in bare-metal Kubernetes clusters. It assigns external IPs to services, simulating the behavior of a cloud-based load balancer.
- **Istio Ingress Gateway**: Manages incoming traffic to your services, applying routing rules and enforcing security policies like Mutual TLS.
- **Mutual TLS (mTLS)**: Ensures that both client and server authenticate each other, enhancing security for sensitive communications.

### Step 1: Install MetalLB

#### 1. **Install MetalLB with Manifest**

MetalLB requires a Layer 2 configuration for bare-metal environments, assigning IP addresses from a predefined pool.

```bash
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.12.1/manifests/metallb.yaml
```

#### 2. **Configure MetalLB IP Pool**

Create a Layer 2 configuration file for MetalLB. This file defines the IP address pool that MetalLB will use to assign external IPs to services.

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: my-ip-pool
  namespace: metallb-system
spec:
  addresses:
  - 192.168.1.240-192.168.1.250
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: my-l2-advertisement
  namespace: metallb-system
```

Apply the configuration:

```bash
kubectl apply -f metallb-config.yaml
```

MetalLB is now configured and ready to assign external IPs to services in your Kubernetes cluster.

### Step 2: Install Istio and Enable Ingress Gateway

#### 1. **Install Istio**

Download and install Istio with Helm:

```bash
curl -L https://istio.io/downloadIstio | sh -
cd istio-1.x.x
export PATH=$PWD/bin:$PATH
```

Install the Istio components:

```bash
istioctl install --set profile=default
```

#### 2. **Enable Istio Ingress Gateway**

The Istio Ingress Gateway is responsible for managing incoming external traffic. By default, the Ingress Gateway is installed but not exposed.

Create a Kubernetes service of type `LoadBalancer` for the Istio Ingress Gateway:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: istio-ingressgateway
  namespace: istio-system
spec:
  type: LoadBalancer
  selector:
    app: istio-ingressgateway
  ports:
  - port: 80
    targetPort: 8080
  - port: 443
    targetPort: 8443
```

Apply the service configuration:

```bash
kubectl apply -f istio-ingress-gateway.yaml
```

MetalLB will assign an external IP to the Istio Ingress Gateway, making it accessible from outside the cluster.

### Step 3: Enable Mutual TLS (mTLS)

Mutual TLS (mTLS) ensures that both the client and server authenticate each other. Istio makes it easy to configure mTLS for incoming traffic to the Ingress Gateway.

#### 1. **Create a Root Certificate Authority (CA)**

First, generate a root certificate and key to serve as the root CA for mTLS.

```bash
openssl req -x509 -newkey rsa:4096 -keyout ca.key -out ca.crt -days 365 -nodes -subj "/CN=RootCA"
```

#### 2. **Generate Certificates for the Ingress Gateway**

Generate a private key and certificate for the Istio Ingress Gateway.

```bash
openssl req -newkey rsa:4096 -keyout istio-ingressgateway.key -out istio-ingressgateway.csr -nodes -subj "/CN=istio-ingressgateway"
openssl x509 -req -in istio-ingressgateway.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out istio-ingressgateway.crt -days 365
```

#### 3. **Create a Secret for the Gateway Certificates**

Store the certificates as Kubernetes secrets in the `istio-system` namespace:

```bash
kubectl create -n istio-system secret tls istio-ingressgateway-certs --key istio-ingressgateway.key --cert istio-ingressgateway.crt
kubectl create -n istio-system secret generic ca-cert --from-file=ca.crt=ca.crt
```

#### 4. **Configure Gateway for mTLS**

Update the Istio `Gateway` resource to enforce mTLS for incoming traffic:

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: Gateway
metadata:
  name: my-gateway
  namespace: istio-system
spec:
  selector:
    istio: ingressgateway
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    tls:
      mode: MUTUAL
      serverCertificate: /etc/istio/ingressgateway-certs/tls.crt
      privateKey: /etc/istio/ingressgateway-certs/tls.key
      caCertificates: /etc/istio/ca-cert/ca.crt
    hosts:
    - "myapp.homelab.local"
```

Apply the Gateway configuration:

```bash
kubectl apply -f mtls-gateway.yaml
```

### Step 4: Test the Ingress with mTLS

To verify the mTLS setup, you’ll need to configure a client to authenticate with the Ingress Gateway using a client certificate signed by the same CA.

#### 1. **Generate a Client Certificate**

Create a certificate for the client:

```bash
openssl req -newkey rsa:4096 -keyout client.key -out client.csr -nodes -subj "/CN=client"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 365
```

#### 2. **Test the Connection**

Use `curl` to test the connection between the client and the Istio Ingress Gateway:

```bash
curl --key client.key --cert client.crt --cacert ca.crt https://myapp.homelab.local
```

If everything is configured correctly, you should see a successful response from the application behind the Istio Ingress Gateway.

### Final Thoughts

By combining MetalLB with Istio Ingress Gateway and Mutual TLS, you can ensure secure external access to your Kubernetes services while maintaining control over load balancing and routing. This setup provides enhanced security, particularly for homelab or bare-metal environments, and gives you the flexibility to manage traffic securely and efficiently.
