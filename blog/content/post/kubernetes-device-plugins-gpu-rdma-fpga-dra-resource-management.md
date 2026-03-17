---
title: "Kubernetes Device Plugins: GPU, RDMA, and FPGA Resource Management with Dynamic Resource Allocation"
date: 2032-01-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GPU", "RDMA", "FPGA", "Device Plugins", "DRA", "NVIDIA", "Resource Management"]
categories:
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes device plugins for GPU, RDMA, and FPGA resources. Covers the plugin framework, gRPC API, NVIDIA GPU operator, Mellanox RDMA, Xilinx FPGA management, and the new Dynamic Resource Allocation (DRA) API replacing the extended resources model."
more_link: "yes"
url: "/kubernetes-device-plugins-gpu-rdma-fpga-dra-resource-management/"
---

Modern AI/ML workloads, high-frequency trading platforms, and scientific computing clusters all share a common requirement: direct access to specialized hardware resources. Kubernetes device plugins provide the extension mechanism for exposing GPUs, RDMA NICs, FPGAs, and other exotic hardware to workloads, while the newer Dynamic Resource Allocation (DRA) API offers a more expressive model for complex resource topologies. This guide covers both in production depth.

<!--more-->

# Kubernetes Device Plugins: GPU, RDMA, and FPGA Resource Management

## The Device Plugin Framework

The device plugin framework provides a gRPC-based interface between a device plugin daemon (running as a DaemonSet) and the kubelet. Plugins register themselves, advertise resources, allocate devices to containers, and optionally perform health monitoring.

### Plugin Lifecycle

```
Registration -> ListAndWatch -> Allocate -> (PreStartContainer) -> (GetPreferredAllocation)
```

The plugin communicates with kubelet over a Unix domain socket under `/var/lib/kubelet/device-plugins/`. The registration socket is at `/var/lib/kubelet/device-plugins/kubelet.sock`.

### gRPC API Surface

The device plugin API is defined in `k8s.io/kubelet/pkg/apis/deviceplugin/v1beta1`:

```protobuf
service DevicePlugin {
  rpc GetDevicePluginOptions(Empty) returns (DevicePluginOptions);
  rpc ListAndWatch(Empty) returns (stream ListAndWatchResponse);
  rpc GetPreferredAllocation(PreferredAllocationRequest)
      returns (PreferredAllocationResponse);
  rpc Allocate(AllocateRequest) returns (AllocateResponse);
  rpc PreStartContainer(PreStartContainerRequest)
      returns (PreStartContainerResponse);
}
```

`ListAndWatch` is a server-side streaming RPC. The plugin continuously sends device health updates to kubelet. When kubelet restarts, plugins must re-register.

## Writing a Minimal Device Plugin

The following implements a skeleton plugin in Go. This is the pattern used by all production plugins before they add vendor-specific logic.

