---
title: "Using Git Credentials in Environment Variables When Using Git Inside a Kubernetes Pod"  
date: 2024-10-13T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "Git", "Environment Variables", "Security"]  
categories:  
- Kubernetes  
- Git  
- Security  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to securely use Git credentials stored in environment variables when working with Git inside Kubernetes Pods."  
more_link: "yes"  
url: "/git-credentials-environment-variables-kubernetes-pod/"  
---

When working with Git inside Kubernetes Pods, there are scenarios where you need to authenticate to a Git repository. The typical way to do this is by using credentials such as **username** and **password** or **personal access tokens**. However, hardcoding these credentials directly in the code or configuration files is both insecure and difficult to manage.

A better approach is to use **environment variables** to store Git credentials, ensuring secure and flexible access. In this post, we will walk through how to securely use Git credentials stored in environment variables inside a Kubernetes Pod.

<!--more-->

### Why Use Environment Variables for Git Credentials?

Using environment variables to store sensitive information such as Git credentials has several advantages:

- **Security**: Credentials are not hardcoded in the Pod definition or Git configuration files, reducing the risk of exposure.
- **Flexibility**: You can easily update or rotate credentials without changing the application code or redeploying the Pod.
- **Separation of Concerns**: Credentials can be managed separately from the code and container image.

### Step 1: Store Git Credentials as Kubernetes Secrets

Before we can inject Git credentials into the Pod’s environment variables, we need to store the credentials securely in Kubernetes using a **Secret**. This will allow us to inject them into the Pod’s environment at runtime.

Here’s how to create a Kubernetes Secret to store your Git username and personal access token (PAT):

```bash
kubectl create secret generic git-credentials \
  --from-literal=username=your-username \
  --from-literal=token=your-personal-access-token
```

This command creates a Secret named `git-credentials` with two key-value pairs: `username` and `token`.

### Step 2: Inject Credentials into the Pod as Environment Variables

Once the credentials are stored as a Secret, the next step is to inject them into the Pod as environment variables. Modify the Pod configuration to include the Secret in the `env` section.

Here’s an example Pod definition that injects the Git credentials into environment variables:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: git-clone-pod
  labels:
    app: git-clone
spec:
  containers:
  - name: git-clone-container
    image: alpine/git
    command: ["/bin/sh", "-c", "git clone https://$(GIT_USERNAME):$(GIT_TOKEN)@github.com/your-repo.git /repo"]
    env:
    - name: GIT_USERNAME
      valueFrom:
        secretKeyRef:
          name: git-credentials
          key: username
    - name: GIT_TOKEN
      valueFrom:
        secretKeyRef:
          name: git-credentials
          key: token
    volumeMounts:
    - name: git-repo
      mountPath: /repo
  volumes:
  - name: git-repo
    emptyDir: {}
```

In this configuration:
- The Git credentials are injected into the container using the environment variables `GIT_USERNAME` and `GIT_TOKEN`.
- The **alpine/git** image is used, and the `git clone` command is executed inside the container, using the injected credentials to authenticate with the Git repository.
- The cloned repository is mounted to `/repo` using an `emptyDir` volume.

### Step 3: Verify the Credentials Are Securely Injected

Once the Pod is running, you can verify that the credentials have been injected securely by inspecting the environment variables:

```bash
kubectl exec git-clone-pod -- printenv | grep GIT
```

This should output the `GIT_USERNAME` and `GIT_TOKEN` environment variables, but since they are injected from the Secret, the actual values will not be displayed when printing the environment variable.

### Step 4: Managing and Rotating Credentials

One of the benefits of using environment variables and Kubernetes Secrets is that you can easily rotate the credentials without modifying the Pod specification. To update the credentials, simply update the Secret:

```bash
kubectl create secret generic git-credentials \
  --from-literal=username=new-username \
  --from-literal=token=new-personal-access-token \
  --dry-run=client -o yaml | kubectl apply -f -
```

This updates the Secret, and the next time a Pod is deployed using this Secret, it will have the updated credentials.

### Best Practices for Using Git Credentials in Kubernetes

- **Limit Secret Access**: Ensure that only the Pods that require access to the Git credentials have permission to read the Secrets.
- **Use Role-Based Access Control (RBAC)**: Implement RBAC policies to restrict access to Secrets.
- **Rotate Credentials Regularly**: Regularly update or rotate Git credentials to minimize the risk of compromise.
- **Use Short-Lived Tokens**: If possible, use short-lived tokens or personal access tokens (PATs) that expire after a set period.

### Conclusion

Using environment variables to manage Git credentials in Kubernetes Pods is a secure and flexible way to handle authentication for Git operations. By storing credentials in Kubernetes Secrets and injecting them into Pods, you can ensure that your sensitive information is managed separately from your code and is more secure.

This approach also makes it easy to manage, rotate, and update credentials without needing to redeploy your entire application. With proper access controls and security measures, you can securely manage Git authentication in any Kubernetes environment.
