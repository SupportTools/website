---
title: "Install Kubernetes Dashboard"  
date: 2024-09-16T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "Dashboard", "Installation", "Cluster Management"]  
categories:  
- Kubernetes  
- Dashboard  
- Cluster Management  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to install the Kubernetes Dashboard to monitor and manage your cluster resources."  
more_link: "yes"  
url: "/install-kubernetes-dashboard/"  
---

The Kubernetes Dashboard is a web-based user interface that allows you to manage and monitor your Kubernetes cluster. It provides a simplified way to view your cluster’s resources, troubleshoot issues, and perform basic management tasks. In this guide, we’ll walk you through how to install the Kubernetes Dashboard and configure access to it.

<!--more-->

### Why Use the Kubernetes Dashboard?

While `kubectl` is a powerful command-line tool, the Kubernetes Dashboard makes it easier to:

- Visualize your cluster’s status and resources.
- Deploy and manage applications.
- Monitor performance and resource utilization.
- Troubleshoot problems using logs and resource events.

### Step 1: Deploy the Kubernetes Dashboard

The Kubernetes Dashboard is an official open-source project that can be installed via YAML manifests. To deploy the Dashboard, use the following command:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/dashboard/v2.6.0/aio/deploy/recommended.yaml
```

This will download and deploy the necessary resources, such as the dashboard’s service, deployment, and related configuration.

### Step 2: Create an Admin User

To access the Dashboard, you’ll need to create an admin user and a ServiceAccount with the necessary permissions.

1. Create a YAML file to define the admin ServiceAccount and ClusterRoleBinding:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: admin-user
  namespace: kubernetes-dashboard
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: admin-user-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: admin-user
  namespace: kubernetes-dashboard
```

2. Apply the YAML file to create the admin account:

```bash
kubectl apply -f admin-user.yaml
```

### Step 3: Get an Authentication Token

To log into the Kubernetes Dashboard, you’ll need an authentication token. Run the following command to get the token for the `admin-user` you just created:

```bash
kubectl -n kubernetes-dashboard describe secret $(kubectl -n kubernetes-dashboard get secret | grep admin-user | awk '{print $1}')
```

Copy the token from the output. You’ll need this token when logging into the Dashboard.

### Step 4: Access the Dashboard

By default, the Kubernetes Dashboard is exposed only within the cluster. To access it from your local machine, you can use `kubectl proxy`.

Run the following command:

```bash
kubectl proxy
```

Once the proxy is running, you can access the Kubernetes Dashboard at:

```plaintext
http://localhost:8001/api/v1/namespaces/kubernetes-dashboard/services/https:kubernetes-dashboard:/proxy/
```

Enter the token from Step 3 when prompted for authentication.

### Step 5: Enable External Access (Optional)

If you need to access the Dashboard externally (without using `kubectl proxy`), you can expose it using a LoadBalancer or NodePort. However, be cautious when enabling external access, as it can expose your cluster to security risks.

Here’s an example of exposing the Dashboard with a NodePort:

1. Edit the Kubernetes Dashboard service to change the type to `NodePort`:

```bash
kubectl -n kubernetes-dashboard edit svc kubernetes-dashboard
```

2. Change the service type from `ClusterIP` to `NodePort`:

```yaml
spec:
  type: NodePort
```

3. Save the file and find the assigned port:

```bash
kubectl -n kubernetes-dashboard get svc kubernetes-dashboard
```

You can now access the Dashboard by visiting `https://<node-ip>:<node-port>`, but ensure that your cluster security is properly configured.

### Final Thoughts

The Kubernetes Dashboard is a valuable tool for managing your cluster and monitoring its resources in real-time. With the ability to visualize workloads, manage configurations, and review logs, it simplifies day-to-day Kubernetes operations. By following this guide, you can easily install and start using the Dashboard to manage your Kubernetes environment.
