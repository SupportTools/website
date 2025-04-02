---
title: "RKE2 the Hard Way: Part 10 - Cluster Verification and Access"
description: "Verifying the Kubernetes cluster setup and accessing applications via Ingress-Nginx."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 10
---

## Part 10 - Cluster Verification and Access

Congratulations! You have reached the final part of the "RKE2 the Hard Way" training series. In this part, we will verify the Kubernetes cluster setup and test external access to applications via Ingress-Nginx.

### 1. Configure kubectl Access

To interact with your newly built cluster using `kubectl` from your workstation, you need to configure `kubectl` to connect to the API server.  We will create a kubeconfig file using the admin client certificate generated in Part 2.

Create a directory for kubeconfig on your workstation:

```bash
mkdir ~/.kube
```

Create a file named `config` in `~/.kube/` with the following content. **Replace the placeholders with the actual IP address of one of your control plane nodes (e.g., node1's private IP) and the paths to your `admin.pem` and `admin-key.pem` files (these are on your workstation from Part 2).**

```yaml
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority: /path/to/your/ca/certs/ca.pem  # Replace with path to your ca.pem
    server: https://<NODE1_PRIVATE_IP>:6443  # Replace with your node1 IP
  name: kubernetes
contexts:
- context:
    cluster: kubernetes
    user: admin
  name: admin-context
current-context: admin-context
users:
- name: admin
  user:
    client-certificate: /path/to/your/ca/certs/admin.pem  # Replace with path to your admin.pem
    client-key: /path/to/your/ca/certs/admin-key.pem      # Replace with path to your admin-key.pem
```

**Replace the file paths and `<NODE1_PRIVATE_IP>` placeholder with your actual values.**

Set the `KUBECONFIG` environment variable to point to this config file (optional, but recommended):

```bash
export KUBECONFIG=~/.kube/config
```

### 2. Verify Cluster Component Status

Use `kubectl` to check the status of the cluster components:

```bash
kubectl get componentstatuses
```

You should see output similar to this, with all components showing a `Healthy` status:

```
NAME                 STATUS      MESSAGE                         ERROR
controller-manager   Healthy     ok                               
etcd-0               Healthy     {"health":"true"}                  
scheduler            Healthy     ok                               
```

If any component shows `Unhealthy`, review the logs of that component (e.g., `journalctl -u kube-apiserver -f` on the control plane nodes) and troubleshoot accordingly.

### 3. Verify Node Status

Check the status of the nodes in your cluster:

```bash
kubectl get nodes
```

You should see all three nodes in `Ready` status:

```
NAME    STATUS   ROLES           AGE   VERSION
node1   Ready    control-plane,worker   20m   v1.29.2
node2   Ready    control-plane,worker   20m   v1.29.2
node3   Ready    control-plane,worker   20m   v1.29.2
```

If any node is `NotReady`, check the kubelet logs on that node (`journalctl -u kubelet -f`) and troubleshoot network connectivity and kubelet configuration.

### 4. Test DNS Resolution

Verify that CoreDNS is functioning correctly by testing DNS resolution within the cluster.  Run a test pod that uses `nslookup` to resolve the Kubernetes service name:

```bash
kubectl run dns-test --image=infoblox/dnstools --command -- nslookup kubernetes.default
```

Check the logs of the `dns-test` pod:

```bash
kubectl logs dns-test
```

You should see output indicating successful DNS resolution of `kubernetes.default` to the cluster IP (e.g., `10.96.0.1`):

```
Server:         10.96.0.10
Address:        10.96.0.10#53

Name:   kubernetes.default.svc.cluster.local
Address: 10.96.0.1
```

Delete the test pod:

```bash
kubectl delete pod dns-test
```

### 5. Deploy a Test Application via Ingress-Nginx

To test external access via Ingress-Nginx, we will deploy a simple Nginx application and expose it using an Ingress resource.

Create a deployment:

```bash
kubectl create deployment test-app --image=nginx
```

Create a service to expose the deployment:

```bash
kubectl expose deployment test-app --port=80 --target-port=80 --type=ClusterIP
```

Create an Ingress resource to expose the service externally. Create a file named `test-ingress.yaml` with the following content:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: test-ingress
  namespace: default
spec:
  rules:
  - host: test.example.com # Replace with your test hostname
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: test-app
            port:
              number: 80
```

**Replace `test.example.com` with a hostname you will use for testing. You will need to configure this hostname to resolve to the IP address of one of your nodes (e.g., in your `/etc/hosts` file or in your DNS server for testing purposes).**

Apply the Ingress resource:

```bash
kubectl apply -f test-ingress.yaml
```

### 6. Access the Application via Ingress

Access the test application by browsing to `http://test.example.com` in your web browser.  Ensure that the hostname `test.example.com` resolves to the IP address of one of your Kubernetes nodes.

You should see the default Nginx welcome page, indicating that Ingress-Nginx is correctly routing external traffic to your service.

**Congratulations!** You have successfully built a functional Kubernetes cluster from scratch, the "hard way," with features similar to RKE2, including a three-node etcd cluster, all nodes with all roles, Cilium CNI, CoreDNS, and Ingress-Nginx.

This completes the "RKE2 the Hard Way" training series. You now have a deep understanding of the components and steps involved in building a Kubernetes cluster manually.  You can use this knowledge to troubleshoot issues, customize your cluster, and appreciate the abstractions provided by distributions like RKE2.
