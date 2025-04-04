---
title: "CKA Prep: Part 9 – Mock Exam Questions"
description: "Comprehensive mock exam questions and detailed solutions covering all domains of the CKA certification."
date: 2025-04-04T00:00:00-00:00
series: "CKA Exam Preparation Guide"
series_rank: 9
draft: false
tags: ["kubernetes", "cka", "exam", "mock", "practice", "k8s", "exam-prep"]
categories: ["Training", "Kubernetes Certification"]
author: "Matthew Mattox"
more_link: ""
---

## CKA Mock Exam Introduction

This mock exam is designed to simulate the types of questions you'll encounter in the real Certified Kubernetes Administrator (CKA) exam. Each question focuses on practical tasks that require you to apply your knowledge of Kubernetes concepts.

## Exam Format Guidelines

The real CKA exam has the following characteristics:

- 2-hour time limit
- Performance-based (hands-on) questions
- Browser-based terminal access to Kubernetes clusters
- Access to the official Kubernetes documentation
- 66% passing score

When working through these mock questions, try to simulate exam conditions:

1. Set a timer to practice time management
2. Use only the [Kubernetes documentation](https://kubernetes.io/docs/) for reference
3. Focus on accuracy and completion rather than speed

## Mock Exam Questions

### Question 1: Pod Creation and Configuration

**Task**: Create a pod named `nginx-pod` in the `web` namespace using the image `nginx:1.21`. The pod should have a label `app=frontend` and request 200m CPU and 256Mi memory. The namespace does not exist yet.

**Solution**:

```bash
# Create the namespace
kubectl create namespace web

# Create the pod with resource requests
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: nginx-pod
  namespace: web
  labels:
    app: frontend
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
EOF
```

**Alternative solution using imperative commands**:

```bash
# Create the namespace
kubectl create namespace web

# Create the pod
kubectl run nginx-pod --image=nginx:1.21 -n web --labels=app=frontend --requests=cpu=200m,memory=256Mi
```

**Verification**:

```bash
kubectl get pod nginx-pod -n web
kubectl describe pod nginx-pod -n web
```

### Question 2: Multi-Container Pod

**Task**: Create a pod named `sidecar-pod` in the default namespace. This pod should have two containers:
- A main container named `app` using the `nginx:1.21` image
- A sidecar container named `logger` using the `busybox:1.34` image that runs the command `tail -f /var/log/nginx/access.log` 

Both containers should share a volume named `logs` mounted at `/var/log/nginx` in both containers.

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: sidecar-pod
spec:
  containers:
  - name: app
    image: nginx:1.21
    volumeMounts:
    - name: logs
      mountPath: /var/log/nginx
  - name: logger
    image: busybox:1.34
    command: ["tail", "-f", "/var/log/nginx/access.log"]
    volumeMounts:
    - name: logs
      mountPath: /var/log/nginx
  volumes:
  - name: logs
    emptyDir: {}
EOF
```

**Verification**:

```bash
kubectl get pod sidecar-pod
kubectl describe pod sidecar-pod
kubectl logs sidecar-pod -c logger
```

### Question 3: Deployment with Rolling Update Strategy

**Task**: Create a deployment named `web-deployment` in the `apps` namespace (create if it doesn't exist) with the following specifications:
- Image: nginx:1.20
- Replicas: 3
- Labels: app=web, tier=frontend
- Rolling update strategy with max unavailable 25% and max surge 50%
- An environment variable `ENVIRONMENT` set to `production`

**Solution**:

```bash
# Create the namespace if it doesn't exist
kubectl create namespace apps

# Create the deployment
cat << EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-deployment
  namespace: apps
  labels:
    app: web
    tier: frontend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 25%
      maxSurge: 50%
  template:
    metadata:
      labels:
        app: web
        tier: frontend
    spec:
      containers:
      - name: nginx
        image: nginx:1.20
        env:
        - name: ENVIRONMENT
          value: production
EOF
```

**Verification**:

```bash
kubectl get deployment web-deployment -n apps
kubectl describe deployment web-deployment -n apps
```

### Question 4: Service Configuration

**Task**: Create a service named `web-service` in the `apps` namespace that exposes the `web-deployment` created in the previous question on port 80. The service should be of type NodePort and expose port 30080 on the node.

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: web-service
  namespace: apps
spec:
  type: NodePort
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
    nodePort: 30080
EOF
```

**Alternative solution using imperative commands**:

```bash
kubectl expose deployment web-deployment -n apps --name=web-service --port=80 --target-port=80 --type=NodePort
kubectl patch service web-service -n apps -p '{"spec": {"ports": [{"port": 80, "nodePort": 30080}]}}'
```

**Verification**:

```bash
kubectl get service web-service -n apps
kubectl describe service web-service -n apps
```

### Question 5: ConfigMap and Secret Usage

**Task**: 
1. Create a ConfigMap named `app-config` with the data `DATABASE_URL=mysql://db:3306/prod` and `APP_ENV=production`
2. Create a Secret named `app-secret` with the data `DB_USER=admin` and `DB_PASSWORD=password123`
3. Create a pod named `config-pod` using the `nginx:1.21` image that mounts the ConfigMap as environment variables and the Secret values as files in `/etc/secrets`

**Solution**:

```bash
# Create the ConfigMap
kubectl create configmap app-config --from-literal=DATABASE_URL=mysql://db:3306/prod --from-literal=APP_ENV=production

# Create the Secret
kubectl create secret generic app-secret --from-literal=DB_USER=admin --from-literal=DB_PASSWORD=password123

# Create the pod with ConfigMap and Secret
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: config-pod
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    envFrom:
    - configMapRef:
        name: app-config
    volumeMounts:
    - name: secret-volume
      mountPath: /etc/secrets
      readOnly: true
  volumes:
  - name: secret-volume
    secret:
      secretName: app-secret
EOF
```

**Verification**:

```bash
kubectl describe configmap app-config
kubectl describe secret app-secret
kubectl describe pod config-pod

# Verify environment variables and mounted secrets
kubectl exec config-pod -- env | grep -E 'DATABASE_URL|APP_ENV'
kubectl exec config-pod -- ls -l /etc/secrets
```

### Question 6: NetworkPolicy Implementation

**Task**: Create a NetworkPolicy named `db-policy` in the `apps` namespace that:
1. Allows pods with the label `role=frontend` to connect to pods with the label `role=db` on port 3306
2. Allows pods in the `monitoring` namespace to connect to pods with the label `role=db` on any port

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-policy
  namespace: apps
spec:
  podSelector:
    matchLabels:
      role: db
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 3306
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
EOF
```

**Note**: The namespace `monitoring` would need the label `name: monitoring` for this to work:

```bash
kubectl create namespace monitoring
kubectl label namespace monitoring name=monitoring
```

**Verification**:

```bash
kubectl describe networkpolicy db-policy -n apps
```

### Question 7: Persistent Volume Setup

**Task**: 
1. Create a PersistentVolume named `data-pv` with 1Gi capacity using the hostPath type at `/data/pv`
2. Create a PersistentVolumeClaim named `data-pvc` in the default namespace that requests 500Mi storage
3. Create a pod named `data-pod` that uses the PVC to mount a volume at `/data`

**Solution**:

```bash
# Create the PersistentVolume
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolume
metadata:
  name: data-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /data/pv
EOF

# Create the PersistentVolumeClaim
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Mi
EOF

# Create the pod with PVC
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: data-pod
spec:
  containers:
  - name: busybox
    image: busybox
    command: ["sleep", "3600"]
    volumeMounts:
    - name: data-volume
      mountPath: /data
  volumes:
  - name: data-volume
    persistentVolumeClaim:
      claimName: data-pvc
EOF
```

**Verification**:

```bash
kubectl get pv data-pv
kubectl get pvc data-pvc
kubectl describe pod data-pod
```

### Question 8: Role-Based Access Control (RBAC)

**Task**: 
1. Create a ServiceAccount named `deployment-manager` in the `apps` namespace
2. Create a Role that allows the ServiceAccount to create, delete, and update deployments in the `apps` namespace
3. Create a RoleBinding to bind the Role to the ServiceAccount

**Solution**:

```bash
# Create the ServiceAccount
kubectl create serviceaccount deployment-manager -n apps

# Create the Role
cat << EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployment-manager-role
  namespace: apps
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["create", "delete", "update", "get", "list"]
EOF

# Create the RoleBinding
cat << EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: deployment-manager-binding
  namespace: apps
subjects:
- kind: ServiceAccount
  name: deployment-manager
  namespace: apps
roleRef:
  kind: Role
  name: deployment-manager-role
  apiGroup: rbac.authorization.k8s.io
EOF
```

**Verification**:

```bash
kubectl describe role deployment-manager-role -n apps
kubectl describe rolebinding deployment-manager-binding -n apps
kubectl auth can-i create deployments --as=system:serviceaccount:apps:deployment-manager -n apps
```

### Question 9: Cluster Upgrade

**Task**: Your cluster is currently running Kubernetes v1.25.0. Describe the steps to upgrade the control plane components to v1.26.0 using kubeadm.

**Solution**:

In a real environment, you would execute these commands:

```bash
# 1. Check the current version
kubectl version --short

# 2. Upgrade kubeadm on the control plane node
apt-get update
apt-get install -y kubeadm=1.26.0-00

# 3. Verify the upgrade plan
kubeadm upgrade plan

# 4. Apply the upgrade
kubeadm upgrade apply v1.26.0

# 5. Upgrade kubelet and kubectl on the control plane node
apt-get install -y kubelet=1.26.0-00 kubectl=1.26.0-00

# 6. Restart the kubelet
systemctl daemon-reload
systemctl restart kubelet

# 7. Verify the upgrade
kubectl get nodes
```

For worker nodes, you would then:

```bash
# 1. Drain the worker node
kubectl drain worker-1 --ignore-daemonsets

# 2. On the worker node, upgrade kubeadm
apt-get update
apt-get install -y kubeadm=1.26.0-00

# 3. Upgrade the kubelet configuration
kubeadm upgrade node

# 4. Upgrade kubelet and kubectl
apt-get install -y kubelet=1.26.0-00 kubectl=1.26.0-00

# 5. Restart the kubelet
systemctl daemon-reload
systemctl restart kubelet

# 6. Uncordon the node
kubectl uncordon worker-1
```

### Question 10: etcd Backup and Restore

**Task**: 
1. Create a backup of the etcd database to `/opt/etcd-backup.db`
2. Describe the steps to restore the etcd database from the backup

**Solution**:

In a real environment, you would execute these commands:

```bash
# 1. Create a backup
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/etcd-backup.db

# 2. Verify the backup
ETCDCTL_API=3 etcdctl --write-out=table snapshot status /opt/etcd-backup.db
```

To restore:

```bash
# 1. Stop the kube-apiserver
systemctl stop kube-apiserver

# 2. Restore the snapshot to a new directory
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --data-dir=/var/lib/etcd-restore \
  snapshot restore /opt/etcd-backup.db

# 3. Update the etcd pod manifest to use the restored data directory
# Edit /etc/kubernetes/manifests/etcd.yaml
# Change the --data-dir value to /var/lib/etcd-restore
# Change the hostPath for the volume "etcd-data" to /var/lib/etcd-restore

# 4. Wait for etcd to restart automatically
# 5. Start the kube-apiserver if it doesn't auto-start
systemctl start kube-apiserver

# 6. Verify the cluster is working
kubectl get nodes
```

### Question 11: Troubleshooting Node Issues

**Task**: Node `worker-1` is in a `NotReady` state. Describe the steps you would take to diagnose and fix the issue.

**Solution**:

```bash
# 1. Check node status
kubectl get nodes
kubectl describe node worker-1

# 2. SSH to the problematic node
ssh worker-1

# 3. Check kubelet status
systemctl status kubelet

# 4. If kubelet is not running, start it
systemctl start kubelet

# 5. If kubelet is running but there are errors, check logs
journalctl -u kubelet -n 100

# 6. Check kubelet configuration
cat /var/lib/kubelet/config.yaml

# 7. Common issues to look for:
# - Check if kubelet certificate is valid
ls -l /var/lib/kubelet/pki/

# - Check if node has sufficient resources
df -h
free -m

# - Check container runtime status
# For containerd:
systemctl status containerd
# For Docker:
systemctl status docker

# 8. After fixing the issue, restart kubelet
systemctl restart kubelet

# 9. Verify node is now Ready
kubectl get nodes
```

### Question 12: Troubleshooting Service Connectivity

**Task**: A service named `app-service` in the `default` namespace is not routing traffic to pods labeled `app=web`. Describe the steps to diagnose and fix the issue.

**Solution**:

```bash
# 1. Check the service details
kubectl get service app-service
kubectl describe service app-service

# 2. Check if the service has endpoints
kubectl get endpoints app-service

# 3. If no endpoints, check the service selector and pod labels
# Get the service selector
kubectl get service app-service -o jsonpath='{.spec.selector}'

# Check if pods with matching labels exist and are Running
kubectl get pods -l app=web

# If pods are not found or have different labels, check all pod labels
kubectl get pods --show-labels

# 4. If pods exist but are not Running, check pod status
kubectl describe pods -l app=web

# 5. If pods have a different label, either:
# Option 1: Update the service selector to match existing pod labels
kubectl edit service app-service
# Change .spec.selector to match the actual pod labels

# Option 2: Update the pod labels to match the service selector
kubectl label pods <pod-name> app=web

# 6. Verify connectivity after fixing
kubectl get endpoints app-service
# Run a test pod to verify connectivity:
kubectl run test-pod --image=busybox --rm -it -- wget -O- app-service:80
```

### Question 13: Multi-Container Pod Design with Init Container

**Task**: Create a pod named `web-app` with:
1. An init container using `busybox:1.34` that creates a file `/data/index.html` with content "Hello from init container"
2. A main container using `nginx:1.21` that mounts the same volume at `/usr/share/nginx/html`
3. An emptyDir volume shared between containers

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: web-app
spec:
  initContainers:
  - name: init-web
    image: busybox:1.34
    command: ["/bin/sh", "-c", "echo 'Hello from init container' > /data/index.html"]
    volumeMounts:
    - name: web-content
      mountPath: /data
  containers:
  - name: nginx
    image: nginx:1.21
    volumeMounts:
    - name: web-content
      mountPath: /usr/share/nginx/html
  volumes:
  - name: web-content
    emptyDir: {}
EOF
```

**Verification**:

```bash
kubectl get pod web-app
kubectl describe pod web-app
kubectl exec web-app -- cat /usr/share/nginx/html/index.html
```

### Question 14: Job and CronJob Creation

**Task**: 
1. Create a Job named `batch-job` that runs a Pod with the `perl:5.34` image to compute π to 2000 places and then exits
2. Create a CronJob named `daily-backup` that runs a Pod with the `busybox:1.34` image every day at midnight to execute `echo "Backup completed"`

**Solution**:

```bash
# Create the Job
cat << EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: batch-job
spec:
  template:
    spec:
      containers:
      - name: pi
        image: perl:5.34
        command: ["perl", "-Mbignum=bpi", "-wle", "print bpi(2000)"]
      restartPolicy: Never
  backoffLimit: 4
EOF

# Create the CronJob
cat << EOF | kubectl apply -f -
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-backup
spec:
  schedule: "0 0 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: busybox:1.34
            command: ["/bin/sh", "-c", "echo Backup completed"]
          restartPolicy: OnFailure
EOF
```

**Verification**:

```bash
kubectl get job batch-job
kubectl get pods -l job-name=batch-job
kubectl logs -l job-name=batch-job

kubectl get cronjob daily-backup
kubectl describe cronjob daily-backup
```

### Question 15: Pod Scheduling with Node Affinity

**Task**: Create a pod named `gpu-pod` with the `nginx:1.21` image that:
1. Is scheduled only on nodes with label `gpu=true`
2. Preferably on nodes with label `zone=east`
3. Has resource requests of 1 CPU and 1Gi memory

**Solution**:

```bash
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu-pod
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    resources:
      requests:
        cpu: "1"
        memory: "1Gi"
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: gpu
            operator: In
            values:
            - "true"
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 1
        preference:
          matchExpressions:
          - key: zone
            operator: In
            values:
            - east
EOF
```

**Note**: You may need to label a node for this to work:

```bash
kubectl label node <node-name> gpu=true zone=east
```

**Verification**:

```bash
kubectl get pod gpu-pod
kubectl describe pod gpu-pod
```

### Question 16: Custom Resource Definition (CRD) Investigation

**Task**: There's a custom resource type 'Backend' in the cluster. List all available Backend resources across all namespaces, and then describe the one named 'api-backend' in the 'applications' namespace.

**Solution**:

```bash
# Find the API group and version for Backend resources
kubectl api-resources | grep Backend

# Assuming it's found in group 'example.com' with version 'v1'
# List all Backend resources across all namespaces
kubectl get backends.example.com --all-namespaces

# Describe the specific Backend resource
kubectl describe backends.example.com api-backend -n applications

# If you need the raw configuration
kubectl get backends.example.com api-backend -n applications -o yaml
```

### Question 17: Certificate Management

**Task**: The kube-apiserver certificate is going to expire soon. Generate a new certificate signing request (CSR) for the API server and approve it.

**Solution**:

```bash
# Examine the current certificate expiration
sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -text -noout | grep -A 2 Validity

# Create a new private key
sudo openssl genrsa -out /etc/kubernetes/pki/apiserver-new.key 2048

# Create a CSR
sudo openssl req -new -key /etc/kubernetes/pki/apiserver-new.key \
  -out /tmp/apiserver.csr \
  -subj "/CN=kube-apiserver" \
  -config /etc/kubernetes/pki/openssl.cnf

# Create a Kubernetes CSR
cat << EOF | kubectl apply -f -
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: apiserver-renewal
spec:
  request: $(cat /tmp/apiserver.csr | base64 | tr -d '\n')
  signerName: kubernetes.io/kubelet-serving
  usages:
  - digital signature
  - key encipherment
  - server auth
EOF

# Approve the CSR
kubectl certificate approve apiserver-renewal

# Get the signed certificate
kubectl get csr apiserver-renewal -o jsonpath='{.status.certificate}' | base64 --decode > /etc/kubernetes/pki/apiserver-new.crt

# Back up the old certificate and key
sudo mv /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.crt.old
sudo mv /etc/kubernetes/pki/apiserver.key /etc/kubernetes/pki/apiserver.key.old

# Use the new certificate and key
sudo mv /etc/kubernetes/pki/apiserver-new.crt /etc/kubernetes/pki/apiserver.crt
sudo mv /etc/kubernetes/pki/apiserver-new.key /etc/kubernetes/pki/apiserver.key

# Restart kube-apiserver (if using kubeadm, touch the manifest file)
sudo touch /etc/kubernetes/manifests/kube-apiserver.yaml
```

### Question 18: Debug API Request Failures

**Task**: API requests to create Pods in the 'restricted' namespace are failing. Investigate and fix the issue.

**Solution**:

```bash
# Try to create a test pod to reproduce the issue
kubectl run test-pod --image=nginx -n restricted

# Check for events in the namespace
kubectl get events -n restricted

# Check if there are any admission controllers blocking the request
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations

# Check if there's a PodSecurityPolicy or other security constraint
kubectl get psp
kubectl get podsecuritypolicy

# Check if there are any ResourceQuotas preventing pod creation
kubectl get resourcequota -n restricted
kubectl describe resourcequota -n restricted

# Check for NetworkPolicies
kubectl get networkpolicy -n restricted

# Check RBAC permissions for the current user/serviceaccount
kubectl auth can-i create pods -n restricted
kubectl auth can-i create pods -n restricted --as system:serviceaccount:restricted:default

# If it's a quota issue, increase the quota
kubectl edit resourcequota compute-quota -n restricted
# Modify the 'pods' limit to a higher value

# If it's a permission issue, create appropriate RBAC
cat << EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-creator
  namespace: restricted
subjects:
- kind: ServiceAccount
  name: default
  namespace: restricted
roleRef:
  kind: ClusterRole
  name: edit
  apiGroup: rbac.authorization.k8s.io
EOF
```

### Question 19: Manage Static Pods

**Task**: Create a static pod named `static-web` on node `node01` using the `nginx:alpine` image, then find and remove another static pod named `static-db` running on the same node.

**Solution**:

```bash
# Connect to node01
ssh node01

# Find the static pod directory
sudo find / -name "manifests" -type d 2>/dev/null | grep kubelet

# It's likely in /etc/kubernetes/manifests
# Create the static pod manifest
cat << EOF | sudo tee /etc/kubernetes/manifests/static-web.yaml
apiVersion: v1
kind: Pod
metadata:
  name: static-web
spec:
  containers:
  - name: nginx
    image: nginx:alpine
EOF

# Find and remove the static-db pod
sudo rm /etc/kubernetes/manifests/static-db.yaml

# Exit back to the control plane node
exit

# Verify the pods
kubectl get pods | grep static-
```

### Question 20: Custom Scheduler Deployment

**Task**: Deploy a second scheduler named `custom-scheduler` in the cluster using the same image as the default scheduler but with a different leader election lease name.

**Solution**:

```bash
# Get the default scheduler manifest as a starting point
kubectl get pod -n kube-system kube-scheduler-controlplane -o yaml > custom-scheduler.yaml

# Edit the manifest to create a deployment for the custom scheduler
cat << EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-scheduler
  namespace: kube-system
  labels:
    component: custom-scheduler
spec:
  replicas: 1
  selector:
    matchLabels:
      component: custom-scheduler
  template:
    metadata:
      labels:
        component: custom-scheduler
    spec:
      containers:
      - name: kube-scheduler
        image: k8s.gcr.io/kube-scheduler:v1.23.0  # Use same version as your cluster
        command:
        - kube-scheduler
        - --authentication-kubeconfig=/etc/kubernetes/scheduler.conf
        - --authorization-kubeconfig=/etc/kubernetes/scheduler.conf
        - --kubeconfig=/etc/kubernetes/scheduler.conf
        - --leader-elect=true
        - --leader-elect-lease-duration=15s
        - --leader-elect-resource-name=custom-scheduler
        - --scheduler-name=custom-scheduler
        volumeMounts:
        - mountPath: /etc/kubernetes/scheduler.conf
          name: kubeconfig
          readOnly: true
      hostNetwork: true
      priorityClassName: system-node-critical
      volumes:
      - hostPath:
          path: /etc/kubernetes/scheduler.conf
          type: File
        name: kubeconfig
EOF

# Wait for the custom scheduler to be running
kubectl -n kube-system get pods | grep custom-scheduler

# Create a pod that uses the custom scheduler
cat << EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: custom-scheduled-pod
spec:
  schedulerName: custom-scheduler
  containers:
  - name: nginx
    image: nginx
EOF

# Verify the pod was scheduled by the custom scheduler
kubectl get pod custom-scheduled-pod -o wide
kubectl get events | grep custom-scheduled-pod | grep Scheduled
```

## Exam Tips

1. **Read the questions carefully**: Make sure you understand what is being asked before proceeding.
2. **Always verify your work**: After creating a resource, check that it was created correctly.
3. **Use kubectl explain**: When you're unsure about the structure of a resource, use `kubectl explain` to view its fields.
4. **Leverage kubectl shortcuts**:
   - `po` for pods
   - `deploy` for deployments
   - `svc` for services
   - `ns` for namespaces
5. **Use kubectl imperative commands**: They can save time for simple resource creation.
6. **Don't get stuck**: If you encounter a challenging question, flag it and come back later.
7. **Practice time management**: The CKA exam is time-constrained, so work efficiently.

## What's Next

In the next and final part, we'll cover final preparation tips to ensure you're fully ready for the CKA exam, including:
- Exam day strategy
- Time management tips
- Documentation bookmarks
- Last-minute revision checklist
- Post-exam procedures

👉 Continue to **[Part 10: Final Preparation Tips](/training/cka-prep/10-final-preparation-tips/)**
