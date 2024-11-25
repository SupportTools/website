---
title: "AWS Elastic Kubernetes Service (EKS) Review"
date: 2025-03-01T12:00:00-05:00
draft: false
tags: ["AWS", "Kubernetes", "EKS", "DevOps", "Cloud Infrastructure"]
categories:
- DevOps
- Cloud Computing
author: "Matthew Mattox - mmattox@support.tools"
description: "AWS EKS has evolved over the years, but is it the right choice for your Kubernetes needs? This review covers its history, strengths, and pain points."
more_link: "yes"
url: "/aws-elastic-kubernetes-service-review/"
---

**AWS Elastic Kubernetes Service (EKS): A Journey Through Its Evolution**

Since its introduction in 2017, AWS EKS has been a polarizing service for Kubernetes enthusiasts. From a rough launch to its current state, EKS has come a long way, but is it worth the effort for your Kubernetes workloads?

<!--more-->

---

## **A Bit of History**

EKS entered the scene as AWS’s response to Kubernetes’ growing popularity, competing against AWS ECS and the remnants of Docker Swarm. Initially, it lacked features, leading to skepticism about its usability. Over the years, EKS has matured, but its setup complexity still deters smaller organizations.

---

## **EKS Today**

While EKS has improved, it remains one of AWS's more hands-on services. Unlike products like RDS or Lambda, EKS requires significant upfront configuration and architectural decisions.

---

### **New Customer Experience**

Tools like [eksctl](https://eksctl.io) simplify cluster setup but don’t provide a fully functioning Kubernetes environment. Critical components like autoscaling, DNS, and storage drivers must be added manually, often overwhelming newcomers.

### **What You Need to Set Up**

Here’s a non-exhaustive list of essentials for an EKS cluster:
1. **Autoscaling**: Use [Karpenter](https://karpenter.sh/) over the older cluster autoscaler.
2. **DNS Services**: Necessary for external service resolution.
3. **Monitoring**: Set up [Prometheus and Grafana](https://prometheus.io/docs/introduction/overview/) for visibility.
4. **IAM and RBAC**: Understand how AWS IAM integrates with Kubernetes RBAC.
5. **Networking**: Install the [AWS CNI plugin](https://github.com/aws/amazon-vpc-cni-k8s).
6. **Storage**: Use the [EBS CSI driver](https://github.com/kubernetes-sigs/aws-ebs-csi-driver) for advanced storage features.
7. **Ingress and Load Balancers**: Deploy and configure an ingress controller (e.g., ALB, HAProxy).

---

## **Strengths and Weaknesses**

### **Strengths**
- **Control Plane Stability**: AWS manages the control plane, reducing operational risks.
- **IAM Integration**: Seamless authentication via AWS SSO simplifies cluster access.
- **Node AMI Management**: AWS provides regular AMI updates, reducing maintenance overhead.
- **Networking**: The AWS CNI plugin integrates directly with your VPC for simplified monitoring and security.

### **Weaknesses**
- **Setup Complexity**: Requires significant configuration before reaching production-readiness.
- **Storage Challenges**: EBS volume management can be slow and error-prone.
- **Ingress Costs**: AWS’s default approach to ingress and load balancers can lead to excessive costs unless carefully optimized.
- **Portability**: Despite Kubernetes’ promise of portability, AWS-specific features like IAM tightly couple EKS to the platform.

---

### **Networking Challenges**

EKS’s integration with AWS networking provides flexibility but requires careful planning:
- Monitor free IP addresses and ENIs to avoid scaling issues.
- Understand ENI limits per instance type ([reference](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-eni.html)).

---

### **Load Balancing and Ingress Issues**

AWS’s ingress setup defaults to creating a separate ALB for each service, which can lead to spiraling costs. A better alternative for cost-conscious teams is using [HAProxy](https://www.haproxy.com/).

---

## **Is It Worth It?**

### **For Large Organizations**
EKS excels in environments with dedicated Kubernetes expertise and the need for granular customization. Features like managed control planes, IAM integration, and regular node updates make it a reliable choice.

### **For Smaller Teams**
Smaller organizations or Kubernetes beginners may find EKS’s complexity overwhelming. Alternatives like [AWS Lightsail](https://lightsail.aws.amazon.com/) or [Elastic Beanstalk](https://aws.amazon.com/elasticbeanstalk/) may better suit their needs.

---

## **Final Thoughts**

EKS has matured significantly, but it’s not without its flaws. It’s ideal for teams already invested in AWS and Kubernetes, offering stability and flexibility for large-scale workloads. However, for those new to AWS or Kubernetes, the steep learning curve might outweigh its benefits.

---

**What’s your take on EKS? Let’s discuss! Reach out at [mmattox@support.tools](mailto:mmattox@support.tools).**
