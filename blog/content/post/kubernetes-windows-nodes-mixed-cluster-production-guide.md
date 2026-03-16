---
title: "Kubernetes Windows Nodes: Running Windows Workloads in Mixed Clusters"
date: 2027-02-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Windows", "Mixed Cluster", "Containers", "Enterprise"]
categories: ["Kubernetes", "Windows", "Enterprise"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide to running Windows workloads in Kubernetes mixed clusters: containerd setup, node taints, OS selectors, SMB CSI storage, Windows networking, and managed service integration."
more_link: "yes"
url: "/kubernetes-windows-nodes-mixed-cluster-production-guide/"
---

Mixed Linux/Windows Kubernetes clusters unlock the ability to containerize legacy .NET Framework applications, Windows-native services, and IIS workloads while sharing the same orchestration plane as modern Linux microservices. The operational surface area is larger than a Linux-only cluster, but the architectural patterns are well-established across EKS, AKS, GKE, and bare-metal environments. This guide covers every layer of a production Windows node deployment: container runtime, scheduling primitives, storage, networking, monitoring, and day-two operations.

<!--more-->

## Architecture of a Mixed Cluster

### How Windows Support Works

Kubernetes itself is OS-agnostic at the control plane level. All master components—`kube-apiserver`, `kube-scheduler`, `kube-controller-manager`, and `etcd`—run on Linux nodes. Windows nodes join the cluster as workers only. Each Windows node runs `kubelet`, `kube-proxy`, and a container runtime, just like Linux workers. The differences live in the container runtime interface (CRI), the network datapath, and the syscall surface available to containers.

**Windows container isolation modes:**

- **Process isolation**: Containers share the Windows kernel with the host, similar to Linux containers. Fastest and most dense; requires the container base image OS version to match the host OS build exactly.
- **Hyper-V isolation**: Each container runs in a lightweight VM. Allows mismatched OS versions but adds ~100 ms startup overhead and higher memory overhead per container.

### Supported Windows Versions

| Host OS | Base Image Tag | Notes |
|---|---|---|
| Windows Server 2022 (ltsc2022) | `mcr.microsoft.com/windows/servercore:ltsc2022` | Recommended for new deployments |
| Windows Server 2019 (1809) | `mcr.microsoft.com/windows/servercore:ltsc2019` | Legacy; still in use for older .NET Framework apps |
| Windows Server 2022 | `mcr.microsoft.com/windows/nanoserver:ltsc2022` | Minimal image; Go/binary workloads |

Process isolation requires the container image OS build number to match the node OS build number precisely. Hyper-V isolation relaxes this constraint but is not supported on all cloud providers.

## Container Runtime: containerd on Windows

### Installation

containerd is the only supported CRI for Windows nodes in Kubernetes 1.24+. The following PowerShell script installs containerd and configures it for Kubernetes use:

```powershell
# Install containerd on Windows Server 2022
$ContainerdVersion = "1.7.13"
$DownloadUrl = "https://github.com/containerd/containerd/releases/download/v${ContainerdVersion}/containerd-${ContainerdVersion}-windows-amd64.tar.gz"

# Create directories
New-Item -ItemType Directory -Force -Path "C:\Program Files\containerd"
New-Item -ItemType Directory -Force -Path "C:\etc\containerd"

# Download and extract
Invoke-WebRequest -Uri $DownloadUrl -OutFile "containerd.tar.gz"
tar -xvf containerd.tar.gz -C "C:\Program Files\containerd" --strip-components=1

# Register as Windows service
& "C:\Program Files\containerd\containerd.exe" --register-service

# Generate default config
& "C:\Program Files\containerd\containerd.exe" config default | Out-File "C:\etc\containerd\config.toml" -Encoding ascii
```

### containerd Configuration for Windows

```toml
# C:\etc\containerd\config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  sandbox_image = "registry.k8s.io/pause:3.9"

  [plugins."io.containerd.grpc.v1.cri".containerd]
    snapshotter = "windows"

    [plugins."io.containerd.grpc.v1.cri".containerd.default_runtime]
      runtime_type = "io.containerd.runhcs.v1"

      [plugins."io.containerd.grpc.v1.cri".containerd.default_runtime.options]
        Debug = false
        DebugType = 2
        SandboxPlatform = "windows/amd64"
        SandboxIsolation = 0

  [plugins."io.containerd.grpc.v1.cri".cni]
    bin_dir = "C:\\Program Files\\containerd\\cni\\bin"
    conf_dir = "C:\\etc\\cni\\net.d"
```

`SandboxIsolation = 0` selects process isolation. Set it to `1` for Hyper-V isolation.

## Node Scheduling: Taints, Tolerations, and Node Selectors

### Default Windows Node Taint

Windows nodes are automatically tainted when joined to the cluster. Without this taint, Linux pods could be scheduled onto Windows nodes and fail immediately.

```yaml
# Taint applied automatically by kubelet on Windows nodes
key: node.kubernetes.io/os
value: windows
effect: NoSchedule
```

In managed services (AKS, EKS), this taint is applied by the node group configuration. On bare-metal or self-managed clusters, add it explicitly in the kubelet configuration or apply it after node join:

```bash
kubectl taint node win-worker-01 node.kubernetes.io/os=windows:NoSchedule
```

### Workload Scheduling for Windows Pods

Every Windows workload manifest must include both a `nodeSelector` and a `tolerations` block:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: iis-frontend
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: iis-frontend
  template:
    metadata:
      labels:
        app: iis-frontend
    spec:
      # Required: target Windows nodes
      nodeSelector:
        kubernetes.io/os: windows
        node.kubernetes.io/windows-build: "10.0.20348"  # ltsc2022 build number

      # Required: tolerate the Windows-only taint
      tolerations:
      - key: node.kubernetes.io/os
        operator: Equal
        value: windows
        effect: NoSchedule

      containers:
      - name: iis
        image: mcr.microsoft.com/windows/servercore/iis:windowsservercore-ltsc2022
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
```

The `node.kubernetes.io/windows-build` label is populated automatically by kubelet on Windows nodes and corresponds to the OS build number (`winver`). Using it ensures process isolation works correctly when multiple Windows OS versions exist in the same cluster.

### Preventing Linux Pods from Reaching Windows Nodes

The inverse problem also requires attention: Linux pods must not land on Windows nodes. Add a `nodeSelector` or `nodeAffinity` to system DaemonSets if they lack OS selectors:

```yaml
# Patch kube-proxy DaemonSet to run only on Linux nodes
kubectl patch daemonset kube-proxy -n kube-system \
  --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/nodeSelector","value":{"kubernetes.io/os":"linux"}}]'
```

## Windows Container Base Images

### Choosing the Right Base Image

**servercore** is the full Windows Server Core image. Use it for:
- IIS web applications
- .NET Framework 4.x applications
- Applications that require Win32 APIs not available in Nano Server

**nanoserver** is a minimal image (~100 MB compressed) designed for:
- .NET 6+ / .NET 8+ console applications
- Go, Rust, or other statically compiled binaries
- Applications with no Win32 dependency on full framework DLLs

**windows** (full Windows image) is rarely used in containers; it is large (~5 GB) and typically unnecessary.

```dockerfile
# Dockerfile for a .NET Framework 4.8 application targeting ltsc2022
FROM mcr.microsoft.com/dotnet/framework/sdk:4.8-windowsservercore-ltsc2022 AS build
WORKDIR /app
COPY *.sln .
COPY MyApp/*.csproj ./MyApp/
RUN nuget restore
COPY . .
RUN msbuild MyApp/MyApp.csproj /p:Configuration=Release /p:OutputPath=c:\out

FROM mcr.microsoft.com/dotnet/framework/aspnet:4.8-windowsservercore-ltsc2022 AS runtime
WORKDIR /inetpub/wwwroot
COPY --from=build /out/. .
EXPOSE 80
```

```dockerfile
# Dockerfile for a .NET 8 application using nanoserver
FROM mcr.microsoft.com/dotnet/sdk:8.0-nanoserver-ltsc2022 AS build
WORKDIR /app
COPY *.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /out

FROM mcr.microsoft.com/dotnet/runtime:8.0-nanoserver-ltsc2022
WORKDIR /app
COPY --from=build /out .
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

### Dockerfile Differences from Linux

Key differences when writing Windows Dockerfiles:

- **Path separators**: Use forward slashes in `COPY` and `RUN` commands; Docker translates them. Avoid backslashes in `ENV` and `WORKDIR`.
- **No `USER` instruction with UID/GID**: Windows containers use named accounts (`ContainerUser`, `ContainerAdministrator`). The `USER ContainerUser` syntax works for IIS images but not all base images.
- **`SHELL` instruction**: Default shell is `cmd`. Switch to PowerShell for complex scripting: `SHELL ["powershell", "-Command", "$ErrorActionPreference = 'Stop';"]`
- **`HEALTHCHECK`**: The `curl` binary is not always present. Use `Invoke-WebRequest` in PowerShell or bundle a static `curl.exe`.
- **Layer caching**: Windows base layers are very large. Order `COPY` and `RUN` instructions carefully to maximize cache reuse.
- **No signals**: Windows containers do not support Unix signals. Graceful shutdown requires the application to poll for a named event or use `SIGTERM` simulation via the `waitForStop` pattern.

## Persistent Storage: SMB CSI Driver

### Why SMB for Windows

Linux nodes typically use NFS or block storage (EBS, PD, Azure Disk). Windows nodes lack native NFS client support in containers but have built-in SMB/CIFS client support. The **SMB CSI driver** (`smb.csi.k8s.io`) bridges this gap and supports both Windows and Linux nodes.

### Installing the SMB CSI Driver

```bash
# Install via Helm
helm repo add csi-driver-smb https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts
helm repo update

helm install csi-driver-smb csi-driver-smb/csi-driver-smb \
  --namespace kube-system \
  --set windows.enabled=true \
  --set linux.enabled=true \
  --version 1.14.0
```

### StorageClass and PersistentVolumeClaim

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: smb-storage
provisioner: smb.csi.k8s.io
parameters:
  source: "//fileserver.corp.example.com/k8s-share"
  # Credentials stored in a Secret
  csi.storage.k8s.io/node-stage-secret-name: smb-credentials
  csi.storage.k8s.io/node-stage-secret-namespace: kube-system
reclaimPolicy: Retain
volumeBindingMode: Immediate
mountOptions:
  - dir_mode=0777
  - file_mode=0777
  - uid=1001
  - gid=1001
---
apiVersion: v1
kind: Secret
metadata:
  name: smb-credentials
  namespace: kube-system
type: Opaque
stringData:
  username: "svc-k8s-smb"
  password: "EXAMPLE_PASSWORD_REPLACE_ME"
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: production
spec:
  accessModes:
  - ReadWriteMany
  storageClassName: smb-storage
  resources:
    requests:
      storage: 50Gi
```

### Mounting SMB in Windows Pods

```yaml
# Windows pod with SMB volume
spec:
  nodeSelector:
    kubernetes.io/os: windows
  tolerations:
  - key: node.kubernetes.io/os
    operator: Equal
    value: windows
    effect: NoSchedule
  volumes:
  - name: app-data
    persistentVolumeClaim:
      claimName: app-data
  containers:
  - name: app
    image: mcr.microsoft.com/windows/servercore:ltsc2022
    volumeMounts:
    - name: app-data
      mountPath: "C:\\data"
```

SMB volumes mount as UNC paths internally and are presented as a drive letter or directory path to the container. The `mountPath` on Windows must use a `C:\` prefix or another available drive letter.

## Windows Networking: Calico and Flannel

### Supported CNI Plugins

| CNI | Windows Support | Network Mode |
|---|---|---|
| Calico | Yes (v3.23+) | VXLAN, BGP |
| Flannel | Yes | host-gw, VXLAN |
| Antrea | Yes (v1.8+) | OVS, Geneve |
| Cilium | Partial (eBPF not supported on Windows) | VXLAN only |

**Calico** is the most widely deployed CNI in enterprise mixed clusters. On Windows, Calico uses VXLAN encapsulation because BGP dataplane support on Windows requires additional setup.

### Calico Windows Configuration

```yaml
# calico-windows-config.yaml
# Patch to enable Windows node support in Calico
apiVersion: v1
kind: ConfigMap
metadata:
  name: calico-config
  namespace: kube-system
data:
  # Use VXLAN for Windows compatibility
  calico_backend: "vxlan"
  veth_mtu: "1450"
```

On Windows nodes, Calico runs as a Windows service rather than a DaemonSet pod. The Calico Windows installer configures the Windows HNS (Host Networking Service) network and registers the CNI plugin binary in `C:\Program Files\containerd\cni\bin`.

### kube-proxy on Windows

`kube-proxy` on Windows uses the WinKernel mode (Windows HNS) rather than iptables. It is deployed as a DaemonSet with OS selector:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kube-proxy-windows
  namespace: kube-system
spec:
  selector:
    matchLabels:
      k8s-app: kube-proxy-windows
  template:
    metadata:
      labels:
        k8s-app: kube-proxy-windows
    spec:
      nodeSelector:
        kubernetes.io/os: windows
      tolerations:
      - key: node.kubernetes.io/os
        operator: Equal
        value: windows
        effect: NoSchedule
      hostNetwork: true
      serviceAccountName: kube-proxy
      containers:
      - name: kube-proxy
        image: registry.k8s.io/kube-proxy:v1.30.0
        command:
        - /usr/local/bin/kube-proxy
        - --config=/var/lib/kube-proxy/config.conf
        - --hostname-override=$(NODE_NAME)
        - --proxy-mode=kernelspace
        - --feature-gates=WinDSR=true
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
```

### Known Networking Limitations

- **No `hostNetwork: true` for user workloads**: Host networking on Windows pods is restricted to system components.
- **No NetworkPolicy with process isolation + Flannel host-gw**: Flannel host-gw mode does not enforce NetworkPolicy on Windows. Use Calico or Antrea for network policy enforcement.
- **NodePort range**: The default NodePort range (30000–32767) works on Windows, but `externalTrafficPolicy: Local` has limited support.
- **IPv6**: Windows container networking does not support IPv6 dual-stack in all configurations.

## kubelet Configuration on Windows

### Key Differences from Linux kubelet

The Windows kubelet runs as a Windows service and lacks some Linux-specific features:

```yaml
# C:\var\lib\kubelet\config.yaml
kind: KubeletConfiguration
apiVersion: kubelet.config.k8s.io/v1beta1
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
  x509:
    clientCAFile: "C:\\etc\\kubernetes\\pki\\ca.crt"
authorization:
  mode: Webhook
cgroupDriver: ""  # cgroupv2 is not supported on Windows; leave empty
clusterDNS:
- "10.96.0.10"
clusterDomain: cluster.local
containerLogMaxSize: "10Mi"
containerLogMaxFiles: 5
# Windows-specific: disable features not available
featureGates:
  WindowsHostProcessContainers: true
  WindowsGMSA: true
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
kubeReserved:
  cpu: "250m"
  memory: "512Mi"
systemReserved:
  cpu: "250m"
  memory: "512Mi"
```

**Key constraints:**

- **No cgroups**: Windows uses Job Objects for resource enforcement. CPU and memory limits work, but the enforcement mechanism differs from Linux.
- **Memory limits are hard limits**: A container exceeding its memory limit is immediately terminated. There is no OOM kill grace period equivalent.
- **CPU limits are rate-limited**: CPU throttling on Windows uses CPU rate caps rather than CFS bandwidth control.
- **No `securityContext.runAsUser` with numeric UID**: User context on Windows uses named accounts.
- **No privileged containers**: Windows does not support `privileged: true`. Use `hostProcess: true` (HostProcess containers) for privileged node access.

## Joining Windows Nodes to Managed Services

### Amazon EKS

EKS Windows node groups use managed node groups or self-managed EC2 instances with the Windows EKS AMI.

```bash
# eksctl configuration for a Windows node group
cat <<'EOF' > windows-nodegroup.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: production-cluster
  region: us-east-1

managedNodeGroups:
- name: windows-workers
  amiFamily: WindowsServer2022FullContainer
  instanceType: m5.2xlarge
  minSize: 2
  maxSize: 10
  desiredCapacity: 3
  volumeSize: 100
  labels:
    kubernetes.io/os: windows
  taints:
  - key: node.kubernetes.io/os
    value: windows
    effect: NoSchedule
EOF

eksctl create nodegroup -f windows-nodegroup.yaml
```

EKS Windows nodes require the `eks:node-manager` cluster role binding and the VPC CNI plugin configured with Windows IPAM support:

```bash
kubectl set env daemonset aws-node -n kube-system ENABLE_WINDOWS_IPAM=true
```

### Azure AKS

AKS supports Windows node pools natively:

```bash
# Add a Windows node pool to an existing AKS cluster
az aks nodepool add \
  --resource-group production-rg \
  --cluster-name production-aks \
  --name winnp1 \
  --os-type Windows \
  --os-sku Windows2022 \
  --node-count 3 \
  --node-vm-size Standard_D4s_v3 \
  --node-taints "node.kubernetes.io/os=windows:NoSchedule" \
  --labels "kubernetes.io/os=windows"
```

AKS configures `containerd` and Calico automatically on Windows node pools when the cluster uses the Azure CNI with Calico network policy.

### Google GKE

GKE Windows node pools are available in Standard mode (not Autopilot):

```bash
gcloud container node-pools create windows-pool \
  --cluster production-cluster \
  --zone us-central1-a \
  --image-type WINDOWS_LTSC_CONTAINERD \
  --machine-type n2-standard-4 \
  --num-nodes 3 \
  --node-taints node.kubernetes.io/os=windows:NoSchedule \
  --node-labels kubernetes.io/os=windows \
  --disk-size 100
```

## Resource Limits and Constraints

### Memory and CPU Sizing for Windows Containers

Windows containers have higher baseline memory consumption than equivalent Linux containers due to the Windows subsystem overhead:

| Component | Typical Overhead |
|---|---|
| Windows Server Core container (idle) | 400–600 MB |
| Windows Nano Server container (idle) | 50–100 MB |
| IIS worker process | 100–300 MB per app pool |
| .NET Framework 4.x runtime | 100–200 MB |
| .NET 8 runtime | 30–60 MB |

Set requests and limits accordingly. A minimum of 512 Mi memory for servercore containers is a reasonable baseline:

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "768Mi"
  limits:
    cpu: "4"
    memory: "4Gi"
```

### Disk Space

Windows base images are large. `servercore:ltsc2022` is approximately 5 GB compressed and 9 GB uncompressed. Node disks should be sized to hold multiple image versions plus container writable layers:

- Minimum node disk: 100 GB
- Recommended node disk: 150–200 GB for environments with multiple image versions

Configure image garbage collection thresholds in the kubelet configuration to prevent disk pressure.

## Upgrading Windows Nodes

Windows nodes cannot be upgraded in-place like Linux nodes. The upgrade procedure is a rolling replacement:

```bash
# Step 1: Cordon the node to prevent new scheduling
kubectl cordon win-worker-01

# Step 2: Drain existing workloads
kubectl drain win-worker-01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60

# Step 3: Remove the old node from the cluster
kubectl delete node win-worker-01

# Step 4: Re-image or replace the VM with the new Windows OS version
# This is environment-specific (AWS: terminate instance and let ASG replace it,
# AKS: node pool image upgrade, bare-metal: OS reinstall)

# Step 5: Join the new node with updated kubelet and containerd versions
# The node re-registers automatically when kubelet starts
```

For managed services, use the built-in upgrade commands:

```bash
# AKS: upgrade Windows node pool to latest node image
az aks nodepool upgrade \
  --resource-group production-rg \
  --cluster-name production-aks \
  --name winnp1 \
  --node-image-only
```

## Monitoring Windows Nodes with windows_exporter

### Deploying windows_exporter

`windows_exporter` is the Prometheus exporter for Windows metrics, analogous to `node_exporter` on Linux. Deploy it as a HostProcess DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: windows-exporter
  namespace: monitoring
  labels:
    app: windows-exporter
spec:
  selector:
    matchLabels:
      app: windows-exporter
  template:
    metadata:
      labels:
        app: windows-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9182"
        prometheus.io/path: "/metrics"
    spec:
      nodeSelector:
        kubernetes.io/os: windows
      tolerations:
      - key: node.kubernetes.io/os
        operator: Equal
        value: windows
        effect: NoSchedule
      securityContext:
        windowsOptions:
          hostProcess: true
          runAsUserName: "NT AUTHORITY\\System"
      hostNetwork: true
      initContainers:
      - name: configure-firewall
        image: mcr.microsoft.com/windows/nanoserver:ltsc2022
        command:
        - powershell
        args:
        - -Command
        - New-NetFirewallRule -DisplayName 'windows-exporter' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9182
        securityContext:
          windowsOptions:
            hostProcess: true
            runAsUserName: "NT AUTHORITY\\System"
      containers:
      - name: windows-exporter
        image: ghcr.io/prometheus-community/windows-exporter:0.27.1
        args:
        - --collectors.enabled=cpu,cs,logical_disk,net,os,service,system,container,memory,process
        - --telemetry.addr=:9182
        ports:
        - containerPort: 9182
          hostPort: 9182
          name: metrics
        securityContext:
          windowsOptions:
            hostProcess: true
            runAsUserName: "NT AUTHORITY\\System"
```

### ServiceMonitor for Prometheus Operator

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: windows-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: windows-exporter
  endpoints:
  - port: metrics
    interval: 30s
    scrapeTimeout: 15s
    scheme: http
```

### Key Windows Metrics to Alert On

```yaml
# PrometheusRule for Windows node alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: windows-node-alerts
  namespace: monitoring
spec:
  groups:
  - name: windows.nodes
    interval: 60s
    rules:
    - alert: WindowsNodeHighCPU
      expr: |
        100 - (avg by (instance) (rate(windows_cpu_time_total{mode="idle"}[5m])) * 100) > 85
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Windows node CPU above 85% for 10 minutes"
        description: "Node {{ $labels.instance }} CPU utilization is {{ $value | humanize }}%"

    - alert: WindowsNodeHighMemory
      expr: |
        100 - ((windows_os_physical_memory_free_bytes / windows_cs_physical_memory_bytes) * 100) > 90
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Windows node memory above 90%"
        description: "Node {{ $labels.instance }} memory utilization is {{ $value | humanize }}%"

    - alert: WindowsNodeDiskPressure
      expr: |
        (windows_logical_disk_free_bytes{volume="C:"} / windows_logical_disk_size_bytes{volume="C:"}) * 100 < 15
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Windows node C: drive below 15% free"
        description: "Node {{ $labels.instance }} has {{ $value | humanize }}% free on C:"
```

## Common Pitfalls and Troubleshooting

### Image Pull Failures Due to OS Version Mismatch

```
Error: container image ... is incompatible with host OS build
```

**Cause**: Process isolation requires matching OS build numbers. The container image was built for a different Windows Server build than the host.

**Resolution**: Either use Hyper-V isolation or rebuild the image using the matching `ltsc` tag. Verify the host OS build:

```powershell
(Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").CurrentBuildNumber
```

### Pod Stuck in ContainerCreating on Windows Node

```bash
# Replace POD_NAME and NAMESPACE with actual values
kubectl describe pod win-app-6d8b7f9c4d-xk7rp -n production
# Look for Events section
```

Common causes:
- CNI plugin failure: Check `C:\Program Files\containerd\cni\bin` for the correct CNI binary
- HNS network creation failure: Review Windows Event Log under `System` for HNS errors
- SMB mount timeout: Verify SMB credentials and network connectivity to the file server

### kubelet Certificate Rotation on Windows

Windows kubelet certificate rotation requires the node to have write access to `C:\var\lib\kubelet\pki`. If the kubelet service account lacks this permission, certificate rotation silently fails, causing `Unauthorized` errors after the certificate expires.

```powershell
# Verify kubelet certificate validity
$cert = Get-ChildItem "C:\var\lib\kubelet\pki" -Filter "*.crt" | Select-Object -First 1
[System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cert.FullName).NotAfter
```

### DNS Resolution Failures in Windows Containers

Windows containers use the DNS resolver configured in the container's `etc\resolv.conf` equivalent, written by kubelet. If DNS is not resolving:

```powershell
# Inside the container - test DNS
Resolve-DnsName kubernetes.default.svc.cluster.local
# Check nameserver configuration
Get-DnsClientServerAddress
```

Verify that `clusterDNS` in the kubelet configuration points to the correct CoreDNS service IP:

```bash
kubectl get svc kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}'
```

### Windows Container Logs Not Appearing

Windows containers write stdout to the Windows Event Tracing (ETW) infrastructure. Ensure `containerd` is configured to forward ETW events to the CRI logging endpoint:

```bash
# Check containerd log driver
# Replace POD_NAME and NAMESPACE with actual values
kubectl logs win-app-6d8b7f9c4d-xk7rp -n production
# If empty, check containerd shim configuration
# On the Windows node:
# Get-Content "C:\etc\containerd\config.toml" | Select-String "log"
```

## Production Checklist

Before deploying Windows nodes in production, verify the following:

- All Windows workloads have `nodeSelector: kubernetes.io/os: windows` and matching tolerations
- No Linux-only DaemonSets (node-exporter, Falco, etc.) lack OS selectors and would fail on Windows nodes
- Image OS build numbers match host OS build numbers if using process isolation
- Node disk size is at least 100 GB to accommodate Windows base image layers
- `windows_exporter` DaemonSet is deployed with HostProcess security context
- SMB credentials are stored in Kubernetes Secrets and rotated via a secrets management solution
- Windows node pool drain/cordon procedures are documented and tested
- Container registry contains images for all supported Windows OS versions used in the cluster
- kubelet certificate rotation is verified to be working on Windows nodes
- Firewall rules allow port 9182 for `windows_exporter` metrics scraping
