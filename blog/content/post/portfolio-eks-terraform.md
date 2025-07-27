---
title: "Deploying an EKS Cluster Using Terraform"
date: 2023-06-10T19:26:00-05:00
draft: false
tags: ["AWS", "EKS", "Terraform"]
categories:
- Portfolio
- AWS
- EKS
- Terraform
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed guide on deploying an EKS cluster using Terraform."
more_link: "yes"
---

In this guide, we will walk through deploying an Amazon Elastic Kubernetes Service (EKS) cluster using Terraform, an Infrastructure as Code (IaC) tool that helps manage and provision cloud resources efficiently.

<!--more-->

# [Prerequisites](#prerequisites)
Before you get started, make sure that you have the following prerequisites in place:
- An AWS account with necessary permissions
- AWS CLI and Terraform installed and configured on your machine
- Familiarity with AWS, EKS, and Terraform

# [Steps to Deploy an EKS Cluster](#steps-to-deploy-an-eks-cluster)
Let's begin with the deployment of an EKS cluster.

## Step 1: Setup Terraform Scripts
First, we need to setup our Terraform scripts. These scripts will help us manage the resources required for our EKS cluster.

Create a new directory for our Terraform scripts and navigate into it.

```shell
mkdir terraform-eks && cd terraform-eks
```

Now, create a new Terraform file named `main.tf` with the following content:

```hcl
provider "aws" {
  region = "us-west-2" // Update to your preferred region
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "17.1.0" // Check for the latest version

  cluster_name    = "my-eks-cluster"
  cluster_version = "1.20"
  subnets         = ["subnet-abcde012", "subnet-bcde012a", "subnet-fghi345a"]
  vpc_id          = "vpc-abcde012"

  node_groups = {
    eks_nodes = {
      desired_capacity = 2
      max_capacity     = 10
      min_capacity     = 1

      instance_type = "m5.large"
      key_name      = "my-key-name"
    }
  }
}
```

Please replace `"subnet-abcde012", "subnet-bcde012a", "subnet-fghi345a"` and `"vpc-abcde012"` with your actual VPC and Subnets IDs.

## Step 2: Initialize Terraform
It's time to initialize our Terraform project. This will download the necessary provider plugins for Terraform.

```shell
terraform init
```

## Step 3: Apply the Terraform Script
Now, let's apply our Terraform script, which will create the EKS cluster in AWS.

```shell
terraform apply
```

After running the command, Terraform will show the actions it will perform. Confirm by typing `yes`.

# [Conclusion](#conclusion)
Congratulations! You've successfully deployed an EKS cluster on AWS using Terraform. Now you can deploy your applications on your EKS cluster and take advantage of Kubernetes' capabilities for your cloud applications.
