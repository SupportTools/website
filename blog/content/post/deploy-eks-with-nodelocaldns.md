---
title: "Deploying an EKS Cluster with NodeLocal DNSCache"
date: 2023-05-10T17:03:00-06:00
draft: false
tags: ["Amazon EKS", "Kubernetes", "NodeLocal DNSCache", "Terraform"]
categories:
- Amazon EKS
- Kubernetes
- NodeLocal DNSCache
- Terraform
author: "Matthew Mattox - mmattox@support.tools"
description: "A step-by-step guide on deploying an Amazon EKS cluster with NodeLocal DNSCache enabled using Terraform."
more_link: "yes"
---

In today's cloud-native world, Kubernetes has emerged as the de facto standard for container orchestration, providing a robust and extensible platform for managing containerized applications. Amazon Elastic Kubernetes Service (EKS) is a managed Kubernetes service that simplifies the deployment, management, and scaling of Kubernetes clusters on the AWS cloud.

This blog post will walk you through deploying an EKS cluster with NodeLocal DNSCache enabled using Terraform. NodeLocal DNSCache is a Kubernetes feature that improves the performance of DNS queries within a cluster by caching DNS responses on each node.

<!--more-->

## [Benefits of NodeLocal DNSCache](#benefits)

- Reduces latency for DNS queries from pods, resulting in improved application performance.
- Decreases load on cluster DNS services, improving overall cluster stability and scalability.
- Provides better resilience against DNS service failures, ensuring your applications continue functioning even during partial DNS outages.

## [Getting Started](#getting-started)

To deploy an EKS cluster with NodeLocal DNSCache, you'll need the following prerequisites:

- AWS CLI
- kubectl
- eksctl
- Terraform
- An AWS account with permissions to create an EKS cluster, VPC, and IAM roles. (An administrator account is recommended.)

Follow the setup steps in the example below to clone the repository, create the EKS cluster, configure `kubectl,` deploy the `node-local-dns` Helm chart, and verify that the `node-local-dns` pod is running.

## [Deploy](#deploy)

- Clone the repository.

```bash
git clone https://github.com/deliveryhero/helm-charts/tree/master/stable/node-local-dns
cd aws/eks/nodelocaldns
```

- Create the EKS cluster.

```bash
terraform init
terraform apply
```

- Get the `kubeconfig` file for your cluster.

```bash
aws eks update-kubeconfig --name <cluster-name>
```

- Verify that the `node-local-dns` pod is running by running the following command:

```bash
kubectl get pods -n kube-system | grep node-local-dns
```

## [Best Practices](#best-practices)

- Always use the latest NodeLocal DNSCache Helm chart version to benefit from bug fixes and enhancements.
- Monitor the performance of your cluster's DNS services using monitoring tools like Amazon CloudWatch, Prometheus, or Grafana to ensure optimal performance and identify potential issues.
- Regularly review and update your cluster's DNS configuration to keep it in line with best practices and to accommodate changes in your applications and infrastructure.

## [Conclusion](#conclusion)

Deploying an EKS cluster with NodeLocal DNSCache enabled can provide significant performance benefits for your containerized applications, particularly those with high rates of DNS queries. Following this step-by-step guide and implementing best practices, you can optimize your Kubernetes cluster for improved performance, stability, and resilience.

Remember to clean up resources after experimenting with your EKS cluster, as detailed in the example above. Don't forget to back up any critical data before running the `terraform destroy` command. This will delete the EKS cluster and all associated resources, including stored data.

For more information on NodeLocal DNSCache, EKS, Terraform, and Helm, refer to the links in the example above. And as always, happy deploying!