```go
package main

import (
    "context"
    "log"
    "net"
    "os"
    "path"
    "time"

    "google.golang.org/grpc"
    pluginapi "k8s.io/kubelet/pkg/apis/deviceplugin/v1beta1"
)

const (
    resourceNamespace = "example.com"
    resourceName      = "mydevice"
    socketName        = "example-mydevice.sock"
    deviceCount       = 4
)

type MyDevicePlugin struct {
    devices []*pluginapi.Device
    server  *grpc.Server
    socket  string
}

func NewMyDevicePlugin() *MyDevicePlugin {
    devices := make([]*pluginapi.Device, deviceCount)
    for i := 0; i < deviceCount; i++ {
        devices[i] = &pluginapi.Device{
            ID:     fmt.Sprintf("device-%d", i),
            Health: pluginapi.Healthy,
        }
    }
    return &MyDevicePlugin{
        devices: devices,
        socket:  path.Join(pluginapi.DevicePluginPath, socketName),
    }
}

func (p *MyDevicePlugin) GetDevicePluginOptions(
    ctx context.Context, e *pluginapi.Empty,
) (*pluginapi.DevicePluginOptions, error) {
    return &pluginapi.DevicePluginOptions{
        PreStartRequired:                false,
        GetPreferredAllocationAvailable: true,
    }, nil
}

func (p *MyDevicePlugin) ListAndWatch(
    e *pluginapi.Empty,
    stream pluginapi.DevicePlugin_ListAndWatchServer,
) error {
    // Send initial device list
    if err := stream.Send(&pluginapi.ListAndWatchResponse{
        Devices: p.devices,
    }); err != nil {
        return err
    }

    // Health monitoring loop
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            // Re-check device health here
            if err := stream.Send(&pluginapi.ListAndWatchResponse{
                Devices: p.devices,
            }); err != nil {
                return err
            }
        case <-stream.Context().Done():
            return nil
        }
    }
}

func (p *MyDevicePlugin) GetPreferredAllocation(
    ctx context.Context,
    req *pluginapi.PreferredAllocationRequest,
) (*pluginapi.PreferredAllocationResponse, error) {
    resp := &pluginapi.PreferredAllocationResponse{}
    for _, r := range req.ContainerRequests {
        // Prefer devices with lowest NUMA distance to CPU
        // (simplified: just return first N available)
        ids := r.AvailableDeviceIDs[:r.AllocationSize]
        resp.ContainerResponses = append(
            resp.ContainerResponses,
            &pluginapi.ContainerPreferredAllocationResponse{
                DeviceIDs: ids,
            },
        )
    }
    return resp, nil
}

func (p *MyDevicePlugin) Allocate(
    ctx context.Context,
    reqs *pluginapi.AllocateRequest,
) (*pluginapi.AllocateResponse, error) {
    resp := &pluginapi.AllocateResponse{}
    for _, req := range reqs.ContainerRequests {
        cresp := &pluginapi.ContainerAllocateResponse{}
        for _, devID := range req.DevicesIDs {
            // Map device ID to /dev node
            devPath := fmt.Sprintf("/dev/mydevice%s", devID[len("device-"):])
            cresp.Devices = append(cresp.Devices, &pluginapi.DeviceSpec{
                ContainerPath: devPath,
                HostPath:      devPath,
                Permissions:   "rw",
            })
            // Inject environment variable
            cresp.Envs = map[string]string{
                "MY_DEVICE_ID": devID,
            }
        }
        resp.ContainerResponses = append(resp.ContainerResponses, cresp)
    }
    return resp, nil
}

func (p *MyDevicePlugin) Register() error {
    conn, err := grpc.Dial(
        pluginapi.KubeletSocket,
        grpc.WithInsecure(),
        grpc.WithDialer(func(addr string, timeout time.Duration) (net.Conn, error) {
            return net.DialTimeout("unix", addr, timeout)
        }),
    )
    if err != nil {
        return err
    }
    defer conn.Close()

    client := pluginapi.NewRegistrationClient(conn)
    _, err = client.Register(context.Background(), &pluginapi.RegisterRequest{
        Version:      pluginapi.Version,
        Endpoint:     socketName,
        ResourceName: resourceNamespace + "/" + resourceName,
        Options: &pluginapi.DevicePluginOptions{
            GetPreferredAllocationAvailable: true,
        },
    })
    return err
}
```

## NVIDIA GPU Plugin: Production Configuration

The NVIDIA device plugin exposes `nvidia.com/gpu` resources. The GPU Operator bundles the plugin with drivers, MIG configuration, container toolkit, and DCGM exporter.

### GPU Operator Deployment

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: gpu-operator
  labels:
    pod-security.kubernetes.io/enforce: privileged
---
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: gpu-operator
  namespace: gpu-operator
