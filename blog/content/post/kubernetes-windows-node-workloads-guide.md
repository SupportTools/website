---
title: "Kubernetes Windows Node Workloads: Running Windows Containers in Production"
date: 2028-12-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Windows", "Containers", "Mixed Cluster", "DevOps"]
categories:
- Kubernetes
- Windows
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for joining Windows Server nodes to Kubernetes clusters, scheduling Windows workloads, SMB CSI persistent storage, Active Directory authentication, and monitoring Windows nodes."
more_link: "yes"
url: "/kubernetes-windows-node-workloads-guide/"
---

Windows containers serve a specific purpose: running legacy .NET Framework applications, COM+ components, and services that depend on Windows APIs without rewriting them for Linux. Kubernetes has supported Windows worker nodes since 1.14, and with Windows Server 2022, the experience has matured considerably. Mixed Linux/Windows clusters are a viable production pattern, but they come with constraints that differ significantly from Linux-only clusters.

This guide covers Windows node requirements, joining procedures for kubeadm and managed clusters, workload scheduling, persistent storage with SMB CSI, Active Directory integration, and operational monitoring.

<!--more-->

# Kubernetes Windows Node Workloads

## Section 1: Windows Node Requirements

| Requirement | Windows Server 2019 | Windows Server 2022 |
|-------------|--------------------|--------------------|
| Container runtime | containerd 1.6+ | containerd 1.7+ |
| Kubernetes version | 1.20+ | 1.23+ |
| Process isolation | Yes | Yes |
| Hyper-V isolation | Yes (preview) | Yes (stable) |
| IPv6 | No | Yes (1.26+) |
| HostProcess containers | No | Yes (1.26+) |
| Network policies | Partial | Partial |

Minimum hardware for a Windows worker node:
- 2 vCPUs (4 recommended for production)
- 8 GB RAM (16 GB recommended)
- 50 GB OS disk (SSD recommended — Windows base image is ~5 GB compressed)
- Supported CNI plugin: Calico (overlay), Flannel (overlay), or Antrea

Check Windows version:

```powershell
# Run on the Windows node
[System.Environment]::OSVersion.Version
# Major  Minor  Build  Revision
# -----  -----  -----  --------
#     10      0  20348         0  <- Windows Server 2022

Get-ComputerInfo | Select-Object WindowsProductName, WindowsBuildLabEx
# WindowsProductName : Windows Server 2022 Datacenter
```

## Section 2: Joining a Windows Node with kubeadm

**On the Linux control plane** — generate the join token:

```bash
kubeadm token create --print-join-command
# kubeadm join 10.0.1.10:6443 --token abc123.xyz789 \
#   --discovery-token-ca-cert-hash sha256:deadbeef...
```

**On the Windows node** (PowerShell as Administrator):

```powershell
# Install containerd
$version = "1.7.14"
$url = "https://github.com/containerd/containerd/releases/download/v$version/containerd-$version-windows-amd64.tar.gz"
Invoke-WebRequest -Uri $url -OutFile "containerd.tar.gz"
tar -xvf containerd.tar.gz -C "C:\Program Files\containerd"

# Configure containerd
& "C:\Program Files\containerd\bin\containerd.exe" config default |
  Out-File "C:\Program Files\containerd\config.toml" -Encoding ASCII

# Start containerd as a service
& "C:\Program Files\containerd\bin\containerd.exe" --register-service
Start-Service containerd
Set-Service containerd -StartupType Automatic

# Verify
(Get-Service containerd).Status
# Running
```

```powershell
# Install CNI plugins (Calico on Windows)
$calicoVersion = "v3.27.0"
Invoke-WebRequest `
  -Uri "https://github.com/projectcalico/calico/releases/download/$calicoVersion/calico-windows-$calicoVersion.zip" `
  -OutFile calico-windows.zip
Expand-Archive calico-windows.zip -DestinationPath C:\CalicoWindows

# Configure Calico
C:\CalicoWindows\calico-node.exe -startup
```

```powershell
# Install kubelet and kubeadm binaries
$k8sVersion = "v1.29.3"
$baseUrl = "https://dl.k8s.io/release/$k8sVersion/bin/windows/amd64"

foreach ($bin in @("kubelet.exe", "kubeadm.exe", "kubectl.exe")) {
    Invoke-WebRequest -Uri "$baseUrl/$bin" -OutFile "C:\k\$bin"
}

# Create kubelet configuration
@"
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: cgroupfs
clusterDNS:
  - 10.96.0.10
clusterDomain: cluster.local
featureGates:
  WindowsHostProcessContainers: true
"@ | Out-File C:\k\kubelet-config.yaml

# Join the cluster
C:\k\kubeadm.exe join 10.0.1.10:6443 `
  --token abc123.xyz789 `
  --discovery-token-ca-cert-hash sha256:deadbeef... `
  --node-name windows-node-01

