---
title: "RKE2 the Hard Way: Part 10 – Installing Ingress Nginx"
description: "Installing and configuring Ingress Nginx for external access to Kubernetes services."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 10
draft: false
tags: ["kubernetes", "rke2", "ingress", "nginx", "load-balancing"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 10 of RKE2 the Hard Way, we install and configure Ingress Nginx to enable external access to services in our Kubernetes cluster."
more_link: ""
---

## Part 10 – Installing Ingress Nginx

In this part of the **"RKE2 the Hard Way"** training series, we will install and configure **Ingress Nginx** for external access to services in our Kubernetes cluster. Ingress Nginx is a popular ingress controller for Kubernetes that uses NGINX as a reverse proxy and load balancer.

An ingress controller is essential because it:
- Provides a single entry point to multiple services in your cluster
- Handles SSL/TLS termination for your services
- Enables host-based and path-based routing to backend services
- Allows you to expose applications to the outside world without creating a LoadBalancer service for each one

At this point in our series, we have:
- A fully functional Kubernetes cluster with all control plane components
- Pod networking via Cilium CNI
- DNS resolution via CoreDNS

Let's now set up Ingress Nginx to enable external access to our applications.

---

### 1. Prepare the Ingress Nginx Manifest

We'll deploy Ingress Nginx using the official manifest:

```bash
# Download the Ingress Nginx manifest
INGRESS_NGINX_VERSION=v1.9.5
curl -fsSL https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-${INGRESS_NGINX_VERSION}/deploy/static/provider/baremetal/deploy.yaml -o ingress-nginx.yaml
```

---

### 2. Deploy Ingress Nginx

Apply the manifest to your cluster:

```bash
kubectl apply -f ingress-nginx.yaml
```

This will create:
- The `ingress-nginx` namespace
- RBAC resources (ServiceAccount, ClusterRole, ClusterRoleBinding)
- ConfigMaps for controller configuration
- The Ingress Nginx controller Deployment
- A NodePort Service to expose the controller

---

### 3. Verify Ingress Nginx Installation

Check that the Ingress Nginx controller pods are running:

```bash
kubectl get pods -n ingress-nginx
```

You should see output similar to:

```
NAME                                        READY   STATUS    RESTARTS   AGE
ingress-nginx-controller-xxxxxxxxxx-xxxxx   1/1     Running   0          1m
```

Also, check the service:

```bash
kubectl get svc -n ingress-nginx
```

You should see output similar to:

```
NAME                                 TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)                      AGE
ingress-nginx-controller             NodePort    10.43.x.x       <none>        80:30080/TCP,443:30443/TCP   1m
ingress-nginx-controller-admission   ClusterIP   10.43.x.x       <none>        443/TCP                      1m
```

The NodePort service exposes the Ingress controller on all nodes at ports 30080 (HTTP) and 30443 (HTTPS).

---

### 4. Create a Sample Application to Test Ingress

Let's deploy a simple application to test our Ingress controller:

```bash
# Create a namespace for our test application
kubectl create namespace demo

# Create a deployment
cat > hello-app.yaml << EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-app
  namespace: demo
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hello-app
  template:
    metadata:
      labels:
        app: hello-app
    spec:
      containers:
      - name: hello-app
        image: gcr.io/google-samples/hello-app:1.0
        ports:
        - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: hello-service
  namespace: demo
spec:
  selector:
    app: hello-app
  ports:
  - port: 80
    targetPort: 8080
EOF

kubectl apply -f hello-app.yaml
```

---

### 5. Create an Ingress Resource

Now, let's create an Ingress resource to expose our application:

```bash
cat > hello-ingress.yaml << EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hello-ingress
  namespace: demo
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: hello-world.info
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: hello-service
            port:
              number: 80
EOF

kubectl apply -f hello-ingress.yaml
```

---

### 6. Test the Ingress

To test the Ingress, you'll need to simulate DNS resolution for the hostname we defined (`hello-world.info`). You can do this by:

1. Adding an entry to your local machine's hosts file pointing to one of your node's IPs:
   ```
   <NODE_IP> hello-world.info
   ```

2. Or by using curl with the Host header:
   ```bash
   # Get the NodePort for HTTP
   NODE_PORT=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}')
   
   # Test the Ingress with curl (replace <NODE_IP> with the IP of any node)
   curl -H "Host: hello-world.info" http://<NODE_IP>:$NODE_PORT
   ```

You should see a response from the hello-app service.

---

### 7. Clean Up Test Resources

After successful testing, you can clean up the test resources if desired:

```bash
kubectl delete namespace demo
```

---

## Next Steps

Congratulations! You now have a complete Kubernetes cluster with networking, DNS, and external access capability through Ingress Nginx. In the final part of this series, we'll perform a comprehensive **Cluster Verification** and set up access for kubectl.

👉 Continue to **[Part 11: Cluster Verification and Access](/training/rke2-hard-way/11-cluster-verification-and-access/)**
