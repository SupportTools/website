---
title: "Don't Write Your Own Kubernetes YAML Generator"
date: 2025-02-15T12:00:00-05:00
draft: false
tags: ["Kubernetes", "YAML", "DevOps", "Configuration Management", "Kustomize", "yq"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn why building an internal Kubernetes YAML generator might not be the best approach, and explore alternatives like yq, Kustomize, and the Kubernetes client library."
more_link: "yes"
url: "/dont-write-your-own-kubernetes-yaml-generator/"
---

**Why Building Your Own YAML Generator Might Be a Mistake**

As Kubernetes adoption grows, so does the struggle with YAML configuration management. Many teams, frustrated with repetitive YAML tasks, decide to build internal YAML generators. While the intention is good, the reality is often a mix of technical debt and maintenance headaches.

<!--more-->

---

## Why YAML Generators Are a Common Trap

Internal YAML generators often aim to address these use cases:
1. Quickly generating Kubernetes configurations for new services.
2. Managing configurations for the same service across multiple environments (e.g., testing and production).

What starts as a small utility often becomes an unwieldy, critical tool that’s hard to debug and maintain. This creates friction between application developers and platform engineers.

---

## Scenarios and Better Alternatives

### **Scenario 1: Just Starting with Kubernetes**
If you're new to Kubernetes or don’t anticipate frequent app launches, **don’t over-engineer your setup**. Instead:
- Use tools like [k8syaml.com](https://k8syaml.com) to generate base YAML files.
- Define separate YAML files for each environment.
- Manage deployments with simple CI/CD pipelines that target specific namespaces or clusters.

### **Example Base YAML**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  labels:
    app: web
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx
          ports:
            - containerPort: 80
          env:
            - name: DATABASE_URL
              value: testdata.example.com
```

This low-effort approach works for most small setups and avoids the need for unnecessary tooling.

---

### **Scenario 2: Managing Multiple Apps and Environments**
When YAML maintenance becomes cumbersome, consider **automation through existing tools**, like `yq` or `Kustomize`.

#### **Option 1: yq for YAML Manipulation**
[yq](https://github.com/mikefarah/yq) is a lightweight YAML processor, ideal for CI/CD pipelines. 

**Example: Updating Environment Variables**
```bash
NAME=awesomedatabase
yq -i '.spec.template.spec.containers[0].env[0].value = strenv(NAME)' deployment.yaml
```

**Before:**
```yaml
env:
  - name: DATABASE_URL
    value: testdata.example.com
```

**After:**
```yaml
env:
  - name: DATABASE_URL
    value: awesomedatabase
```

**Why yq?**
- Precise targeting of YAML structures.
- Easy to integrate into CI/CD pipelines.
- Safer than `sed` for production-critical files.

---

#### **Option 2: Kustomize for Structured Management**
[Kustomize](https://kustomize.io) is built into `kubectl` and allows layering configurations for different environments without direct file manipulation.

**Example Directory Structure**
```
base/
  kustomization.yaml
  deployment.yaml
overlays/
  dev/
    kustomization.yaml
    patch.yaml
  prod/
    kustomization.yaml
    patch.yaml
```

**Dev Patch (overlays/dev/patch.yaml):**
```yaml
spec:
  replicas: 2
```

**Apply Configuration:**
```bash
kubectl apply -k overlays/dev/
```

---

### **Scenario 3: Scaling Complexity with Kubernetes Client Libraries**
For organizations deeply invested in Kubernetes, using [official client libraries](https://kubernetes.io/docs/reference/using-api/client-libraries/) (e.g., Python, Go) offers unparalleled flexibility.

**Advantages:**
- Full API control.
- TDD-friendly workflows.
- Automation of complex operations (e.g., dynamic namespace creation).

**Example: Python Client**
```python
from kubernetes import client, config

config.load_kube_config()

v1 = client.CoreV1Api()
namespace = client.V1Namespace(metadata=client.V1ObjectMeta(name="new-namespace"))

v1.create_namespace(namespace)
print("Namespace created!")
```

---

## Conclusion

Avoid the temptation to create internal Kubernetes YAML generators. Instead:
1. Start small with tools like [k8syaml.com](https://k8syaml.com).
2. Scale intelligently with `yq` or `Kustomize`.
3. Leverage Kubernetes client libraries for advanced scenarios.

Kubernetes YAML management doesn’t have to be a headache. With the right tools, you can balance simplicity, safety, and scalability without reinventing the wheel.