spec:
  interval: 10m
  chart:
    spec:
      chart: gpu-operator
      version: "v24.3.0"
      sourceRef:
        kind: HelmRepository
        name: nvidia
        namespace: flux-system
  values:
    operator:
      defaultRuntime: containerd
    driver:
      enabled: true
      version: "550.54.15"
      rdma:
        enabled: true
        useHostMofed: false
    toolkit:
      enabled: true
    devicePlugin:
      enabled: true
      config:
        name: device-plugin-config
        default: "default"
    dcgmExporter:
      enabled: true
      config:
        name: dcgm-exporter-metrics
    mig:
      strategy: mixed
    validator:
      plugin:
        env:
          - name: WITH_WORKLOAD
            value: "true"
```

### MIG (Multi-Instance GPU) Configuration

MIG partitions an A100 or H100 GPU into isolated instances. Each instance has guaranteed compute and memory bandwidth.

```yaml
# ConfigMap for MIG strategy
apiVersion: v1
kind: ConfigMap
metadata:
  name: device-plugin-config
  namespace: gpu-operator
data:
  default: |
    version: v1
    flags:
      migStrategy: mixed
  mig-single: |
    version: v1
    flags:
      migStrategy: single
    mig-configs:
      all-1g.10gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7
  mig-mixed: |
    version: v1
    flags:
      migStrategy: mixed
    mig-configs:
      custom-config:
        - devices: [0,1,2,3]
          mig-enabled: true
          mig-devices:
            "3g.40gb": 2
        - devices: [4,5,6,7]
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7
```

Label nodes to select MIG profile:

```bash
kubectl label node gpu-node-01 nvidia.com/mig.config=mig-mixed
```

### GPU Resource Requests

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-workload
spec:
  runtimeClassName: nvidia
  containers:
  - name: cuda-job
    image: nvcr.io/nvidia/cuda:12.4.0-runtime-ubuntu22.04
    command: ["/bin/bash", "-c", "nvidia-smi && sleep infinity"]
    resources:
      limits:
        nvidia.com/gpu: 1
        # MIG slice:
        # nvidia.com/mig-3g.40gb: 1
  nodeSelector:
    nvidia.com/gpu.present: "true"
    nvidia.com/gpu.product: "A100-SXM4-80GB"
  tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
```

### DCGM Exporter Metrics

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dcgm-exporter-metrics
  namespace: gpu-operator
data:
  dcgm-metrics.csv: |
    # GPU Utilization
    DCGM_FI_DEV_GPU_UTIL,      gauge, GPU utilization (in %).
    DCGM_FI_DEV_MEM_COPY_UTIL, gauge, Memory utilization (in %).
    # Temperature
    DCGM_FI_DEV_GPU_TEMP,      gauge, GPU temperature (in C).
    DCGM_FI_DEV_MEMORY_TEMP,   gauge, Memory temperature (in C).
    # Power
    DCGM_FI_DEV_POWER_USAGE,   gauge, Power draw (in W).
    DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION, counter, Total energy consumption (in mJ).
    # Memory
    DCGM_FI_DEV_FB_FREE,       gauge, Framebuffer memory free (in MiB).
    DCGM_FI_DEV_FB_USED,       gauge, Framebuffer memory used (in MiB).
    # PCIe
    DCGM_FI_DEV_PCIE_TX_THROUGHPUT, counter, PCIe Tx throughput (in KB/s).
    DCGM_FI_DEV_PCIE_RX_THROUGHPUT, counter, PCIe Rx throughput (in KB/s).
    # NVLink
    DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL, counter, NVLink bandwidth total (in KB/s).
    # Errors
    DCGM_FI_DEV_ECC_SBE_VOL_TOTAL, counter, Total single-bit ECC errors.
    DCGM_FI_DEV_ECC_DBE_VOL_TOTAL, counter, Total double-bit ECC errors.
    DCGM_FI_DEV_XID_ERRORS,    gauge,   Value of the last XID error.
