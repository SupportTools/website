---
title: "Using NodePort with Multiple Replicas in k3s on Raspberry Pi"
date: 2024-05-18T19:26:00-05:00
draft: true
tags: ["k3s", "Raspberry Pi", "NodePort", "Kubernetes"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to use NodePort with multiple replicas in k3s on Raspberry Pi, including deployment and scaling."
more_link: "yes"
url: "/using-nodeport-with-multiple-replicas-in-k3s-on-raspberry-pi/"
---

Learn how to use NodePort with multiple replicas in k3s on Raspberry Pi, including deployment and scaling. This guide will help you understand how NodePort services work with multiple replicas.

<!--more-->

# [Using NodePort with Multiple Replicas in k3s on Raspberry Pi](#using-nodeport-with-multiple-replicas-in-k3s-on-raspberry-pi)

If you’re using a NodePort service with multiple replicas, how does it know which replica to use? Let's find out by running a simple Node.js server with multiple replicas.

## [Setting Up the Server](#setting-up-the-server)

We can find out which node we’re running on by following the instructions at [Kubernetes documentation](https://kubernetes.io/docs/tasks/inject-data-application/environment-variable-expose-pod-information/).

### server.js

```javascript
const PORT = process.env.PORT || 8111;

const MY_NODE_NAME = process.env.MY_NODE_NAME;
const MY_POD_NAMESPACE = process.env.MY_POD_NAMESPACE;
const MY_POD_NAME = process.env.MY_POD_NAME;
const MY_POD_IP = process.env.MY_POD_IP;

const http = require('http');
const server = http.createServer((req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');

        const info = `pod \${MY_POD_NAME} on node \${MY_NODE_NAME}\n`;
        res.end(info);
});

server.listen(PORT);
console.log(`Server listening on port \${PORT}`);
```

### Dockerfile

```dockerfile
FROM node:17
EXPOSE 8111
COPY server.js .
CMD ["node", "server.js"]
```

### Build and Push the Image

```bash
DOCKER_REGISTRY=docker.k3s.differentpla.net
IMAGE_TAG="$(date +%s)"
docker build -t node-server . \
&& docker tag node-server "\${DOCKER_REGISTRY}/node-server:\${IMAGE_TAG}" \
&& docker push "\${DOCKER_REGISTRY}/node-server:\${IMAGE_TAG}"
```

## [Deploying the Application](#deploying-the-application)

### Deployment YAML

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: node-server
  labels:
    app: node-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: node-server
  template:
    metadata:
      labels:
        app: node-server
        name: node-server
    spec:
      containers:
      - name: node-server
        image: docker.k3s.differentpla.net/node-server:1640867226
        env:
        - name: MY_NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: MY_POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: MY_POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: MY_POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
```

### Service YAML

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: node-server
  name: node-server
spec:
  type: NodePort
  ports:
  - port: 8111
    protocol: TCP
    targetPort: 8111
  selector:
    app: node-server
```

Apply the configurations:

```bash
kubectl apply -f deployment.yaml -f svc.yaml
```

## [Verifying the Deployment](#verifying-the-deployment)

### Checking the Running Node

```bash
curl http://rpi401:30184
```

Example output:

```
pod node-server-fcb84c684-xngdm on node rpi402
```

Confirm with:

```bash
kubectl get pods --selector=app=node-server -o wide
kubectl get pods --selector=app=node-server -o jsonpath='{.items[*].spec.nodeName}'
```

## [Scaling the Deployment](#scaling-the-deployment)

Scale up to 3 replicas:

### Updated Deployment YAML

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: node-server
  labels:
    app: node-server
spec:
  replicas: 3
...
```

Apply the updated configuration:

```bash
kubectl apply -f deployment.yaml
kubectl get pods --selector=app=node-server -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}'
```

Example output:

```
rpi402
rpi402
rpi401
```

### Accessing the Service

The service is available on any node:

```bash
curl http://rpi401:30184
```

Example output:

```
pod node-server-fcb84c684-psf64 on node rpi401
```

To emphasize the service is available on any node:

```bash
curl http://rpi404:30184
```

Example output:

```
pod node-server-fcb84c684-psf64 on node rpi401
```

## [References](#references)

- [How to Make Kubectl Jsonpath Output On Separate Lines](https://kubernetes.io/docs/reference/kubectl/jsonpath/)

By following these steps, you can effectively use NodePort with multiple replicas in k3s on Raspberry Pi, ensuring that your services are accessible and balanced across the nodes.
