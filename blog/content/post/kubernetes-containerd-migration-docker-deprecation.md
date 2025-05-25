---
title: "Kubernetes Beyond Docker: Migrating to containerd and What It Means for Your Clusters"
date: 2026-10-20T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Docker", "Containerd", "Container Runtime", "CRI", "Migration", "DevOps", "Orchestration"]
categories:
- Kubernetes
- Container Runtime
- Migration
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to understanding Kubernetes' transition from Docker to containerd, with practical migration strategies, troubleshooting tips, and best practices for modern container orchestration"
more_link: "yes"
url: "/kubernetes-containerd-migration-docker-deprecation/"
---

Kubernetes has deprecated and removed Docker support, but this doesn't mean containers are going away. In fact, this architectural shift towards direct integration with containerd represents a significant evolution in container orchestration. This guide explores what this change means for your clusters, how to prepare, and why this transition ultimately creates a more stable and efficient Kubernetes ecosystem.

<!--more-->

# Kubernetes Beyond Docker: Migrating to containerd and What It Means for Your Clusters

## Understanding the Docker Deprecation

When Kubernetes announced the deprecation of Docker as a container runtime in version 1.20, it caused considerable confusion in the community. Headlines like "Kubernetes is dropping Docker support" led many to believe their Docker containers would no longer work with Kubernetes. This misunderstanding stems from conflating Docker (the full platform) with the underlying container technologies.

### What Was Actually Deprecated?

To clarify what's actually changing, we need to understand the components involved:

1. **Docker Engine**: A complete platform for building, shipping, and running containers
2. **dockershim**: A compatibility layer in Kubernetes that translated between Docker and Kubernetes' Container Runtime Interface (CRI)
3. **containerd**: The underlying container runtime that Docker itself uses
4. **OCI (Open Container Initiative)**: The standards that govern container formats and runtimes

What Kubernetes deprecated was **dockershim** - the adapter between Kubernetes and Docker - not support for Docker-formatted containers.

### The Timeline of Change

Here's how the deprecation process unfolded:

- **Kubernetes 1.20 (December 2020)**: Official deprecation announced
- **Kubernetes 1.22 (August 2021)**: Last version with dockershim included
- **Kubernetes 1.24 (April 2022)**: dockershim removed from Kubernetes

This means any clusters running Kubernetes 1.24 or newer need an alternative container runtime to Docker, such as containerd, CRI-O, or another CRI-compliant runtime.

## The Architectural Shift Explained

To understand why this change makes sense, let's examine the evolution of container runtime architecture in Kubernetes.

### The Old Docker-Based Architecture

In the original architecture, Kubernetes interacted with containers through multiple layers:

```
Kubernetes → dockershim → Docker Engine → containerd → runc
```

This architecture had several drawbacks:

1. **Inefficiency**: Each additional layer adds overhead
2. **Complexity**: More components means more potential failure points
3. **Maintenance burden**: The Kubernetes team had to maintain dockershim
4. **Inconsistency**: Docker wasn't designed to be embedded in an orchestrator

### The New CRI-Based Architecture

With the new architecture, Kubernetes communicates directly with the container runtime via the Container Runtime Interface (CRI):

```
Kubernetes → containerd → runc
```

Or alternatively:

```
Kubernetes → CRI-O → runc
```

This simplified architecture offers several benefits:

1. **Improved performance**: Fewer layers means better performance
2. **Simplified maintenance**: Less code for the Kubernetes team to maintain
3. **Standardization**: Any runtime implementing the CRI standard works seamlessly
4. **Future-proofing**: Easier to adopt new container technologies as they emerge

## Impact Assessment: What This Means for Your Clusters

The impact of this change varies depending on how you're using Kubernetes. Let's examine different scenarios:

### For Most Users: Minimal Impact

If you're using Kubernetes as a platform to deploy containerized applications, the impact is minimal:

- Docker-built images will continue to work without any changes
- Your Dockerfiles don't need to be modified
- CI/CD pipelines that build Docker images remain valid
- Container registries and image distribution are unaffected

