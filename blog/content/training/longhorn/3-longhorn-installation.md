---
title: "Installing Longhorn: A Comprehensive Guide"
date: 2025-01-09T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Installation"]
categories:
- Longhorn
- Kubernetes
- Installation
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn the various ways to install Longhorn, including Rancher Apps & Marketplace, Helm, and kubectl, with step-by-step instructions."
more_link: "yes"
url: "/training/longhorn/installation/"
---

In this section of the **Longhorn Basics** course, we explore the different ways to install Longhorn, Rancher's cloud-native distributed block storage solution for Kubernetes.

<!--more-->

# Installation Guide for Longhorn

## Course Agenda

There are three primary methods to install Longhorn:

1. **Rancher Apps & Marketplace**
2. **Helm**
3. **kubectl**

---

## Rancher Apps & Marketplace

The Rancher Apps & Marketplace provides the easiest way to install Longhorn. However, it requires Rancher to be set up in your environment.

### Installation Steps

1. Navigate to the **Apps & Marketplace** section in Rancher.
2. Search for **Longhorn**.
3. Click on **Install**.
4. Use the default values (sufficient for most cases) or customize them as needed.
5. Click on **Install**.

Wait for the installation to complete. Rancher will handle the entire process for you.

---

## Helm

Helm offers a highly flexible way to install Longhorn, ideal for environments where customization is needed.

### Installation Steps

1. Create a `values.yaml` file with your desired configuration.
2. Add the Longhorn Helm repository:
   ```bash
   helm repo add longhorn https://charts.longhorn.io
   helm repo update
   ```
3. Install Longhorn using Helm:
   ```bash
   helm install longhorn longhorn/longhorn --namespace longhorn-system --create-namespace --version 1.5.3
   ```

Wait for the installation to complete and verify it:
```bash
kubectl -n longhorn-system get pod -w
```

---

## kubectl

Installing Longhorn with `kubectl` is straightforward but requires familiarity with Kubernetes manifests and Longhorn configuration if customization is needed.

### Installation Steps

1. Apply the Longhorn manifests:
   ```bash
   kubectl apply -f https://raw.githubusercontent.com/longhorn/longhorn/v1.5.3/deploy/longhorn.yaml
   ```

Wait for the installation to complete and verify it:
```bash
kubectl -n longhorn-system get pod -w
```

---

## Lab Instructions: Installing Longhorn with Helm

In this lab, we will install Longhorn using Helm.

### Steps

1. **Set Up Helm Repository**:
   ```bash
   helm repo add longhorn https://charts.longhorn.io
   helm repo update
   ```

2. **Install Longhorn**:
   ```bash
   helm install longhorn longhorn/longhorn --namespace longhorn-system --create-namespace --version 1.5.3
   ```

3. **Verify Installation**:
   ```bash
   kubectl -n longhorn-system get pod -w
   ```

---

## Useful Commands

Here are some handy commands to aid your installation process:

1. **Environment Check**:
   ```bash
   curl https://raw.githubusercontent.com/longhorn/longhorn/v1.5.3/scripts/environment_check.sh | bash
   ```

2. **Set Up Helm Repository**:
   ```bash
   helm repo add longhorn https://charts.longhorn.io
   helm repo update
   ```

3. **Install Longhorn with Helm**:
   ```bash
   helm install longhorn longhorn/longhorn --namespace longhorn-system --create-namespace --version 1.5.3
   ```

4. **Verify Installation**:
   ```bash
   kubectl -n longhorn-system get pod -w
   ```

---

## Conclusion

This concludes the section on installing Longhorn. With multiple methods to choose from, you can select the one that best fits your environment and requirements. In the next section, we will explore how to use Longhorn for persistent storage and more advanced functionalities.
