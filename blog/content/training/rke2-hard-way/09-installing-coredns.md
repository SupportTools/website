---
title: "RKE2 the Hard Way: Part 9 – Installing CoreDNS"
description: "Installing and configuring CoreDNS for Kubernetes cluster DNS resolution."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 9
draft: false
tags: ["kubernetes", "rke2", "coredns", "dns"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 9 of RKE2 the Hard Way, we install and configure CoreDNS to provide DNS resolution within our Kubernetes cluster."
more_link: ""
---

## Part 9 – Installing CoreDNS

In this part of the **"RKE2 the Hard Way"** training series, we will install and configure **CoreDNS** for Kubernetes cluster DNS resolution. CoreDNS is a flexible, extensible DNS server that serves as the cluster DNS provider in Kubernetes, allowing service discovery by DNS name.

DNS resolution is critical in a Kubernetes cluster because:
- It enables services to be discovered by their names rather than IP addresses
- It allows pods to find and communicate with other pods and services
- It provides a stable naming scheme even when IPs change due to pod rescheduling

> ✅ **Note:** We already configured kubelet in [Part 7](/training/rke2-hard-way/07-setting-up-kubelet-and-kube-proxy/) to use 10.43.0.10 as the DNS server, which is the IP we'll use for the CoreDNS service.

---

### 1. Prepare the CoreDNS Manifest

First, let's create a YAML manifest for CoreDNS:

```bash
cat > coredns.yaml << EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: coredns
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: system:coredns
rules:
- apiGroups: [""]
  resources:
  - endpoints
  - services
  - pods
  - namespaces
  verbs:
  - list
  - watch
- apiGroups: ["discovery.k8s.io"]
  resources:
  - endpointslices
  verbs:
  - list
  - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system:coredns
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:coredns
subjects:
- kind: ServiceAccount
  name: coredns
  namespace: kube-system
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
            lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf {
            max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
  labels:
    k8s-app: kube-dns
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  selector:
    matchLabels:
      k8s-app: kube-dns
  template:
    metadata:
      labels:
        k8s-app: kube-dns
    spec:
      priorityClassName: system-cluster-critical
      serviceAccountName: coredns
      tolerations:
      - key: CriticalAddonsOnly
        operator: Exists
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      - key: node-role.kubernetes.io/master
        operator: Exists
        effect: NoSchedule
      containers:
      - name: coredns
        image: registry.k8s.io/coredns/coredns:v1.10.1
        imagePullPolicy: IfNotPresent
        resources:
          limits:
            memory: 170Mi
          requests:
            cpu: 100m
            memory: 70Mi
        args: [ "-conf", "/etc/coredns/Corefile" ]
        volumeMounts:
        - name: config-volume
          mountPath: /etc/coredns
          readOnly: true
        ports:
        - containerPort: 53
          name: dns
          protocol: UDP
        - containerPort: 53
          name: dns-tcp
          protocol: TCP
        - containerPort: 9153
          name: metrics
          protocol: TCP
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            add:
            - NET_BIND_SERVICE
            drop:
            - all
          readOnlyRootFilesystem: true
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
            scheme: HTTP
          initialDelaySeconds: 60
          timeoutSeconds: 5
          successThreshold: 1
          failureThreshold: 5
        readinessProbe:
          httpGet:
            path: /ready
            port: 8181
            scheme: HTTP
      volumes:
      - name: config-volume
        configMap:
          name: coredns
          items:
          - key: Corefile
            path: Corefile
      dnsPolicy: Default
---
apiVersion: v1
kind: Service
metadata:
  name: kube-dns
  namespace: kube-system
  annotations:
    prometheus.io/port: "9153"
    prometheus.io/scrape: "true"
  labels:
    k8s-app: kube-dns
    kubernetes.io/cluster-service: "true"
    kubernetes.io/name: "CoreDNS"
spec:
  selector:
    k8s-app: kube-dns
  clusterIP: 10.43.0.10
  ports:
  - name: dns
    port: 53
    protocol: UDP
  - name: dns-tcp
    port: 53
    protocol: TCP
  - name: metrics
    port: 9153
    protocol: TCP
EOF
```

This manifest:
- Creates a ServiceAccount for CoreDNS
- Sets up necessary RBAC permissions
- Creates a ConfigMap with the CoreDNS configuration
- Deploys CoreDNS as a Deployment with 2 replicas for high availability
- Creates a Service named kube-dns with the IP address 10.43.0.10

---

### 2. Apply the CoreDNS Manifest

Now, apply the CoreDNS manifest to your cluster:

```bash
kubectl apply -f coredns.yaml
```

---

### 3. Verify CoreDNS Deployment

Check that the CoreDNS pods are running successfully:

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

You should see output similar to:

```
NAME                      READY   STATUS    RESTARTS   AGE
coredns-xxxxxxxx-xxxxx    1/1     Running   0          1m
coredns-xxxxxxxx-yyyyy    1/1     Running   0          1m
```

Also, verify that the CoreDNS service is created with the correct cluster IP:

```bash
kubectl get svc -n kube-system kube-dns
```

You should see output similar to:

```
NAME       TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)                  AGE
kube-dns   ClusterIP   10.43.0.10     <none>        53/UDP,53/TCP,9153/TCP   1m
```

---

### 4. Test DNS Resolution

Let's test if DNS resolution is working properly by creating a test pod and trying to resolve some domains:

```bash
# Create a test pod
kubectl run dns-test --image=busybox:1.28 -- sleep 3600

# Wait for the pod to be ready
kubectl wait --for=condition=Ready pod/dns-test

# Test DNS resolution for kubernetes.default service
kubectl exec -it dns-test -- nslookup kubernetes.default

# Test DNS resolution for an external domain
kubectl exec -it dns-test -- nslookup google.com
```

If DNS is working correctly, you should get successful responses from both nslookup commands.

For the kubernetes.default service, you should see something similar to:

```
Server:    10.43.0.10
Address 1: 10.43.0.10 kube-dns.kube-system.svc.cluster.local

Name:      kubernetes.default
Address 1: 10.43.0.1 kubernetes.default.svc.cluster.local
```

For google.com, you should get its actual IP addresses.

---

### 5. Clean Up Test Resources

After successful testing, clean up the test pod:

```bash
kubectl delete pod dns-test
```

---

## Next Steps

Now that we have CoreDNS running for cluster DNS resolution, we'll proceed to **Part 10** where we'll set up **NGINX Ingress Controller** to enable external access to our cluster's services.

👉 Continue to **[Part 10: Installing Ingress Nginx](/training/rke2-hard-way/10-installing-ingress-nginx/)**