# Register kubelet as a service
& nssm install kubelet "C:\k\kubelet.exe" `
  "--config=C:\k\kubelet-config.yaml" `
  "--bootstrap-kubeconfig=C:\k\bootstrap-kubeconfig.yaml" `
  "--kubeconfig=C:\k\config.yaml" `
  "--node-labels=kubernetes.io/os=windows"

Start-Service kubelet
```

**Verify from Linux control plane:**

```bash
kubectl get nodes -o wide
# NAME               STATUS   ROLES           AGE   VERSION   OS-IMAGE
# control-plane-01   Ready    control-plane   10d   v1.29.3   Ubuntu 22.04.4 LTS
# linux-worker-01    Ready    <none>          10d   v1.29.3   Ubuntu 22.04.4 LTS
# windows-node-01    Ready    <none>          5m    v1.29.3   Windows Server 2022 Datacenter

kubectl describe node windows-node-01 | grep -E "os|arch|kernel"
# beta.kubernetes.io/arch=amd64
# beta.kubernetes.io/os=windows
# kubernetes.io/arch=amd64
# kubernetes.io/os=windows
```

## Section 3: Scheduling Windows Workloads

Windows pods must include a `nodeSelector` for `kubernetes.io/os: windows`. Without it, the scheduler may attempt to place the pod on a Linux node, which will fail at image pull time.

```yaml
# windows-iis.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: iis-app
  namespace: dotnet-apps
spec:
  replicas: 2
  selector:
    matchLabels:
      app: iis
  template:
    metadata:
      labels:
        app: iis
    spec:
      # Required: target Windows nodes
      nodeSelector:
        kubernetes.io/os: windows
      # Required: tolerate the NoSchedule taint on Windows nodes
      tolerations:
        - key: "os"
          operator: "Equal"
          value: "windows"
          effect: "NoSchedule"
      containers:
        - name: iis
          image: mcr.microsoft.com/windows/servercore/iis:windowsservercore-ltsc2022
          ports:
            - containerPort: 80
              protocol: TCP
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 5
          livenessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 60
            periodSeconds: 20