### Potential Issues to Watch For

There are some specific scenarios where the removal of dockershim might cause issues:

1. **Direct node access using Docker CLI**: If your scripts or operations rely on running `docker` commands directly on Kubernetes nodes, these will no longer work
2. **Docker-specific features**: If you're using Docker-specific features not in the OCI spec, these might not work
3. **Docker socket mounting**: Pods that mount the Docker socket (`/var/run/docker.sock`) for Docker-in-Docker (DinD) operations
4. **Custom scripts and tooling**: Any custom operational scripts that assume Docker is present on nodes

### Real-World Impact Example

Consider a common CI/CD workflow where images are built inside a pod:

**Before (with Docker)**:
```yaml
# Pod that builds images using Docker-in-Docker
apiVersion: v1
kind: Pod
metadata:
  name: image-builder
spec:
  containers:
  - name: docker
    image: docker:dind
    securityContext:
      privileged: true
    volumeMounts:
    - name: docker-socket
      mountPath: /var/run/docker.sock
  volumes:
  - name: docker-socket
    hostPath:
      path: /var/run/docker.sock
```

**After (without Docker)**:
This approach no longer works on containerd-based clusters. Instead, you would use alternatives like:

```yaml
# Pod that builds images using Kaniko (no Docker required)
apiVersion: v1
kind: Pod
metadata:
  name: kaniko-builder
spec:
  containers:
  - name: kaniko
    image: gcr.io/kaniko-project/executor:latest
    args:
    - "--dockerfile=Dockerfile"
    - "--context=git://github.com/user/repo"
    - "--destination=user/image:tag"
    volumeMounts:
    - name: kaniko-secret
      mountPath: /kaniko/.docker
  volumes:
  - name: kaniko-secret
    secret:
      secretName: docker-registry-credentials
      items:
      - key: .dockerconfigjson
        path: config.json
```

## Migration Guide: Moving from Docker to containerd

If you're running clusters that still use Docker via dockershim, here's a practical guide to migrating to containerd.

### Step 1: Identify Current Runtime Configuration

First, determine which container runtime your clusters are using:

```bash
kubectl get nodes -o wide
```

Look for the "CONTAINER-RUNTIME" column. If it shows "docker", you're using Docker.

For more detailed information:

```bash
kubectl get nodes -o=jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.containerRuntimeVersion}{"\n"}{end}'
```

### Step 2: Assess Compatibility

Before migrating, check for compatibility issues:

1. **Identify Docker socket mounts**:
   ```bash
   kubectl get pods --all-namespaces -o json | jq '.items[] | select(.spec.volumes[]?.hostPath.path == "/var/run/docker.sock") | .metadata.namespace + "/" + .metadata.name'
   ```

2. **Identify Docker-in-Docker containers**:
   ```bash
   kubectl get pods --all-namespaces -o json | jq '.items[] | select(.spec.containers[].image | contains("docker")) | .metadata.namespace + "/" + .metadata.name'
   ```

3. **Check for Docker volume drivers** that might not be supported with containerd.

### Step 3: Plan Upgrade Path

Choose one of these migration approaches:

1. **Rolling upgrade**: Upgrade one node at a time, moving workloads off the node during upgrade
2. **Blue/green deployment**: Create a new node pool with containerd, then migrate workloads
3. **Replacement**: Build new clusters with containerd and migrate applications

For managed Kubernetes services, check their documentation for specific migration paths:

