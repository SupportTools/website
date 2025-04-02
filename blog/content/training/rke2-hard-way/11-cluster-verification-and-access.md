---
title: "RKE2 the Hard Way: Part 11 – Cluster Verification and Access"
description: "Verifying the Kubernetes cluster setup and ensuring it's fully operational."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 11
draft: false
tags: ["kubernetes", "rke2", "verification", "kubectl"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In the final part of RKE2 the Hard Way, we verify our Kubernetes cluster is fully operational and set up kubectl for remote access."
more_link: ""
---

## Part 11 – Cluster Verification and Access

Congratulations! You've reached the final part of the **"RKE2 the Hard Way"** training series. At this point, we have:

- Set up containerd and kubelet on all nodes
- Generated all the necessary TLS certificates
- Deployed etcd, kube-apiserver, kube-controller-manager, and kube-scheduler as static pods
- Configured kubelet and kube-proxy on worker nodes
- Installed Cilium CNI for pod networking
- Deployed CoreDNS for cluster DNS resolution
- Installed Ingress Nginx for external access

Now, let's verify that everything is working correctly and set up kubectl for convenient cluster access.

---

### 1. Verify Cluster Components

First, let's check the status of all cluster components:

```bash
kubectl get componentstatuses
```

You should see output similar to:

```
NAME                 STATUS    MESSAGE             ERROR
scheduler            Healthy   ok                  
controller-manager   Healthy   ok                  
etcd-0               Healthy   {"health":"true"}   
etcd-1               Healthy   {"health":"true"}   
etcd-2               Healthy   {"health":"true"}   
```

---

### 2. Verify Node Status

Next, check the status of all nodes in your cluster:

```bash
kubectl get nodes
```

You should see all three nodes in `Ready` status:

```
NAME     STATUS   ROLES    AGE     VERSION
node01   Ready    <none>   1h      v1.27.6
node02   Ready    <none>   1h      v1.27.6
node03   Ready    <none>   1h      v1.27.6
```

---

### 3. Verify System Pods

Check that all system pods are running:

```bash
kubectl get pods -n kube-system
```

You should see pods for:
- etcd
- kube-apiserver
- kube-controller-manager
- kube-scheduler
- kube-proxy
- cilium
- coredns

All pods should be in the `Running` state, and most should show `1/1` for the READY column (indicating all containers in those pods are running).

---

### 4. Test Pod Creation

Let's deploy a simple pod to verify that the core functionality is working:

```bash
kubectl run nginx --image=nginx
```

Wait a moment, then check if the pod is running:

```bash
kubectl get pod nginx
```

You should see:

```
NAME    READY   STATUS    RESTARTS   AGE
nginx   1/1     Running   0          30s
```

---

### 5. Test Pod Networking

Verify that pod networking works by creating a service and accessing it from another pod:

```bash
# Expose the nginx pod as a service
kubectl expose pod nginx --port=80 --name=nginx-service

# Create a temporary debugging pod
kubectl run busybox --image=busybox:1.28 -- sleep 3600

# Wait for it to be ready
kubectl wait --for=condition=Ready pod/busybox

# Test accessing the nginx service from the busybox pod
kubectl exec -it busybox -- wget -O- nginx-service
```

If you see HTML output from nginx, pod-to-pod networking is working correctly.

---

### 6. Test DNS Resolution

Verify that CoreDNS is functioning correctly:

```bash
# Try to resolve the nginx service
kubectl exec -it busybox -- nslookup nginx-service

# Try to resolve kubernetes.default
kubectl exec -it busybox -- nslookup kubernetes.default

# Try to resolve an external domain
kubectl exec -it busybox -- nslookup google.com
```

You should get successful DNS resolution for all these queries.

---

### 7. Test External Access via Ingress

Let's create an Ingress resource to expose our nginx pod to the outside world:

```bash
# Create an ingress resource
cat > nginx-ingress.yaml << EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nginx-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: nginx.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: nginx-service
            port:
              number: 80
EOF

kubectl apply -f nginx-ingress.yaml
```

To test this, you would need to:
1. Add `nginx.example.com` to your local /etc/hosts file, pointing to the IP of one of your nodes
2. Access http://nginx.example.com in your browser or via curl

---

### 8. Set Up Remote kubectl Access

To access your cluster from your workstation, you need to create a kubeconfig file:

```bash
# On your control plane node, back up your admin.kubeconfig
cp ~/.kube/config admin.kubeconfig

# Create a version with embedded certificates
kubectl config view --raw > admin-with-embedded-certs.kubeconfig
```

Transfer this file to your workstation and place it at `~/.kube/config` (or use the `KUBECONFIG` environment variable to specify its location).

---

### 9. Clean Up Test Resources

Let's clean up the test resources:

```bash
kubectl delete ingress nginx-ingress
kubectl delete service nginx-service
kubectl delete pod nginx
kubectl delete pod busybox
```

---

## Conclusion

Congratulations! You have successfully built a fully functional Kubernetes cluster from scratch, the hard way! This journey has given you a deep understanding of how Kubernetes components fit together and how they interact.

What you've accomplished:
- Built a high-availability Kubernetes cluster using the same architecture as RKE2
- Run control plane components as static pods managed by kubelet
- Configured networking, DNS, and ingress to make the cluster fully operational
- Gained hands-on experience with each Kubernetes component

This knowledge will be invaluable whether you're troubleshooting issues, architecting solutions, or simply wanting to understand what happens under the hood of Kubernetes distributions like RKE2.

Remember: the true power of Kubernetes distributions like RKE2 is that they automate much of what we've done manually in this tutorial, while still using the same underlying architecture. Having gone through this exercise, you now understand what's happening when you run a simple `rke2 server` command!

---

Thank you for following along with the **"RKE2 the Hard Way"** tutorial series!