```

## RDMA Device Plugin: High-Performance Networking

RDMA (Remote Direct Memory Access) enables zero-copy networking for MPI workloads, distributed AI training, and storage protocols (NVMe-oF, iSER). The Mellanox/NVIDIA Network Operator manages RDMA resources.

### Network Operator Installation

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: network-operator
  namespace: network-operator
spec:
  chart:
    spec:
      chart: network-operator
      version: "24.1.0"
      sourceRef:
        kind: HelmRepository
        name: nvidia-network
        namespace: flux-system
  values:
    deployCR: true
    nfd:
      enabled: true
    rdmaSharedDevicePlugin:
      deploy: true
    sriovDevicePlugin:
      deploy: true
    ibKubernetes:
      deploy: true
    ofedDriver:
      deploy: true
      image: mofed
      repository: nvcr.io/nvidia/mellanox
      version: "24.01-0.3.3.1"
```

### NicClusterPolicy

```yaml
apiVersion: mellanox.com/v1alpha1
kind: NicClusterPolicy
metadata:
  name: nic-cluster-policy
spec:
  ofedDriver:
    image: mofed
    repository: nvcr.io/nvidia/mellanox
    version: "24.01-0.3.3.1"
    startupProbe:
      initialDelaySeconds: 10
      failureThreshold: 20
    livenessProbe:
      initialDelaySeconds: 30
      failureThreshold: 3
    readinessProbe:
      initialDelaySeconds: 10
      failureThreshold: 3
  rdmaSharedDevicePlugin:
    image: k8s-rdma-shared-dev-plugin
    repository: ghcr.io/mellanox
    version: sha-4f3eb1c
    config: |
      {
        "configList": [
          {
            "resourceName": "hca_shared_devices_a",
            "rdmaHcaMax": 63,
            "selectors": {
              "vendors": ["15b3"],
              "deviceIDs": ["101b"],
              "ifNames": ["ens2f0"]
            }
          }
        ]
      }
  sriovDevicePlugin:
    image: sriov-device-plugin
    repository: ghcr.io/k8snetworkplumbingwg
    version: v3.7.0
    config: |
      {
        "resourceList": [
          {
            "resourceName": "mlnx_sriov_rdma",
            "resourcePrefix": "nvidia.com",
            "selectors": {
              "vendors": ["15b3"],
              "devices": ["1018"],
              "drivers": ["mlx5_core"],
              "isRdma": true,
              "needVhostNet": false
            }
          }
        ]
      }
```

### RDMA Workload Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: rdma-mpi-worker
  annotations:
    k8s.v1.cni.cncf.io/networks: rdma-net
spec:
  containers:
  - name: mpi-worker
    image: nvcr.io/nvidia/mellanox/hpc-benchmarks:24.03
    command: ["/bin/bash", "-c", "ib_write_bw -d mlx5_0 -i 1 && sleep infinity"]
    securityContext:
      capabilities:
        add: ["IPC_LOCK"]
    resources:
      limits:
        memory: 8Gi
        cpu: 4
        nvidia.com/hca_shared_devices_a: 1
    volumeMounts:
    - name: hugepages-2mi
      mountPath: /dev/hugepages
    - name: shm
      mountPath: /dev/shm
  volumes:
  - name: hugepages-2mi
    emptyDir:
      medium: HugePages-2Mi
  - name: shm
    emptyDir:
      medium: Memory
      sizeLimit: 1Gi
  hostIPC: false
  hostNetwork: false
