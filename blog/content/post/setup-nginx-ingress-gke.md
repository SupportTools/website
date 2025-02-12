---
title: "How to Set Up Nginx Ingress on GKE: A Step-by-Step Guide"
date: 2025-02-13T00:00:00-05:00
draft: false
tags: ["GKE", "Ingress", "Load Balancer", "Google Cloud", "Kubernetes"]
categories:
- GKE
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide on installing and configuring Nginx Ingress with HTTP/HTTPS Load Balancing on Google Kubernetes Engine (GKE)."
more_link: "yes"
url: "/setup-nginx-ingress-gke/"
---

Looking to deploy an Ingress controller in Google Kubernetes Engine (GKE)? This step-by-step guide will walk you through setting up an Nginx Ingress Controller, configuring an HTTP/HTTPS Load Balancer, and deploying a test application to validate the setup. By following these instructions, you'll optimize traffic routing and improve network performance within your Kubernetes cluster.

<!--more-->

## Step 1: Install Nginx Ingress Controller on GKE

First, configure the `values.yaml` file to modify the service type and enable Network Endpoint Groups (NEG):

```yaml
nano values.yaml
---
controller:
  service:
    type: ClusterIP
    annotations:
      cloud.google.com/neg: '{"exposed_ports": {"80":{"name": "ingress-nginx-80-neg-http"}}}'
```

Now, deploy the Nginx Ingress Controller using Helm:

```sh
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm upgrade --install ingress-nginx ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  -f values.yaml --repo https://kubernetes.github.io/ingress-nginx
```

After deployment, verify the NEG creation in the Google Cloud Console.

## Step 2: Configure HTTP/HTTPS Load Balancer

### Reserve a Static IP Address

```sh
gcloud compute addresses create loadbalancer-ip-1 --global --ip-version IPV4
```

### Set Up Firewall Rules

```sh
gcloud compute firewall-rules create allow-http-loadbalancer \
    --allow tcp:80 \
    --source-ranges 130.211.0.0/22,35.191.0.0/16 \
    --network default
```

### Create a Health Check for Backend Services

```sh
gcloud compute health-checks create http lb-nginx-health-check \
  --port 80 \
  --check-interval 60 \
  --unhealthy-threshold 3 \
  --healthy-threshold 1 \
  --timeout 5 \
  --request-path /healthz
```

### Define Backend Service and Connect NEG

```sh
gcloud compute backend-services create lb-backend-service \
    --load-balancing-scheme=EXTERNAL \
    --protocol=HTTP \
    --port-name=http \
    --health-checks=lb-nginx-health-check \
    --global  

gcloud compute backend-services add-backend lb-backend-service \
  --network-endpoint-group=ingress-nginx-80-neg-http \
  --network-endpoint-group-zone=us-central1-c \
  --balancing-mode=RATE \
  --capacity-scaler=1.0 \
  --max-rate-per-endpoint=100 \
  --global
```

### Set Up URL Map, HTTP Proxy, and Forwarding Rule

```sh
gcloud compute url-maps create nginx-loadbalancer \
    --default-service lb-backend-service

gcloud compute target-http-proxies create http-lb-proxy \
    --url-map=nginx-loadbalancer

gcloud compute forwarding-rules create forwarding-rule-01 \
    --load-balancing-scheme=EXTERNAL \
    --address=loadbalancer-ip-1 \
    --global \
    --target-http-proxy=http-lb-proxy \
    --ports=80
```

## Step 3: Deploy a Sample Web Application

Deploy an Apache web server as a test service:

```yaml
nano httpd.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: httpd-deployment
spec:
  replicas: 1
  selector:
    matchLabels:
      app: httpd
  template:
    metadata:
      labels:
        app: httpd
    spec:
      containers:
      - name: httpd
        image: httpd
        ports:
        - containerPort: 80
```

Apply the configuration:

```sh
kubectl apply -f httpd.yaml
```

## Step 4: Set Up an Internal Ingress Controller

Modify `values.yaml` for an internal network setup:

```yaml
controller:
  service:
    type: ClusterIP
    annotations:
      cloud.google.com/neg: '{"exposed_ports": {"80":{"name": "ingress-nginx-internal-80-neg-http"}}}'
  ingressClassResource:
    name: internal-nginx
    enabled: true
    controllerValue: "k8s.io/internal-ingress-nginx"
```

Deploy the internal Ingress Controller:

```sh
helm upgrade --install ingress-nginx-internal ingress-nginx \
  --namespace ingress-nginx-internal --create-namespace \
  -f values.yaml --repo https://kubernetes.github.io/ingress-nginx
```

## Step 5: Deploy a Private Load Balancer and Test Access

Set up firewall rules, backend services, and deploy a test VM to access the private load balancer.

```sh
gcloud compute instances create testing-vm-01 \
    --zone=us-central1-c \
    --machine-type=e2-medium \
    --network-interface=subnet=default,no-address

gcloud compute ssh testing-vm-01 --zone us-central1-c --tunnel-through-iap

curl -v http://loadbalancer_ip/
```

Your GKE cluster is now equipped with an optimized, scalable Nginx Ingress setup, ensuring efficient traffic routing and high availability.
