---
title: "CKAD Practice Questions"  
date: 2024-10-03T19:26:00-05:00  
draft: false  
tags: ["CKAD", "Kubernetes", "Certification", "Practice Questions", "DevOps"]  
categories:  
- Kubernetes  
- Certification  
- CKAD  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Prepare for the Certified Kubernetes Application Developer (CKAD) exam with these practice questions covering essential Kubernetes concepts."  
more_link: "yes"  
url: "/ckad-practice-questions/"  
---

The Certified Kubernetes Application Developer (CKAD) exam focuses on the skills required to design, build, and deploy cloud-native applications on Kubernetes. To help you prepare, we’ve compiled a series of practice questions that will test your knowledge of core Kubernetes concepts such as Pods, Deployments, ConfigMaps, Services, and more. Practicing these questions will help you gain the confidence and skills needed to pass the CKAD exam.

<!--more-->

### CKAD Practice Questions

#### 1. **Create a Pod with an Init Container**

Create a pod named `nginx-init` with a main container running `nginx` and an init container that runs `busybox` and prints "Init container finished".

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-init
spec:
  initContainers:
  - name: init-container
    image: busybox
    command: ['sh', '-c', 'echo Init container finished && sleep 1']
  containers:
  - name: nginx
    image: nginx
    ports:
    - containerPort: 80
```

#### 2. **Create a Deployment with Environment Variables**

Create a deployment named `env-deployment` with 3 replicas of an `nginx` container. Set the environment variable `ENV` to `production`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: env-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx
        env:
        - name: ENV
          value: "production"
```

#### 3. **Create a Service of Type LoadBalancer**

Create a service of type `LoadBalancer` named `myapp-service` that exposes a deployment named `myapp` on port 80.

```bash
kubectl expose deployment myapp --type=LoadBalancer --port=80 --name=myapp-service
```

#### 4. **Create a ConfigMap and Use It in a Pod**

Create a ConfigMap named `app-config` with a key `APP_MODE` set to `debug`. Then, create a pod that consumes this ConfigMap as an environment variable.

```bash
kubectl create configmap app-config --from-literal=APP_MODE=debug
```

Pod definition:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-pod
spec:
  containers:
  - name: app
    image: busybox
    env:
    - name: APP_MODE
      valueFrom:
        configMapKeyRef:
          name: app-config
          key: APP_MODE
    command: ['sh', '-c', 'echo $APP_MODE && sleep 3600']
```

#### 5. **Perform a Rolling Update**

Update the image of a deployment named `webapp` from version `v1` to `v2` and perform a rolling update.

```bash
kubectl set image deployment/webapp webapp=nginx:v2
```

#### 6. **Create a Secret and Use It in a Pod**

Create a secret named `db-secret` with keys `username` and `password`. Use this secret to set environment variables in a pod.

```bash
kubectl create secret generic db-secret --from-literal=username=dbuser --from-literal=password=secretpass
```

Pod definition:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secret-pod
spec:
  containers:
  - name: app
    image: busybox
    env:
    - name: DB_USER
      valueFrom:
        secretKeyRef:
          name: db-secret
          key: username
    - name: DB_PASS
      valueFrom:
        secretKeyRef:
          name: db-secret
          key: password
    command: ['sh', '-c', 'echo $DB_USER $DB_PASS && sleep 3600']
```

#### 7. **Use a Liveness Probe**

Create a pod named `liveness-pod` that uses a liveness probe to check if the `nginx` container is healthy by performing an HTTP GET request to `/healthz`.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: liveness-pod
spec:
  containers:
  - name: nginx
    image: nginx
    livenessProbe:
      httpGet:
        path: /healthz
        port: 80
      initialDelaySeconds: 5
      periodSeconds: 5
```

#### 8. **Create a Job**

Create a job named `pi-job` that runs a single pod to calculate the value of pi using `bc`.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pi-job
spec:
  template:
    spec:
      containers:
      - name: pi
        image: busybox
        command: ["sh", "-c", "echo 'scale=10; 4*a(1)' | bc -l"]
      restartPolicy: Never
```

#### 9. **Create a CronJob**

Create a CronJob named `hello-cron` that runs every minute and prints "Hello World".

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello-cron
spec:
  schedule: "*/1 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: hello
            image: busybox
            command: ['sh', '-c', 'echo Hello World']
          restartPolicy: OnFailure
```

#### 10. **Horizontal Pod Autoscaling**

Create an autoscaler for a deployment named `api-server` that automatically adjusts the number of replicas between 2 and 10 based on CPU utilization.

```bash
kubectl autoscale deployment api-server --min=2 --max=10 --cpu-percent=75
```

### Final Thoughts

These CKAD practice questions cover critical concepts you’ll need to master for the CKAD exam. By working through these examples, you’ll gain confidence in applying Kubernetes best practices for application development, deployment, and management. Remember, hands-on experience is key to passing the CKAD exam and becoming proficient in Kubernetes application development.