```

## FPGA Device Plugin: Xilinx Alveo

FPGAs provide reconfigurable acceleration for network packet processing, video transcoding, and genomics. The Xilinx (AMD) device plugin manages Alveo cards.

### FPGA Plugin DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fpga-plugin
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: fpga-plugin
  template:
    metadata:
      labels:
        app: fpga-plugin
    spec:
      priorityClassName: system-node-critical
      tolerations:
      - key: CriticalAddonsOnly
        operator: Exists
      - effect: NoSchedule
        operator: Exists
      hostNetwork: false
      hostPID: true
      initContainers:
      - name: install-plugin
        image: xilinx/k8s-device-plugin:latest
        command: ["cp", "/usr/bin/xdma-device-plugin", "/install/"]
        volumeMounts:
        - name: install-dir
          mountPath: /install
      containers:
      - name: fpga-plugin
        image: xilinx/k8s-device-plugin:latest
        imagePullPolicy: Always
        securityContext:
          privileged: true
        env:
        - name: FPGA_RESOURCE_NAMESPACE
          value: "xilinx.com"
        args:
        - --resource-discovery-period=30s
        - --health-check-interval=10s
        volumeMounts:
        - name: device-plugin
          mountPath: /var/lib/kubelet/device-plugins
        - name: dev
          mountPath: /dev
        - name: sys
          mountPath: /sys
      volumes:
      - name: device-plugin
        hostPath:
          path: /var/lib/kubelet/device-plugins
      - name: dev
        hostPath:
          path: /dev
      - name: sys
        hostPath:
          path: /sys
      - name: install-dir
        hostPath:
          path: /opt/xilinx/plugin
```

### FPGA Bitstream Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fpga-bitstream-config
  namespace: fpga-workloads
data:
  bitstream-map.json: |
    {
      "bitstreamList": [
        {
          "uuid": "d3fcb60a-0000-0000-1234-5678abcdef01",
          "dsaName": "xilinx_u250_gen3x16_xdma_base_4",
          "shell": "u250-base-4",
          "platformName": "xilinx_u250",
          "bitstreamPath": "/opt/xilinx/bitstreams/alveo_u250_smartnic.xclbin"
        },
        {
          "uuid": "f8a2c100-0000-0000-abcd-ef0123456789",
          "dsaName": "xilinx_u55c_gen3x16_xdma_base_2",
          "shell": "u55c-base-2",
          "platformName": "xilinx_u55c",
          "bitstreamPath": "/opt/xilinx/bitstreams/alveo_u55c_hpc.xclbin"
        }
      ]
    }
```

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: fpga-smartnic-workload
spec:
  containers:
  - name: alveo-app
    image: myregistry/smartnic-app:v2.1
    resources:
      limits:
        xilinx.com/fpga-xilinx_u250_gen3x16_xdma_base_4-0: 1
    volumeMounts:
    - name: bitstreams
      mountPath: /opt/xilinx/bitstreams
      readOnly: true
  volumes:
  - name: bitstreams
    configMap:
      name: fpga-bitstream-config
  nodeSelector:
    fpga.xilinx.com/present: "true"
```

## Dynamic Resource Allocation (DRA)

DRA (KEP-3063) replaces the extended resources + device plugin model with a structured API. It is GA in Kubernetes 1.32. DRA decouples resource claiming from scheduling, supports complex topology constraints, and enables structured parameters.

### DRA Core Objects

**ResourceClass** — defines a class of resources and the driver responsible:

```yaml
apiVersion: resource.k8s.io/v1alpha3
kind: ResourceClass
metadata:
  name: gpu.nvidia.com
spec:
  driverName: gpu.nvidia.com
  parametersRef:
    apiGroup: gpu.resource.nvidia.com
    kind: DeviceClassParameters
    name: default-gpu-params
---
apiVersion: gpu.resource.nvidia.com/v1alpha1
kind: DeviceClassParameters
metadata:
  name: default-gpu-params
spec:
  config:
  - name: default
    spec:
      sharing:
        strategy: TimeSlicing
        timeSlicingConfig:
          interval: Default
```

**ResourceClaimTemplate** — allows workloads to request resources:

```yaml
apiVersion: resource.k8s.io/v1alpha3
kind: ResourceClaimTemplate
metadata:
  name: single-gpu
  namespace: ml-workloads
spec:
  spec:
    resourceClassName: gpu.nvidia.com
    parametersRef:
      apiGroup: gpu.resource.nvidia.com
      kind: GpuClaimParameters
      name: single-unshared-gpu
---
apiVersion: gpu.resource.nvidia.com/v1alpha1
kind: GpuClaimParameters
metadata:
  name: single-unshared-gpu
  namespace: ml-workloads
spec:
  count: 1
  selector:
    computeCapability:
      majorMinorVersion:
        min: "8.0"
  sharing:
    strategy: None
```