```

Add a taint to all Windows nodes so Linux workloads are never placed there:

```bash
kubectl taint nodes windows-node-01 os=windows:NoSchedule
```

Verify scheduling worked:

```bash
kubectl get pods -n dotnet-apps -o wide
# NAME                       READY   STATUS    NODE
# iis-app-5d9f7c-xxx         1/1     Running   windows-node-01
```

## Section 4: Windows Container Base Images

Windows containers require a base image that matches the host OS version. This is a hard constraint: a container built on Server 2022 (build 20348) will not run on Server 2019 (build 17763).

| Use case | Image | Size |
|----------|-------|------|
| Full .NET Framework | `mcr.microsoft.com/dotnet/framework/aspnet:4.8-windowsservercore-ltsc2022` | ~8 GB |
| .NET 8 apps | `mcr.microsoft.com/dotnet/aspnet:8.0-nanoserver-ltsc2022` | ~300 MB |
| Minimal shell | `mcr.microsoft.com/windows/nanoserver:ltsc2022` | ~100 MB |
| Full Windows | `mcr.microsoft.com/windows/servercore:ltsc2022` | ~5 GB |

Dockerfile for a .NET Framework 4.8 app:

```dockerfile
FROM mcr.microsoft.com/dotnet/framework/sdk:4.8-windowsservercore-ltsc2022 AS build
WORKDIR /src
COPY MyApp.sln .
COPY MyApp/*.csproj MyApp/
RUN nuget restore
COPY . .
RUN msbuild MyApp/MyApp.csproj /p:Configuration=Release /p:OutputPath=C:\output

FROM mcr.microsoft.com/dotnet/framework/aspnet:4.8-windowsservercore-ltsc2022
WORKDIR /inetpub/wwwroot
COPY --from=build C:\output\. .

# IIS configuration via PowerShell
RUN powershell -Command \
    Import-Module WebAdministration; \
    New-WebApplication -Name "myapp" -PhysicalPath "C:\inetpub\wwwroot" -Site "Default Web Site"

EXPOSE 80
```

Build the multi-stage image:

```bash
# Build requires Docker Desktop or a Windows build agent
docker build -t myregistry.azurecr.io/myapp:v1.0.0 -f Dockerfile.windows .
docker push myregistry.azurecr.io/myapp:v1.0.0
```

## Section 5: Windows Limitations vs Linux

Key limitations to communicate to development teams:

```yaml
# These Linux patterns DO NOT work on Windows:

# 1. No exec into a running container
# kubectl exec -it windows-pod -- cmd.exe
# Error: exec: not supported on Windows

# Workaround: Use HostProcess containers for debugging
# Or use PowerShell remoting

# 2. No network policies enforcement by Calico/Cilium
# NetworkPolicy objects are parsed but not enforced on Windows nodes
# Use application-level firewalling or Antrea which has partial support

# 3. No runAsNonRoot without HostProcess
# Windows containers run as ContainerAdministrator by default

# 4. No security contexts: seccomp, apparmor
# These are Linux-only kernel features
```

Windows-compatible securityContext:

```yaml
securityContext:
  # Windows-compatible: use runAsUserName
  windowsOptions:
    runAsUserName: "ContainerUser"  # vs ContainerAdministrator
  # These Linux-only fields are ignored on Windows:
  # runAsNonRoot: true       <- ignored
  # seccompProfile: ...      <- ignored
  # appArmorProfile: ...     <- ignored
```

## Section 6: Persistent Storage with SMB CSI Driver

Windows containers cannot use iSCSI, NFS (without Cygwin), or most Linux-native storage. SMB (CIFS) is the primary supported persistent storage driver.

Install the SMB CSI driver:

```bash
helm repo add csi-driver-smb https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts
helm install csi-driver-smb csi-driver-smb/csi-driver-smb \
  --namespace kube-system \
  --version v1.14.0 \
  --set windows.enabled=true \
  --set linux.enabled=true
```

Create a StorageClass for SMB:

```yaml
# smb-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: smb-storage
provisioner: smb.csi.k8s.io
parameters:
  source: "//fileserver.corp.example.com/k8s-volumes"
  subDir: "${pvc.metadata.namespace}/${pvc.metadata.name}"
  csi.storage.k8s.io/provisioner-secret-name: smb-creds
  csi.storage.k8s.io/provisioner-secret-namespace: kube-system
  csi.storage.k8s.io/node-stage-secret-name: smb-creds
  csi.storage.k8s.io/node-stage-secret-namespace: kube-system
reclaimPolicy: Retain
volumeBindingMode: Immediate
mountOptions:
  - dir_mode=0777
  - file_mode=0777
  - uid=0
  - gid=0
  - mfsymlinks
  - cache=strict
  - noserverino
```

```yaml
# smb-creds secret
apiVersion: v1
kind: Secret
metadata:
  name: smb-creds
  namespace: kube-system
type: Opaque
stringData:
  username: "svc-k8s-storage"
  password: "Secr3tP@ssword!"
```

```yaml
# PVC using SMB storage
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: iis-data
  namespace: dotnet-apps
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: smb-storage
  resources:
    requests:
      storage: 50Gi
---
# Mount in Windows pod
apiVersion: apps/v1
kind: Deployment
metadata:
  name: iis-with-storage
  namespace: dotnet-apps
spec:
  replicas: 1
  selector:
    matchLabels:
      app: iis-storage
  template:
    metadata:
      labels:
        app: iis-storage
    spec:
      nodeSelector:
        kubernetes.io/os: windows
      tolerations:
        - key: "os"
          operator: "Equal"
          value: "windows"
          effect: "NoSchedule"
      containers:
        - name: iis
          image: mcr.microsoft.com/windows/servercore/iis:windowsservercore-ltsc2022
          volumeMounts:
            - name: data
              mountPath: C:\inetpub\data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: iis-data
```

## Section 7: Active Directory Authentication

Windows workloads often need to authenticate to AD-integrated services (SQL Server, file shares). Use Group Managed Service Accounts (gMSA) for this.

**Setup gMSA on Active Directory:**

```powershell
# On Domain Controller
Install-WindowsFeature RSAT-AD-PowerShell

# Create a security group for nodes
New-ADGroup -Name "K8sWindowsNodes" -GroupScope Global -GroupCategory Security

# Add Windows nodes to the group
Add-ADGroupMember -Identity "K8sWindowsNodes" -Members "windows-node-01$"

# Create the gMSA
New-ADServiceAccount `
  -Name "k8s-webapp" `
  -DNSHostName "k8s-webapp.corp.example.com" `
  -PrincipalsAllowedToRetrieveManagedPassword "K8sWindowsNodes" `
  -KerberosEncryptionType AES256

# Create a credential spec on the Windows node
Install-Module -Name CredentialSpec
New-CredentialSpec -Name "k8s-webapp" -AccountName "k8s-webapp"
# Creates: C:\ProgramData\Docker\CredentialSpecs\k8s-webapp.json
```

**Create a Kubernetes CredentialSpec resource:**

```yaml
apiVersion: windows.k8s.io/v1
kind: GMSACredentialSpec
metadata:
  name: webapp-gmsa-spec
credspec:
  ActiveDirectoryConfig:
    GroupManagedServiceAccounts:
      - Name: k8s-webapp
        Scope: CORP
    HostAccountConfig:
      PluginGUID: "{CCC2A336-D7F3-4818-A213-272B7924213E}"
      PortableCcgPlugin: "1"
      PluginInput:
        CredentialArn: "arn:aws:ssm:us-east-1:123456789:parameter/gmsa-password"
  CmsPlugins:
    - "ActiveDirectory"
  DomainJoinConfig:
    DnsName: "CORP.EXAMPLE.COM"
    DnsTreeName: "EXAMPLE.COM"
    Guid: "deadbeef-1234-5678-abcd-000000000000"
    MachineAccountName: "k8s-webapp"
    NetBiosName: "CORP"
    Sid: "S-1-5-21-1234567890-..."
```

```yaml
# Pod using gMSA
apiVersion: v1
kind: Pod
metadata:
  name: ad-auth-app
  namespace: dotnet-apps
spec:
  nodeSelector:
    kubernetes.io/os: windows
  tolerations:
    - key: "os"
      operator: "Equal"
      value: "windows"
      effect: "NoSchedule"
  securityContext:
    windowsOptions:
      gmsaCredentialSpecName: webapp-gmsa-spec
  containers:
    - name: app
      image: myregistry.azurecr.io/myapp:v1.0.0
      env:
        - name: ASPNETCORE_ENVIRONMENT
          value: Production
        - name: ConnectionStrings__Default
          value: "Server=sqlserver.corp.example.com;Database=AppDB;Integrated Security=true"
```

## Section 8: Monitoring Windows Nodes

The standard `kube-state-metrics` covers Kubernetes objects, but Windows node metrics need the Windows exporter:

```powershell
# Install windows_exporter on Windows node
$version = "0.25.1"
$url = "https://github.com/prometheus-community/windows_exporter/releases/download/v$version/windows_exporter-$version-amd64.msi"
Invoke-WebRequest -Uri $url -OutFile windows_exporter.msi
msiexec /i windows_exporter.msi ENABLED_COLLECTORS="cpu,memory,logical_disk,net,os,service,container" /quiet

# Verify
Invoke-WebRequest http://localhost:9182/metrics | Select-Object -First 20
```

Prometheus scrape config:

```yaml
# prometheus-scrape-windows.yaml
- job_name: 'windows-nodes'
  static_configs:
    - targets:
        - 'windows-node-01:9182'
        - 'windows-node-02:9182'
  relabel_configs:
    - source_labels: [__address__]
      regex: '([^:]+):.+'
      target_label: node
      replacement: '$1'
  metric_relabel_configs:
    - source_labels: [__name__]
      regex: 'windows_(cpu|memory|logical_disk|net).*'
      action: keep
```

Grafana dashboard for Windows nodes (import dashboard ID 14694 for Windows Node Exporter).

Alert rules for Windows node health:

```yaml
# windows-alerts.yaml
groups:
  - name: windows-nodes
    rules:
      - alert: WindowsNodeHighMemoryUsage
        expr: |
          (1 - (windows_memory_available_bytes / windows_cs_physical_memory_bytes)) > 0.90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Windows node {{ $labels.node }} memory usage > 90%"

      - alert: WindowsContainerOOMKill
        expr: |
          increase(windows_container_memory_failcnt_total[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Windows container OOM kill on {{ $labels.node }}"

      - alert: WindowsNodeDiskLow
        expr: |
          (windows_logical_disk_free_bytes / windows_logical_disk_size_bytes) < 0.15
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Windows node {{ $labels.node }} disk {{ $labels.volume }} < 15% free"
```

Running Windows workloads in Kubernetes requires operational discipline around OS version pinning, gMSA lifecycle management, and storage drivers. The constraints are real but manageable for teams that understand the scope. For organizations running hybrid .NET Framework + .NET 8 workloads, mixed clusters reduce infrastructure fragmentation while Linux takes the bulk of new cloud-native development.
