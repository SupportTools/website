---
title: "Kubernetes Demystified: Build a Production-like Local Cluster with Vagrant"
date: 2024-10-29T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Vagrant", "DevOps", "Local Cluster"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to build a production-like local Kubernetes cluster using Vagrant and VirtualBox for hands-on practice."
more_link: "yes"
url: "/kubernetes-vagrant-local-cluster/"
---

Getting hands-on with **Kubernetes** is essential in the world of **DevOps**, but the complexity of setting up clusters can be daunting. In this post, we’ll simplify the process by using **Vagrant** to create a **local Kubernetes cluster**. This setup offers a practical way to explore Kubernetes concepts without the overhead of cloud infrastructure.

---

## Why a Local Kubernetes Cluster?  

Learning Kubernetes often requires hands-on practice to grasp concepts like **container orchestration** and **service management**. Using **Vagrant** with **VirtualBox** allows you to simulate a **multi-node cluster** on your local machine, perfect for testing, learning, and developing Kubernetes-based applications.

---

## Prerequisites  

Here’s what you’ll need to follow along:  
- **A laptop** with at least **16GB RAM and i5 CPU or higher**  
- **Vagrant** installed ([Install Vagrant](https://developer.hashicorp.com/vagrant/docs/installation))  
- **VirtualBox** installed for virtualization  
- A **stable internet connection**  
- **kubectl** and **kubeadm** for managing the cluster  

---

## Step 1: Install Vagrant  

Use the following commands to install Vagrant on a **Debian-based system**:

```bash
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install vagrant
```

Verify your installation:

```bash
vagrant --version
```

---

## Step 2: Create a Vagrantfile  

A **Vagrantfile** defines the configuration for your virtual machines (VMs). Below is a basic setup to create a **three-node Kubernetes cluster** (one master and two worker nodes):

```ruby
Vagrant.configure("2") do |config|
  config.vm.box = "bento/debian-12"

  config.vm.provider "virtualbox" do |vb|
    vb.memory = 2048
    vb.cpus = 2
  end

  config.vm.define "master" do |node|
    node.vm.hostname = "master"
    node.vm.network "private_network", ip: "192.168.56.10"
  end

  config.vm.define "node1" do |node|
    node.vm.hostname = "node1"
    node.vm.network "private_network", ip: "192.168.56.11"
  end

  config.vm.define "node2" do |node|
    node.vm.hostname = "node2"
    node.vm.network "private_network", ip: "192.168.56.12"
  end

  config.vm.provision "shell", path: "scripts/install-kubernetes.sh"
end
```

---

## Step 3: Provision the VMs and Install Kubernetes  

Inside the same directory as your **Vagrantfile**, create the `install-kubernetes.sh` script:

```bash
#!/bin/bash

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo swapoff -a  # Disable swap for Kubernetes
```

Now, bring up your VMs using the following command:

```bash
vagrant up
```

---

## Step 4: Initialize the Kubernetes Master Node  

SSH into the **master node**:

```bash
vagrant ssh master
```

Initialize the Kubernetes control plane:

```bash
sudo kubeadm init --apiserver-advertise-address=192.168.56.10 --pod-network-cidr=10.244.0.0/16
```

Copy the join command provided at the end of the initialization (it will look something like this):

```bash
kubeadm join 192.168.56.10:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>
```

---

## Step 5: Join Worker Nodes to the Cluster  

SSH into each worker node and run the **join command** copied from the master:

```bash
vagrant ssh node1
sudo kubeadm join 192.168.56.10:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>
```

Repeat the process for **node2**.

---

## Step 6: Verify the Cluster  

On the master node, verify that all nodes have joined the cluster:

```bash
kubectl get nodes
```

You should see output similar to:

```
NAME     STATUS   ROLES    AGE   VERSION
master   Ready    master   10m   v1.28.0
node1    Ready    <none>   5m    v1.28.0
node2    Ready    <none>   5m    v1.28.0
```

---

## Step 7: Deploy a Sample Application  

Create a simple **deployment and service** using the following YAML:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: demo
  template:
    metadata:
      labels:
        app: demo
    spec:
      containers:
      - name: demo-container
        image: nginx
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: demo-service
spec:
  selector:
    app: demo
  ports:
  - protocol: TCP
    port: 80
  type: NodePort
```

Apply the YAML:

```bash
kubectl apply -f demo-app.yaml
```

Check if the application is running:

```bash
kubectl get pods
```

---

## Step 8: Access the Application  

Find the **NodePort** assigned to the service:

```bash
kubectl get svc demo-service
```

Use the **IP address of any node** along with the NodePort to access the application from your browser:

```
http://192.168.56.11:<NodePort>
```

---

## Conclusion  

By following this guide, you’ve set up a **production-like Kubernetes cluster locally** using Vagrant. This setup provides a sandbox environment to explore Kubernetes without relying on cloud providers, perfect for developers and DevOps practitioners. From spinning up the cluster to deploying applications, you now have a foundational understanding of how Kubernetes works. 

Continue experimenting, try different networking setups, and deploy more complex applications to solidify your Kubernetes skills.