**Pod with DRA claim:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: dra-training-job
  namespace: ml-workloads
spec:
  containers:
  - name: trainer
    image: nvcr.io/nvidia/pytorch:24.03-py3
    command: ["torchrun", "--nproc_per_node=1", "train.py"]
    resources:
      claims:
      - name: gpu
  resourceClaims:
  - name: gpu
    source:
      resourceClaimTemplateName: single-gpu
```

### DRA Driver Implementation

A DRA driver runs as a DaemonSet per node and implements the `NodeResourceManager` gRPC interface:

```go
package driver

import (
    "context"

    resourcev1alpha3 "k8s.io/api/resource/v1alpha3"
    "k8s.io/dynamic-resource-allocation/controller"
)

type NvidiaGPUDriver struct {
    nodeName string
    gpus     []*GPU
}

// Implement controller.Interface for cluster-level allocation
func (d *NvidiaGPUDriver) GetClassParameters(
    ctx context.Context,
    class *resourcev1alpha3.ResourceClass,
) (interface{}, error) {
    // Decode class parameters from structured object
    return decodeClassParams(class.ParametersRef)
}

func (d *NvidiaGPUDriver) GetClaimParameters(
    ctx context.Context,
    claim *resourcev1alpha3.ResourceClaim,
    class *resourcev1alpha3.ResourceClass,
    classParameters interface{},
) (interface{}, error) {
    return decodeClaimParams(claim.Spec.ParametersRef)
}

func (d *NvidiaGPUDriver) Allocate(
    ctx context.Context,
    claims []*controller.ClaimAllocation,
    selectedNode string,
) error {
    for _, ca := range claims {
        claimParams := ca.ClaimParameters.(*GpuClaimParameters)
        // Select GPUs from available pool on selectedNode
        allocated := d.selectGPUs(selectedNode, claimParams)
        ca.Allocation = &resourcev1alpha3.AllocationResult{
            ResourceHandles: []resourcev1alpha3.ResourceHandle{
                {
                    DriverName: "gpu.nvidia.com",
                    Data:       encodeAllocationData(allocated),
                },
            },
            AvailableOnNodes: nodeSelector(selectedNode),
            Shareable:        claimParams.Sharing.Strategy != "None",
        }
    }
    return nil
}

func (d *NvidiaGPUDriver) Deallocate(
    ctx context.Context,
    claim *resourcev1alpha3.ResourceClaim,
) error {
    return d.releaseGPUs(claim.Status.Allocation)
}
```

### DRA with Structured Parameters (Kubernetes 1.31+)

Structured parameters move allocation logic into the scheduler, eliminating the driver webhook round-trip:

```yaml
apiVersion: resource.k8s.io/v1alpha3
kind: ResourceSlice
metadata:
  name: gpu-node-01-resources
spec:
  driver: gpu.nvidia.com
  pool:
    name: gpu-node-01
    generation: 1
    resourceSliceCount: 1
  nodeName: gpu-node-01
  devices:
  - name: gpu-0
    basic:
      attributes:
        computeCapabilityMajor:
          int: 9
        computeCapabilityMinor:
          int: 0
        productName:
          string: "H100 SXM5 80GB"
      capacity:
        memory:
          value: "80Gi"
  - name: gpu-1
    basic:
      attributes:
        computeCapabilityMajor:
          int: 9
        computeCapabilityMinor:
          int: 0
        productName:
          string: "H100 SXM5 80GB"
      capacity:
        memory:
          value: "80Gi"
```

```yaml
apiVersion: resource.k8s.io/v1alpha3
kind: ResourceClaim
metadata:
  name: two-h100s
  namespace: ml-workloads
