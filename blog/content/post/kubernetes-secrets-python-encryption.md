---
title: "Simple Kubernetes Secret Encryption with Python"
date: 2025-01-15T12:00:00-05:00
draft: false
tags: ["Python", "Kubernetes", "Secrets Management", "Fernet Encryption"]
categories:
- Python
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A lightweight and straightforward approach to managing Kubernetes secrets using Python and Fernet encryption."
more_link: "yes"
url: "/kubernetes-secrets-python-encryption/"
---

Managing secrets in Kubernetes can be challenging, especially during early stages of a project. Here’s a lightweight solution using Python and Fernet encryption to streamline the process without the overhead of complex setups.

<!--more-->

---

## Problem with Traditional Kubernetes Secrets Management

Kubernetes secrets management is often a hurdle due to the need for:

- **ETCD Encryption**: Encrypting secrets at rest adds complexity to cluster setup.
- **RBAC Policies**: Carefully defining roles and permissions is time-intensive.
- **External Secret Managers**: Tools like Vault or cloud provider secret managers can be overkill for simple use cases.

For quick projects and proof-of-concepts, these setups can feel like overengineering. That’s where Python and Fernet encryption come in.

---

## Introducing the Python Secret Management Tool

### Features:
1. Reads secrets from a `.env` file.
2. Encrypts secrets using Fernet encryption.
3. Writes encrypted secrets to a `.csv` log file for reference.
4. Injects secrets directly into the target Kubernetes cluster.

---

### Getting Started

#### Setup
1. **Prepare a `.env` file** with the following parameters:
    ```plaintext
    KEY=your_fernet_key
    CLUSTER_NAME=target_kubernetes_cluster
    SECRET-TEST-1=example_secret_1
    SECRET-TEST-2=example_secret_2
    ```

2. **Generate a Fernet Key**:  
   Use an online generator like [Fernet Key Generator](https://fernetkeygen.com/) or Python’s `cryptography` library.

3. **Run the Script**:  
   Follow the [repository instructions](https://gitlab.com/matdevdug/example_kubernetes_python_encryption) to set up and execute the script.

---

### Example `.csv` Output

The script generates a `.csv` file logging encrypted secrets, keeping a record for future reference.

```csv
name,encrypted_value
secret-test-1,gAAAAAB...
secret-test-2,gAAAAAB...
```

---

### Injecting Secrets into Kubernetes

The tool checks the specified namespace for existing secrets and injects new ones if necessary. Secrets are base64-encoded before being added to the cluster.

Example Kubernetes YAML for mounting a secret:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  containers:
    - name: my-container
      image: your-image:latest
      volumeMounts:
        - name: secret-volume
          mountPath: /path/to/secret/data
  volumes:
    - name: secret-volume
      secret:
        secretName: my-secret
```

To decrypt the secret in Python:

```python
from cryptography.fernet import Fernet

fernet = Fernet(your_fernet_key)
decrypted_secret = fernet.decrypt(token)
```

---

### Benefits

- **Simplified Management**: Avoid complex setups during early development phases.
- **Secure by Default**: Encryption ensures data remains protected.
- **Cost-Effective**: No reliance on external paid secret management solutions.

---

## Q&A

**1. Why not SOPS or other tools?**  
This solution is lightweight and directly integrates with Kubernetes APIs for simplicity.

**2. Is Fernet encryption secure?**  
Yes, it provides strong encryption. However, use it for small-scale projects or as a stopgap solution.

**3. Will this become a CLI tool?**  
If there’s demand, I’d consider rewriting it in Go for CLI support.

---

## Conclusion

This Python-based solution simplifies secret management for Kubernetes. While not a replacement for robust solutions like Vault, it’s perfect for quick iterations and prototypes.

For feedback or collaboration, reach out via [LinkedIn](https://www.linkedin.com/in/matthewmattox/), [GitHub](https://github.com/mattmattox), or [BlueSky](https://bsky.app/profile/cube8021.bsky.social).
