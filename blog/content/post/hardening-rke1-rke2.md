---
title: "Hardening RKE1 and RKE2 in Rancher: A Comprehensive Training Guide"
date: 2024-05-08T04:30:00-05:00
draft: false
tags: ["Rancher", "Kubernetes", "Security"]
categories:
- Rancher
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to enhance the security of your Rancher-managed Kubernetes clusters with our detailed guide on hardening RKE1 and RKE2."
more_link: "yes"
---

With this expert-led training class, learn the essentials of securing RKE1 and RKE2 in your Rancher environments. From basic principles to advanced strategies, discover how to protect your Kubernetes clusters effectively.

<!--more-->
# [Introduction to RKE Hardening](#introduction-to-rke-hardening)

Security is paramount in managing Kubernetes clusters and hardening RKE1 and RKE2 is crucial to safeguarding your infrastructure. This training class offers a deep dive into the best practices and strategies for securing RKE-managed clusters.

## [What is Cluster Hardening?](#what-is-cluster-hardening)

Cluster hardening refers to the process of securing a cluster so that it is resilient against attacks and unauthorized access. This involves configuring the cluster's components and settings to minimize vulnerabilities and strengthen its defenses. Hardening aims to protect both the data and the services running in the cluster from internal or external threats.

## [Understanding the CIS Benchmark](#understanding-the-cis-benchmark)

The Center for Internet Security (CIS) provides globally recognized benchmarks as best practices for securing IT systems and data against cyber threats. The CIS Kubernetes Benchmark sets guidelines and recommendations for securing Kubernetes environments. Following these benchmarks helps ensure the deployment aligns with industry security standards, making the system robust against breaches and intrusions.

## [Understanding RKE Hardening Guides](#understanding-rke-hardening-guides)

This training aligns with the guidelines provided by the Center for Information Security (CIS) for Kubernetes. It includes configurations and controls required to meet the CIS Kubernetes benchmarks. Key benchmarks include:

- **Rancher v2.7 with Kubernetes v1.23 to v1.26**
- **CIS Benchmarks v1.23 to v1.7**, addressing changes and adaptations in practices over different Kubernetes versions.

## [Host-level Requirements for RKE1 and RKE2](#host-level-requirements-for-rke1-and-rke2)

Discuss the initial steps in securing node configuration:

- **Kernel Runtime Parameters**:

  ```bash
  vm.overcommit_memory=1
  vm.panic_on_oom=0
  kernel.panic=10
  kernel.panic_on_oops=1
  ```

  These settings help manage system resources and behavior in out-of-memory scenarios.

- **Creating etcd User and Group**:

  ```bash
  groupadd --gid 52034 etcd
  useradd --comment "etcd service account" --uid 52034 --gid 52034 etcd --shell /usr/sbin/nologin
  ```

  This secures the etcd database by running it under a specific user with limited permissions.

## [Kubernetes Runtime Requirements for RKE1 and RKE2](#kubernetes-runtime-requirements-for-rke1-and-rke2)

Critical configurations for Kubernetes runtime include:

- **Service Account Configuration**:

  ```bash
  kubectl patch serviceaccount default -n <namespace> -p '{"automountServiceAccountToken": false}'
  ```

  This prevents the default service account in each namespace from automatically receiving API access tokens, which can be a security risk.

- **Network Policy Enforcement**:
  Applying network policies is crucial for controlling traffic flow between pods, which can prevent potential attacks between co-located services.

## [RKE2 Specific Hardening](#rke2-specific-hardening)

RKE2 enhances security through several default configurations and requires specific interventions:

- **Host-Level Modifications**: Ensure the `etcd` user is created and configured correctly.
- **Kernel Parameter Settings**: Recommended sysctl settings for all nodes.
- **Pod Security and Network Policies**: How to configure and apply these policies using RKE2's CIS profiles.

## [Advanced RKE Configurations](#advanced-rke-configurations)

- **Secure etcd and API Server**: Configuration changes like enabling secrets encryption and audit logging in the `cluster.yml` file.
- **Admission and Pod Security Policies**: Setting up restricted environments to enforce security at the pod level.

## [Scripting and Automation for RKE1 and RKE2](#scripting-and-automation-for-rke1-and-rke2)

Utilize scripts to automate the application of security settings across your clusters. Example scripts include network policy applications and service account updates.

## [Practical Tips](#qa-and-practical-tips)

- **Review Rancher's Hardening Guides**: Before upgrading a cluster, you must review the hardening guides for the specific version of Rancher and Kubernetes you are using. As settings, flags, and configurations can change between k8s versions. You may need to adjust your hardening configurations accordingly before upgrading.
- **Regular Audits**: Conduct regular security audits to identify vulnerabilities and ensure compliance with best practices.
- **Monitoring and Logging**: Implement monitoring and logging solutions to promptly detect and respond to security incidents.
- **Training and Awareness**: Educate your team on security best practices and ensure they know the risks and threats to your clusters.

### [Additional Resources](#additional-resources)

Gain further insights with links to detailed documentation, community resources, and helpful tools to streamline the hardening process.

- [RKE1 Hardening Guide](https://ranchermanager.docs.rancher.com/reference-guides/rancher-security/hardening-guides/rke1-hardening-guide)
- [RKE2 Hardening Guide](https://ranchermanager.docs.rancher.com/reference-guides/rancher-security/hardening-guides/rke2-hardening-guide)

We hope you find this training invaluable for enhancing the security of your Rancher deployments. Stay tuned for more insights and tips from our expert team.
