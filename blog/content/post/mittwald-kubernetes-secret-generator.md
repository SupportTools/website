---
title: "Using the Mittwald Kubernetes Secret Generator"
date: 2023-05-20T23:23:00-05:00
draft: false
tags: ["Kubernetes", "Mittwald", "Secret Generator"]
categories:
- Kubernetes
- Mittwald
author: "Matthew Mattox - mmattox@support.tools."
description: "A guide on using the Mittwald Kubernetes Secret Generator to manage secrets in your Kubernetes cluster."
more_link: "yes"
---

In this blog post, we will walk through the process of using the Mittwald Kubernetes Secret Generator. This tool is a Kubernetes operator that can automatically create random secret data and manage Kubernetes secrets.

<!--more-->
# [Introduction](#introduction)

Managing secrets in Kubernetes can be complex, especially when many applications are running. The Mittwald Kubernetes Secret Generator simplifies this process by automatically generating and managing your secrets.

# [Prerequisites](#prerequisites)

Before you begin, you'll need to have the following:
- A Kubernetes cluster up and running.
- kubectl command-line tool installed and set up to communicate with your cluster.
- Helm package manager installed.

# [Installing the Secret Generator](#installing-the-secret-generator)

We will be using Helm to install the Mittwald Kubernetes Secret Generator.

1. First, add the Mittwald chart repository to your Helm repos:

```bash
helm repo add mittwald https://helm.mittwald.de
```

2. Update your Helm repos:

```bash
helm repo update
```

3. Install the Kubernetes Secret Generator:

```bash
helm install secret-generator mittwald/kubernetes-secret-generator
```

# [Using the Secret Generator](#using-the-secret-generator)

To use the Secret Generator, you must create a Secret resource with the `secret-generator.v1.mittwald.de/autogenerate` annotation.

Here's an example:

```yaml
apiVersion: v1
kind: Secret
metadata:
  annotations:
    secret-generator.v1.mittwald.de/autogenerate: "password"
type: Opaque
```

In this example, the Secret Generator will automatically create a secret with the key "password".

# [Conclusion](#conclusion)

The Mittwald Kubernetes Secret Generator is a powerful tool that can simplify the secrets management in your Kubernetes cluster. By automating the process of secret generation, you can ensure that your applications have the secrets they need without having to create and manage them manually. Happy deploying!