spec:
  devices:
    requests:
    - name: gpu
      deviceClassName: gpu.nvidia.com
      count: 2
      selectors:
      - cel:
          expression: >
            device.attributes["gpu.nvidia.com"].productName.startsWith("H100")
            && device.capacity["gpu.nvidia.com"].memory.compareTo(quantity("79Gi")) >= 0
    constraints:
    - requests: ["gpu"]
      matchAttribute: "gpu.nvidia.com/numaNode"
```

## Topology-Aware Scheduling with Device Plugins

The Topology Manager aligns device allocations with CPU NUMA topology:

```yaml
# kubelet configuration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: best-effort
# Options: none | best-effort | restricted | single-numa-node
topologyManagerScope: container
# Options: container | pod
reservedSystemCPUs: "0-3"
cpuManagerPolicy: static
memoryManagerPolicy: Static
reservedMemory:
- numaNode: 0
  limits:
    memory: "1Gi"
- numaNode: 1
  limits:
    memory: "1Gi"
```

Verify topology alignment:

```bash
# Check topology hints from device plugin
kubectl get node gpu-node-01 -o json | \
  jq '.status.allocatable | with_entries(select(.key | startswith("nvidia")))'

# Check CPU manager state
ssh gpu-node-01 cat /var/lib/kubelet/cpu_manager_state | jq .

# Verify NUMA allocation for running pod
kubectl exec -n ml-workloads gpu-pod -- numactl --show
kubectl exec -n ml-workloads gpu-pod -- nvidia-smi topo -m
```

## Device Plugin Health Monitoring

Implementing robust health checks prevents scheduling to unhealthy devices:

```go
func (p *NvidiaGPUPlugin) checkDeviceHealth() {
    nvmlReturn := nvml.Init()
    if nvmlReturn != nvml.SUCCESS {
        log.Fatalf("Failed to initialize NVML: %v", nvml.ErrorString(nvmlReturn))
    }
    defer nvml.Shutdown()

    count, ret := nvml.DeviceGetCount()
    if ret != nvml.SUCCESS {
        return
    }

    for i := 0; i < count; i++ {
        device, ret := nvml.DeviceGetHandleByIndex(i)
        if ret != nvml.SUCCESS {
            p.markUnhealthy(fmt.Sprintf("gpu-%d", i), "failed to get handle")
            continue
        }

        // Check for XID errors
        errorInfo, ret := device.GetLastBistatus()

        // Check ECC errors
        sbeCount, ret := device.GetTotalEccErrors(
            nvml.MEMORY_ERROR_TYPE_CORRECTED,
            nvml.VOLATILE_ECC,
        )
        dbeCount, ret := device.GetTotalEccErrors(
            nvml.MEMORY_ERROR_TYPE_UNCORRECTED,
            nvml.VOLATILE_ECC,
        )

        if dbeCount > 0 {
            p.markUnhealthy(fmt.Sprintf("gpu-%d", i),
                fmt.Sprintf("double-bit ECC errors: %d", dbeCount))
            continue
        }

        // Check thermal state
        temp, ret := device.GetTemperature(nvml.TEMPERATURE_GPU)
        if ret == nvml.SUCCESS && temp > 90 {
            // Warn but don't mark unhealthy until threshold exceeded
            p.recorder.Event(p.node, v1.EventTypeWarning,
                "GPUHighTemperature",
                fmt.Sprintf("GPU %d temperature %d°C exceeds warning threshold", i, temp))
        }

        _ = errorInfo
        p.markHealthy(fmt.Sprintf("gpu-%d", i))
    }
}
```

## Operational Considerations

### Node Feature Discovery Integration

```yaml
apiVersion: nfd.k8s-sigs.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: gpu-feature-rules
spec:
  rules:
  - name: nvidia-gpu-features
    labels:
      nvidia.com/cuda.driver.major: "@nvidia.com/cuda.driver.major"
      nvidia.com/cuda.runtime.major: "@nvidia.com/cuda.runtime.major"
    taints:
    - key: nvidia.com/gpu
      value: present
      effect: NoSchedule
    matchFeatures:
    - feature: pci.device
      matchExpressions:
        vendor:
          op: In
          value: ["10de"]  # NVIDIA vendor ID
        class:
          op: In
          value: ["0302", "0300"]  # Display controllers