- **AWS EKS**: [Migrating from dockershim to containerd](https://docs.aws.amazon.com/eks/latest/userguide/dockershim-deprecation.html)
- **Google GKE**: [GKE dockershim deprecation](https://cloud.google.com/kubernetes-engine/docs/concepts/using-containerd)
- **Azure AKS**: [AKS containerd support](https://docs.microsoft.com/en-us/azure/aks/cluster-configuration#container-runtime-configuration)

### Step 4: Configure containerd

When migrating to containerd, you'll need to ensure it's properly configured:

**Sample containerd configuration (/etc/containerd/config.toml)**:

```toml
version = 2

[plugins]
  [plugins."io.containerd.grpc.v1.cri"]
    [plugins."io.containerd.grpc.v1.cri".containerd]
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          runtime_type = "io.containerd.runc.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            SystemdCgroup = true
    [plugins."io.containerd.grpc.v1.cri".registry]
      [plugins."io.containerd.grpc.v1.cri".registry.mirrors]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
          endpoint = ["https://registry-1.docker.io"]
```

The key settings to configure include:

- Registry mirrors for improved image pulling
- Runtime handlers for different container types
- Logging and metrics collection
- Cgroup management strategy

### Step 5: Upgrade Nodes

The exact process will depend on your environment. Here's a general approach for self-managed clusters:

1. **Drain the node** to move workloads:
   ```bash
   kubectl drain node-name --ignore-daemonsets
   ```

2. **Install containerd**:
   ```bash
   apt-get update && apt-get install -y containerd.io
   ```

3. **Configure kubelet** to use containerd:
   Edit `/var/lib/kubelet/kubeadm-flags.env` to include:
   ```
   KUBELET_EXTRA_ARGS=--container-runtime=remote --container-runtime-endpoint=unix:///run/containerd/containerd.sock
   ```

4. **Restart kubelet**:
   ```bash
   systemctl restart kubelet
   ```

5. **Uncordon the node** to allow workloads to return:
   ```bash
   kubectl uncordon node-name
   ```

### Step 6: Validate Upgrade

After upgrading, verify everything is working correctly:

1. **Check node status**:
   ```bash
   kubectl get nodes -o wide
   ```

2. **Verify pods are running**:
   ```bash
   kubectl get pods --all-namespaces
   ```

3. **Test a deployment**:
   ```bash
   kubectl create deployment nginx --image=nginx
   kubectl expose deployment nginx --port=80
   kubectl get pods,svc -l app=nginx
   ```

## Debugging and Troubleshooting containerd

As you transition from Docker to containerd, you'll need to adapt your troubleshooting techniques.

### Command Line Tools for containerd

Instead of the Docker CLI, you'll use these tools:

1. **crictl**: A command-line interface for CRI-compatible container runtimes

   ```bash
   # List containers
   crictl ps
   
   # Get container info
   crictl inspect container-id
   
   # View container logs
   crictl logs container-id
   
   # Execute command in container
   crictl exec -it container-id sh
   
   # List images
   crictl images
   ```

2. **ctr**: A lower-level CLI for direct containerd operations

   ```bash
   # List containers
   ctr containers ls
   
   # List images
   ctr images ls
   
   # Pull an image
   ctr images pull docker.io/library/nginx:latest
   ```

### Docker to containerd Command Mapping

| Docker Command      | containerd Equivalent (crictl)     |
|---------------------|-----------------------------------|
| `docker ps`         | `crictl ps`                       |
| `docker logs`       | `crictl logs`                     |
| `docker exec`       | `crictl exec`                     |
| `docker images`     | `crictl images`                   |
| `docker pull`       | `crictl pull`                     |
| `docker inspect`    | `crictl inspect`                  |
| `docker stats`      | `crictl stats`                    |

### Common Issues and Solutions

#### Issue 1: Image Pull Failures

**Symptoms**: Pods stuck in `ImagePullBackOff` status

**Troubleshooting**:
1. Check image pull status:
   ```bash
   crictl images
   ```
2. Try pulling manually:
   ```bash
   crictl pull problematic-image:tag
   ```
3. Check registry configuration in containerd:
   ```bash
   cat /etc/containerd/config.toml | grep registry -A 10
   ```

**Solution**: Ensure proper registry configuration in containerd's config.toml, including authentication for private registries.

#### Issue 2: Container Startup Failures

**Symptoms**: Pods stuck in `CrashLoopBackOff` status

**Troubleshooting**:
1. Get container IDs:
   ```bash
   crictl ps -a
   ```
2. Check container logs:
   ```bash
   crictl logs container-id
   ```
3. Inspect container details:
   ```bash
   crictl inspect container-id
   ```

**Solution**: Address the application error shown in logs or fix container configuration issues.

#### Issue 3: containerd Service Issues

**Symptoms**: kubelet logs show containerd connection failures

**Troubleshooting**:
1. Check containerd status:
   ```bash
   systemctl status containerd
   ```
2. View containerd logs:
   ```bash
   journalctl -u containerd
   ```

**Solution**: Restart containerd or fix configuration issues based on error messages.

## Adapting DevOps Practices for containerd

The transition to containerd requires adapting your DevOps practices, particularly around CI/CD pipelines, monitoring, and debugging.

### CI/CD Pipeline Adjustments

If your pipelines rely on Docker-in-Docker, consider these alternatives:

1. **Kaniko**: Build images inside Kubernetes without Docker
   ```yaml
   # Example Kaniko job
   apiVersion: batch/v1
   kind: Job
   metadata:
     name: kaniko-build
   spec:
     template:
       spec:
         containers:
         - name: kaniko
           image: gcr.io/kaniko-project/executor:latest
           args:
           - "--dockerfile=Dockerfile"
           - "--context=git://github.com/user/repo"
           - "--destination=user/image:tag"
         restartPolicy: Never
   ```

2. **BuildKit**: Advanced image building with efficient caching
   ```yaml
   # Example BuildKit deployment
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: buildkitd
   spec:
     replicas: 1
     selector:
       matchLabels:
         app: buildkitd
     template:
       metadata:
         labels:
           app: buildkitd
       spec:
         containers:
         - name: buildkitd
           image: moby/buildkit:latest
           securityContext:
             privileged: true
   ```

3. **External builders**: Use external CI systems like GitHub Actions, GitLab CI, or Jenkins for building images

### Monitoring and Logging Adaptations

Update your monitoring and logging practices:

1. **Metrics collection**: Configure Prometheus to scrape containerd metrics:
   ```yaml
   # Prometheus ServiceMonitor for containerd
   apiVersion: monitoring.coreos.com/v1
   kind: ServiceMonitor
   metadata:
     name: containerd
     namespace: monitoring
   spec:
     endpoints:
     - interval: 30s
       port: metrics
     namespaceSelector:
       matchNames:
       - kube-system
     selector:
       matchLabels:
         k8s-app: containerd
   ```

2. **Log collection**: Update log collection configurations to capture containerd logs:
   ```yaml
   # Fluentd ConfigMap snippet for containerd logs
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: fluentd-config
   data:
     containerd.conf: |
       <source>
         @type tail
         path /var/log/containers/*.log
         pos_file /var/log/containerd.log.pos
         tag containerd.*
         <parse>
           @type json
           time_key time
           time_format %Y-%m-%dT%H:%M:%S.%NZ
         </parse>
       </source>
   ```

### Security Considerations

Adjust your security posture for containerd:

1. **Runtime security**: Update seccomp and AppArmor profiles for containerd

2. **Privilege settings**: Review pod security contexts and container capabilities

3. **Image scanning**: Ensure your image scanning solutions work with containerd

## Best Practices for containerd in Production

To ensure optimal performance and reliability with containerd, follow these best practices:

### Performance Optimization

1. **Memory management**:
   ```toml
   # In config.toml
   [plugins."io.containerd.grpc.v1.cri".containerd]
     snapshotter = "overlayfs"
     disable_snapshot_annotations = true
   ```

2. **Image pulling optimization**:
   ```toml
   # In config.toml
   [plugins."io.containerd.grpc.v1.cri".registry]
     [plugins."io.containerd.grpc.v1.cri".registry.mirrors]
       [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
         endpoint = ["https://registry-1.docker.io", "https://your-mirror.example.com"]
   ```

3. **Resource limits**: Configure proper resource limits for containerd service:
   ```systemd
   # In containerd.service
   [Service]
   CPUAccounting=true
   MemoryAccounting=true
   CPUQuota=200%
   MemoryLimit=2G
   ```

### Stability and Reliability

1. **Proper shutdown handling**:
   ```toml
   # In config.toml
   [plugins."io.containerd.internal.v1.shutdown"]
     timeout = "30s"
   ```

2. **Health checking**: Implement regular health checks
   ```bash
   # Systemd service check
   ExecStartPost=/bin/sh -c 'while ! ctr version; do sleep 1; done'
   ```

3. **Failure recovery**: Ensure automatic restart on failure
   ```systemd
   # In containerd.service
   [Service]
   Restart=always
   RestartSec=5
   ```

### Backup and Disaster Recovery

1. **State backup**: Back up containerd's state directory:
   ```bash
   tar -czf containerd-backup.tar.gz /var/lib/containerd
   ```

2. **Configuration backup**: Version control your containerd configurations

3. **Recovery testing**: Regularly test restoration procedures

## Future-Proofing Your Container Strategy

As container technologies continue to evolve, here are strategies to future-proof your approach:

### Embrace OCI Standards

The Open Container Initiative (OCI) provides industry standards for container formats and runtimes. By adhering to these standards, you ensure compatibility regardless of the underlying runtime:

1. **Use OCI-compliant images**: Standard Docker images already conform to OCI specifications
2. **Avoid runtime-specific features**: Stick to features available across runtimes
3. **Leverage OCI hooks**: For custom functionality that works across runtimes

### Explore Advanced Container Runtimes

Beyond containerd, consider exploring specialized runtimes for specific use cases:

1. **gVisor**: For enhanced isolation and security
   ```yaml
   # Pod using gVisor runtime
   apiVersion: v1
   kind: Pod
   metadata:
     name: secure-pod
   spec:
     runtimeClassName: gvisor
     containers:
     - name: app
       image: my-secure-app:latest
   ```

2. **Kata Containers**: For hardware-level isolation
   ```yaml
   # Pod using Kata Containers runtime
   apiVersion: v1
   kind: Pod
   metadata:
     name: isolated-pod
   spec:
     runtimeClassName: kata
     containers:
     - name: app
       image: my-app:latest
   ```

### Consider Specialized Build Tools

As containers evolve, specialized build tools offer advantages over traditional approaches:

1. **BuildPacks**: For standardized, secure builds across languages
2. **ko**: For building Go applications directly to container images
3. **Jib**: For building Java containers without Dockerfiles

## Conclusion: Embracing the Containerization Evolution

The transition from Docker to containerd in Kubernetes represents a natural evolution in container orchestration. By removing the dockershim layer, Kubernetes becomes more efficient, more stable, and better prepared for future innovations in containerization.

This change brings several key benefits:

1. **Simplified architecture**: Fewer moving parts means fewer points of failure
2. **Improved performance**: Direct integration with containerd reduces overhead
3. **Enhanced security**: Less code means a smaller attack surface
4. **Better standards alignment**: Kubernetes now works directly with OCI-compliant runtimes
5. **Future-proofing**: The CRI abstraction makes it easier to adopt new container technologies

For most teams, this transition should be relatively straightforward, especially for workloads that don't directly interact with the Docker socket. By following the migration guide and best practices outlined in this article, you can ensure a smooth transition to containerd and position your container strategy for long-term success.

Remember that Docker remains an excellent tool for local development and building images. The change in Kubernetes simply reflects the maturation of the container ecosystem, where specialized components can now efficiently handle different aspects of the container lifecycle.

As you adapt to this change, focus on building expertise with containerd and standardizing on OCI-compliant workflows. This approach will ensure your container strategy remains robust and adaptable in the ever-evolving landscape of cloud-native technologies.

---

*The information in this article is based on Kubernetes 1.24 and later versions. Always refer to the official Kubernetes documentation for the most up-to-date information regarding container runtime support.*