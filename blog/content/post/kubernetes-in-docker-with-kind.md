---
title: "Effortless Kubernetes Development: Running Kubernetes in Docker with Kind"
date: 2025-05-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Docker", "Kind", "Development", "Local Cluster"]
categories:
  - Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to quickly set up a local Kubernetes cluster using Kind (Kubernetes IN Docker) for development, testing, and experimentation."
more_link: "yes"
url: "/kubernetes-in-docker-with-kind/"
---

Discover how to use Kind to create lightweight Kubernetes clusters within Docker containers for streamlined local development.

<!--more-->

# Kubernetes in Docker: A Quick Start with Kind

## Section 1: Introduction to Kind

Kind (Kubernetes IN Docker) is a powerful tool for running local Kubernetes clusters using Docker containers. Originally designed for testing Kubernetes itself, Kind is perfect for local development, experimentation, and CI/CD pipelines. It allows you to quickly spin up and tear down Kubernetes clusters on your local machine, making it ideal for rapid prototyping and testing.

## Section 2: Prerequisites

Before you begin, ensure you have the following prerequisites:

*   **Docker:** Docker must be installed and running on your local machine.  You can download Docker Desktop from the official Docker website.
*   **Kind:** Install the Kind binaries. Follow the installation instructions on the official Kind website ([https://kind.sigs.k8s.io/](https://kind.sigs.k8s.io/)). Ensure you have the `kind` command available in your terminal.
*   **kubectl:** Ensure you have the `kubectl` command installed.

## Section 3: Deploying a Kubernetes Cluster with Kind

Let's deploy a Kubernetes cluster with one control plane node and three worker nodes.

1.  **Create a Cluster Configuration File:** Create a file named `kind_cluster_config.yaml` with the following content:

    ```yaml
    kind: Cluster
    apiVersion: kind.x-k8s.io/v1alpha4
    nodes:
      - role: control-plane
        extraPortMappings:
          - hostPort: 30080
            containerPort: 30080
      - role: worker
      - role: worker
      - role: worker
    ```

    This configuration defines a cluster with a control plane node that maps port 30080 on the host to port 30080 on the container, and three worker nodes.

2.  **Create the Kubernetes Cluster:** Run the following command to create a cluster named `cluster-1`:

    ```bash
    kind create cluster --image kindest/node:v1.28.0 --name cluster-1 --config kind_cluster_config.yaml
    ```

    *Note: I updated the image version to v1.28.0.*

    This command creates the Kubernetes cluster using the specified configuration file and image. The process may take a few minutes.

3.  **Verify the Cluster:** Once the cluster creation is complete, set the Kubernetes context to interact with the cluster:

    ```bash
    kubectl cluster-info --context kind-cluster-1
    kubectl get nodes
    kubectl get pods -n kube-system
    ```

    These commands display information about the cluster, list the nodes, and show the pods running in the `kube-system` namespace. You can also verify that all Kubernetes nodes are running in Docker containers by running `docker ps`.

## Section 4: Deploying an Application on the Kind Cluster

Now, let's deploy a simple application on the Kind cluster.

1.  **Create an Application Deployment File:** Create a file named `app.yaml` with the following content:

    ```yaml
    ---
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: hello-k8s-deployment
      labels:
        app: hello-k8s
    spec:
      replicas: 3
      selector:
        matchLabels:
          app: hello-k8s
    template:
      metadata:
        name: hello-k8s-pod
        labels:
          app: hello-k8s
      spec:
        containers:
          - name: node-hello
            image: gcr.io/google-samples/node-hello:1.0
            ports:
              - containerPort: 8080
    ---
    apiVersion: v1
    kind: Service
    metadata:
      name: hello-k8s-service
      labels:
        app: hello-k8s
    spec:
      type: NodePort
      ports:
        - name: hello-k8s-service
          port: 8080
          targetPort: 8080
          nodePort: 30080
      selector:
        app: hello-k8s
    ```

    This file defines a deployment with three replicas and a NodePort service that exposes the application on port 30080.

2.  **Deploy the Application:**

    ```bash
    kubectl create ns hello-k8s
    kubectl -n hello-k8s apply -f app.yaml
    kubectl -n hello-k8s get all
    ```

    These commands create a new namespace, deploy the application using the `app.yaml` file, and list all the resources in the `hello-k8s` namespace.

3.  **Access the Application:** You can access the application in your browser or via `curl`:

    ```bash
    curl http://localhost:30080
    ```

## Section 5: Conclusion

Kind provides a simple and efficient way to run Kubernetes clusters locally, making it a valuable tool for development, testing, and experimentation. Its lightweight nature and ease of use make it an excellent alternative to other local Kubernetes solutions. Give Kind a try and streamline your Kubernetes development workflow!