```

### Monitoring and Alerting

```yaml
# PrometheusRule for GPU health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gpu-alerts
  namespace: monitoring
spec:
  groups:
  - name: gpu.rules
    rules:
    - alert: GPUHighTemperature
      expr: DCGM_FI_DEV_GPU_TEMP > 85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "GPU temperature critical on {{ $labels.instance }}"
        description: "GPU {{ $labels.gpu }} temperature is {{ $value }}°C"

    - alert: GPUMemoryECCErrors
      expr: increase(DCGM_FI_DEV_ECC_DBE_VOL_TOTAL[1h]) > 0
      for: 0m
      labels:
        severity: critical
      annotations:
        summary: "Double-bit ECC errors detected on GPU"
        description: "GPU {{ $labels.gpu }} on {{ $labels.instance }} has double-bit ECC errors"

    - alert: GPUXIDError
      expr: DCGM_FI_DEV_XID_ERRORS > 0
      for: 0m
      labels:
        severity: critical
      annotations:
        summary: "GPU XID error detected"
        description: "XID {{ $value }} on GPU {{ $labels.gpu }}"

    - alert: GPUHighUtilization
      expr: DCGM_FI_DEV_GPU_UTIL > 95
      for: 30m
      labels:
        severity: info
      annotations:
        summary: "GPU sustained high utilization"
```

### Troubleshooting Common Issues

**Plugin socket not found:**
```bash
ls -la /var/lib/kubelet/device-plugins/
# Expected: nvidia.com-gpu.sock, kubelet.sock

# Check plugin DaemonSet
kubectl get pods -n gpu-operator -l app=nvidia-device-plugin-daemonset
kubectl logs -n gpu-operator -l app=nvidia-device-plugin-daemonset --tail=50

# Restart kubelet if plugin socket is stale
systemctl restart kubelet
```

**Resources not allocatable:**
```bash
kubectl describe node gpu-node-01 | grep -A 20 "Allocatable"
# Should show: nvidia.com/gpu: 8

# Check if plugin registered successfully
journalctl -u kubelet | grep "device-plugin" | tail -20

# Verify GPU visibility in container
kubectl run gpu-test --image=nvcr.io/nvidia/cuda:12.4.0-base-ubuntu22.04 \
  --rm -it --restart=Never \
  --overrides='{"spec":{"runtimeClassName":"nvidia","containers":[{"name":"gpu-test","image":"nvcr.io/nvidia/cuda:12.4.0-base-ubuntu22.04","command":["nvidia-smi"],"resources":{"limits":{"nvidia.com/gpu":"1"}}}]}}'
```

**DRA driver not allocating:**
```bash
# Check ResourceSlice objects
kubectl get resourceslices -o wide

# Check ResourceClaim status
kubectl describe resourceclaim -n ml-workloads two-h100s

# Check DRA driver logs
kubectl logs -n nvidia-dra-driver -l app=nvidia-dra-driver-controller
kubectl logs -n nvidia-dra-driver -l app=nvidia-dra-driver-kubelet-plugin -c plugin
```

## Summary

Kubernetes device plugins provide the extension point for GPU, RDMA, FPGA, and other hardware acceleration resources. Key operational takeaways:

- Deploy GPU Operator rather than individual components; it handles driver lifecycle, toolkit, and plugin coherently
- Configure the Topology Manager when mixing GPU + RDMA workloads that require NUMA alignment
- Use MIG to increase density for inference workloads where full GPU is wasteful
- Adopt DRA with structured parameters for new hardware types — the scheduler-native allocation model avoids webhook latency and supports complex CEL-based device selection
- Instrument DCGM metrics and alert on XID errors and double-bit ECC events before they cause application failures
- Monitor `ListAndWatch` stream health; a plugin crash does not immediately remove resources but can lead to stale allocations on kubelet restart
