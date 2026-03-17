---
title: "Kubernetes Node Feature Discovery and Device Plugins: GPU, FPGA, and Custom Hardware"
date: 2030-02-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Feature Discovery", "GPU", "Device Plugins", "FPGA", "Hardware Scheduling"]
categories: ["Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy Node Feature Discovery for hardware-aware scheduling, build custom device plugins for specialized hardware, configure GPU time-slicing, and manage FPGA resources in Kubernetes."
more_link: "yes"
url: "/kubernetes-node-feature-discovery-device-plugins/"
---

Modern Kubernetes clusters often run on heterogeneous hardware: some nodes carry GPUs for ML training, others have FPGAs for network acceleration, some have high-speed NVMe arrays, and some have specialized NICs. Placing workloads on the right nodes manually is error-prone and does not scale. Node Feature Discovery (NFD) combined with the Kubernetes Device Plugin framework provides the infrastructure for automatic hardware-aware scheduling that works reliably at scale.

This guide covers deploying and configuring NFD, building custom device plugins for specialized hardware, GPU time-slicing with the NVIDIA operator, FPGA resource management, and resource quotas for device resources.

<!--more-->

## The Hardware Scheduling Problem

Without hardware-aware scheduling, three things go wrong:

1. Workloads land on nodes without the required hardware and fail at startup
2. Cluster administrators must maintain manual nodeSelector labels that drift as hardware changes
3. Capacity planning is impossible without knowing what hardware is actually installed

NFD solves this by running a DaemonSet that interrogates each node's hardware (CPU features, accelerators, memory topology, PCI devices, USB devices, kernel features, OS properties) and publishes that information as node labels. Device plugins solve the complementary problem: making hardware resources (GPUs, FPGAs, SR-IOV VFs) allocatable like CPU and memory.

## Deploying Node Feature Discovery

### Helm Installation

```bash
helm repo add nfd https://kubernetes-sigs.github.io/node-feature-discovery/charts
helm repo update

helm upgrade --install nfd nfd/node-feature-discovery \
    --namespace node-feature-discovery \
    --create-namespace \
    --version 0.15.3 \
    --values nfd-values.yaml
```

```yaml
# nfd-values.yaml
master:
  replicaCount: 1
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: node-role.kubernetes.io/control-plane
                operator: Exists

worker:
  tolerations:
    - operator: "Exists"
      effect: "NoSchedule"
    - operator: "Exists"
      effect: "NoExecute"
  resources:
    requests:
      cpu: 5m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi
  config:
    core:
      sources:
        - cpu
        - custom
        - iommu
        - kernel
        - local
        - memory
        - network
        - pci
        - storage
        - system
        - usb
    sources:
      cpu:
        cpuid:
          attributeBlacklist:
            # Remove noisy CPUID flags that rarely matter for scheduling
            - "BMI1"
            - "BMI2"
            - "CLMUL"
      pci:
        deviceClassWhitelist:
          - "02"   # Network controllers
          - "03"   # Display controllers (GPU)
          - "0200" # Ethernet controllers
          - "0207" # InfiniBand controllers
          - "1200" # Processing accelerators (FPGA)
        deviceLabelFields:
          - class
          - vendor
          - device
          - subsystem_vendor
          - subsystem_device
      usb:
        deviceClassWhitelist:
          - "02"
          - "0e"
          - "ef"
          - "ff"
      custom:
        - name: "intel-fpga"
          matchOn:
            - pciId:
                class: ["1200"]
                vendor: ["8086"]
        - name: "nvidia-gpu"
          matchOn:
            - pciId:
                class: ["0302"]
                vendor: ["10de"]
        - name: "amd-gpu"
          matchOn:
            - pciId:
                class: ["0300", "0302"]
                vendor: ["1002"]
        - name: "high-speed-nic"
          matchOn:
            - pciId:
                class: ["0207"]  # InfiniBand
              pciId:
                vendor: ["15b3"]  # Mellanox/NVIDIA
```

### Verifying NFD Labels

After deployment, check what labels NFD applied to your nodes:

```bash
# Show all NFD labels on a node
kubectl get node worker-01 -o json | jq '.metadata.labels | to_entries | .[] | select(.key | startswith("feature.node.kubernetes.io")) | .key'

# Common labels you'll see:
# feature.node.kubernetes.io/cpu-cpuid.AVX=true
# feature.node.kubernetes.io/cpu-cpuid.AVX2=true
# feature.node.kubernetes.io/cpu-hardware_multithreading=true
# feature.node.kubernetes.io/cpu-model.family=6
# feature.node.kubernetes.io/cpu-model.id=85
# feature.node.kubernetes.io/cpu-model.vendor_id=Intel
# feature.node.kubernetes.io/kernel-version.full=5.15.0-89-generic
# feature.node.kubernetes.io/memory-numa=true
# feature.node.kubernetes.io/pci-1002_687f.present=true  (AMD GPU)
# feature.node.kubernetes.io/pci-10de_2204.present=true  (NVIDIA GPU)
# feature.node.kubernetes.io/storage-nonrotationaldisk=true

# Check GPU nodes specifically
kubectl get nodes -l feature.node.kubernetes.io/pci-10de.present=true
```

## Custom NFD Rules with NodeFeatureRules

NFD 0.12+ supports `NodeFeatureRule` CRDs that let you define high-level labels from combinations of low-level hardware features:

```yaml
# nfd-rules.yaml
apiVersion: nfd.k8s-sigs.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: gpu-capability-classes
spec:
  rules:
    - name: "ml-training-capable"
      labels:
        "node.company.io/ml-training": "true"
      matchFeatures:
        - feature: pci.device
          matchExpressions:
            vendor:
              op: In
              value: ["10de"]   # NVIDIA
            class:
              op: In
              value: ["0302"]   # 3D Controller (compute GPUs show up here)
        - feature: memory.info
          matchExpressions:
            total:
              op: Gt
              value: "131072"  # > 128GB RAM required for large model training

    - name: "inference-capable"
      labels:
        "node.company.io/inference": "true"
      matchFeatures:
        - feature: pci.device
          matchExpressions:
            vendor:
              op: In
              value: ["10de"]

    - name: "fpga-network-acceleration"
      labels:
        "node.company.io/fpga-netaccel": "true"
      matchFeatures:
        - feature: pci.device
          matchExpressions:
            vendor:
              op: In
              value: ["8086"]  # Intel
            class:
              op: In
              value: ["1200"]  # Processing accelerator

    - name: "high-memory-node"
      labels:
        "node.company.io/memory-class": "high"
      matchFeatures:
        - feature: memory.info
          matchExpressions:
            total:
              op: Gt
              value: "524288"  # > 512GB

    - name: "rdma-capable"
      labels:
        "node.company.io/rdma": "true"
      matchFeatures:
        - feature: pci.device
          matchExpressions:
            vendor:
              op: In
              value: ["15b3"]  # Mellanox
            class:
              op: In
              value: ["0207"]  # InfiniBand
```

```bash
kubectl apply -f nfd-rules.yaml

# Verify labels were applied
kubectl get nodes -l node.company.io/ml-training=true
```

## NVIDIA GPU Device Plugin

The NVIDIA GPU Operator handles everything needed for GPU workloads: driver installation, device plugin, monitoring, and time-slicing.

### Installing the GPU Operator

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

helm upgrade --install gpu-operator nvidia/gpu-operator \
    --namespace gpu-operator \
    --create-namespace \
    --version v24.3.0 \
    --set driver.enabled=true \
    --set driver.version="550.90.12" \
    --set toolkit.enabled=true \
    --set devicePlugin.enabled=true \
    --set dcgm.enabled=true \
    --set dcgmExporter.enabled=true \
    --set gfd.enabled=true \
    --set migManager.enabled=false \
    --set validator.plugin.env[0].name=WITH_WORKLOAD \
    --set validator.plugin.env[0].value="true"
```

### GPU Time-Slicing Configuration

Time-slicing allows multiple pods to share a single GPU without MIG partitioning:

```yaml
# gpu-timeslicing-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  any: |-
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        renameByDefault: false
        failRequestsGreaterThanOne: false
        resources:
          - name: nvidia.com/gpu
            replicas: 8
---
# Apply to specific nodes (those with A100 40GB)
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config-a100-40gb
  namespace: gpu-operator
data:
  a100-40gb: |-
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4
```

```bash
# Label nodes that should use time-slicing
kubectl label node gpu-node-01 nvidia.com/device-plugin.config=a100-40gb

# Apply the config to the GPU operator
kubectl patch clusterpolicy gpu-cluster-policy \
    --type=merge \
    --patch='{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'
```

Verify time-slicing is active:

```bash
kubectl get nodes gpu-node-01 -o json | jq '.status.capacity | to_entries | .[] | select(.key | contains("nvidia"))'
# Should show: "nvidia.com/gpu": "8" (instead of "1")
```

### MIG (Multi-Instance GPU) Configuration

For A100 and H100 GPUs, MIG provides hardware-level isolation:

```yaml
# mig-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mig-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    mig-configs:
      all-1g.5gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.5gb": 7
      all-2g.10gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "2g.10gb": 3
      mixed-a100:
        - devices: [0]
          mig-enabled: true
          mig-devices:
            "3g.20gb": 1
            "2g.10gb": 1
            "1g.5gb": 2
        - devices: [1]
          mig-enabled: false
```

Label a node for MIG:

```bash
kubectl label node gpu-node-02 nvidia.com/mig.config=all-2g.10gb

# Check MIG instances are visible
kubectl get nodes gpu-node-02 -o json | jq '.status.capacity' | grep mig
# Output:
# "nvidia.com/mig-2g.10gb": "3"
```

### GPU Workload Scheduling

```yaml
# ml-training-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: model-training
spec:
  template:
    spec:
      nodeSelector:
        # Use custom NFD rule labels for high-level scheduling
        node.company.io/ml-training: "true"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: trainer
          image: nvcr.io/nvidia/pytorch:24.02-py3
          command: ["python", "train.py", "--model", "llama2-7b"]
          resources:
            requests:
              nvidia.com/gpu: "1"
              memory: "64Gi"
              cpu: "8"
            limits:
              nvidia.com/gpu: "1"
              memory: "64Gi"
              cpu: "8"
          env:
            - name: NVIDIA_VISIBLE_DEVICES
              value: "all"
            - name: NVIDIA_DRIVER_CAPABILITIES
              value: "compute,utility"
      restartPolicy: OnFailure
---
# Inference deployment with time-sliced GPU
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inference-server
spec:
  replicas: 4
  selector:
    matchLabels:
      app: inference-server
  template:
    metadata:
      labels:
        app: inference-server
    spec:
      nodeSelector:
        node.company.io/inference: "true"
      containers:
        - name: inference
          image: myregistry/inference:v1.0
          resources:
            requests:
              nvidia.com/gpu: "1"  # Gets 1 time-slice (1/8 of a GPU)
            limits:
              nvidia.com/gpu: "1"
```

## Building a Custom Device Plugin

Custom device plugins expose arbitrary hardware resources to Kubernetes. This example exposes FPGA accelerators.

### Device Plugin Architecture

The device plugin protocol uses gRPC to communicate with kubelet:

```
kubelet <--gRPC--> device plugin daemon (runs on each node)
                        |
                        v
                  Hardware driver / sysfs
```

### FPGA Device Plugin Implementation

```go
// cmd/fpga-device-plugin/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "net"
    "os"
    "os/signal"
    "path/filepath"
    "strings"
    "syscall"
    "time"

    "google.golang.org/grpc"
    pluginapi "k8s.io/kubelet/pkg/apis/deviceplugin/v1beta1"
)

const (
    resourceName   = "fpga.company.io/xilinx-u250"
    serverSockPath = pluginapi.DevicePluginPath + "fpga-xilinx-u250.sock"
    kubeletSock    = pluginapi.KubeletSocket
    maxRestartDelay = 5 * time.Second
)

// FPGADevice represents a single FPGA accelerator
type FPGADevice struct {
    ID       string
    PCIAddr  string
    Health   string
    DevNodes []string  // /dev/xdma0_user, etc.
}

// FPGAPlugin implements the Kubernetes Device Plugin API
type FPGAPlugin struct {
    devices     map[string]*FPGADevice
    server      *grpc.Server
    socket      string
    resourceName string
    stop        chan struct{}
    health      chan *FPGADevice
}

func NewFPGAPlugin() *FPGAPlugin {
    return &FPGAPlugin{
        devices:      make(map[string]*FPGADevice),
        socket:       serverSockPath,
        resourceName: resourceName,
        stop:         make(chan struct{}),
        health:       make(chan *FPGADevice),
    }
}

// discoverDevices scans the system for FPGA accelerators
func (p *FPGAPlugin) discoverDevices() error {
    // Scan /sys/bus/pci/devices for Xilinx vendor ID (10ee)
    pattern := "/sys/bus/pci/devices/*/vendor"
    matches, err := filepath.Glob(pattern)
    if err != nil {
        return fmt.Errorf("glob failed: %w", err)
    }

    p.devices = make(map[string]*FPGADevice)

    for _, vendorFile := range matches {
        data, err := os.ReadFile(vendorFile)
        if err != nil {
            continue
        }

        vendor := strings.TrimSpace(string(data))
        if vendor != "0x10ee" {  // Xilinx vendor ID
            continue
        }

        pciAddr := filepath.Base(filepath.Dir(vendorFile))

        // Check device class (1200 = processing accelerator)
        classFile := filepath.Join(filepath.Dir(vendorFile), "class")
        classData, err := os.ReadFile(classFile)
        if err != nil {
            continue
        }
        if !strings.HasPrefix(strings.TrimSpace(string(classData)), "0x1200") {
            continue
        }

        // Find associated device nodes
        devNodes, err := p.findDeviceNodes(pciAddr)
        if err != nil {
            log.Printf("Warning: could not find device nodes for %s: %v", pciAddr, err)
        }

        deviceID := fmt.Sprintf("fpga-%s", strings.ReplaceAll(pciAddr, ":", "-"))
        p.devices[deviceID] = &FPGADevice{
            ID:       deviceID,
            PCIAddr:  pciAddr,
            Health:   pluginapi.Healthy,
            DevNodes: devNodes,
        }

        log.Printf("Discovered FPGA: %s (PCI: %s)", deviceID, pciAddr)
    }

    log.Printf("Total FPGAs discovered: %d", len(p.devices))
    return nil
}

// findDeviceNodes locates character device nodes for a PCI address
func (p *FPGAPlugin) findDeviceNodes(pciAddr string) ([]string, error) {
    var nodes []string

    // Check for XDMA driver character devices
    // XDMA creates /dev/xdma<N>_user, /dev/xdma<N>_control, etc.
    entries, err := os.ReadDir("/dev")
    if err != nil {
        return nil, fmt.Errorf("cannot read /dev: %w", err)
    }

    for _, entry := range entries {
        if strings.HasPrefix(entry.Name(), "xdma") {
            nodes = append(nodes, filepath.Join("/dev", entry.Name()))
        }
    }

    return nodes, nil
}

// Start starts the device plugin gRPC server
func (p *FPGAPlugin) Start() error {
    if err := p.discoverDevices(); err != nil {
        return fmt.Errorf("device discovery failed: %w", err)
    }

    // Remove stale socket
    if err := os.Remove(p.socket); err != nil && !os.IsNotExist(err) {
        return fmt.Errorf("failed to remove stale socket: %w", err)
    }

    listener, err := net.Listen("unix", p.socket)
    if err != nil {
        return fmt.Errorf("failed to listen on socket: %w", err)
    }

    p.server = grpc.NewServer()
    pluginapi.RegisterDevicePluginServer(p.server, p)

    go func() {
        if err := p.server.Serve(listener); err != nil {
            log.Printf("Device plugin server stopped: %v", err)
        }
    }()

    // Wait for server to start
    conn, err := grpc.Dial(p.socket,
        grpc.WithInsecure(),
        grpc.WithBlock(),
        grpc.WithTimeout(5*time.Second),
        grpc.WithDialer(func(addr string, timeout time.Duration) (net.Conn, error) {
            return net.DialTimeout("unix", addr, timeout)
        }),
    )
    if err != nil {
        return fmt.Errorf("cannot connect to gRPC server: %w", err)
    }
    conn.Close()

    log.Printf("Device plugin server started on %s", p.socket)
    return nil
}

// Register registers the device plugin with kubelet
func (p *FPGAPlugin) Register() error {
    conn, err := grpc.Dial(kubeletSock,
        grpc.WithInsecure(),
        grpc.WithDialer(func(addr string, timeout time.Duration) (net.Conn, error) {
            return net.DialTimeout("unix", addr, timeout)
        }),
    )
    if err != nil {
        return fmt.Errorf("cannot connect to kubelet: %w", err)
    }
    defer conn.Close()

    client := pluginapi.NewRegistrationClient(conn)
    req := &pluginapi.RegisterRequest{
        Version:      pluginapi.Version,
        Endpoint:     filepath.Base(p.socket),
        ResourceName: p.resourceName,
    }

    if _, err := client.Register(context.Background(), req); err != nil {
        return fmt.Errorf("registration failed: %w", err)
    }

    log.Printf("Registered device plugin for %s", p.resourceName)
    return nil
}

// GetDevicePluginOptions returns options for the device plugin
func (p *FPGAPlugin) GetDevicePluginOptions(ctx context.Context, _ *pluginapi.Empty) (*pluginapi.DevicePluginOptions, error) {
    return &pluginapi.DevicePluginOptions{
        GetPreferredAllocationAvailable: true,
    }, nil
}

// ListAndWatch returns device list and updates on changes
func (p *FPGAPlugin) ListAndWatch(_ *pluginapi.Empty, stream pluginapi.DevicePlugin_ListAndWatchServer) error {
    // Send initial device list
    if err := stream.Send(p.buildDeviceList()); err != nil {
        return fmt.Errorf("failed to send initial device list: %w", err)
    }

    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-p.stop:
            return nil
        case dev := <-p.health:
            log.Printf("Device health changed: %s -> %s", dev.ID, dev.Health)
            if err := stream.Send(p.buildDeviceList()); err != nil {
                return fmt.Errorf("failed to send updated device list: %w", err)
            }
        case <-ticker.C:
            // Periodic health check
            p.checkDeviceHealth()
        }
    }
}

func (p *FPGAPlugin) buildDeviceList() *pluginapi.ListAndWatchResponse {
    var devs []*pluginapi.Device
    for _, dev := range p.devices {
        devs = append(devs, &pluginapi.Device{
            ID:     dev.ID,
            Health: dev.Health,
        })
    }
    return &pluginapi.ListAndWatchResponse{Devices: devs}
}

func (p *FPGAPlugin) checkDeviceHealth() {
    for _, dev := range p.devices {
        healthy := p.isDeviceHealthy(dev)
        newHealth := pluginapi.Healthy
        if !healthy {
            newHealth = pluginapi.Unhealthy
        }
        if dev.Health != newHealth {
            dev.Health = newHealth
            p.health <- dev
        }
    }
}

func (p *FPGAPlugin) isDeviceHealthy(dev *FPGADevice) bool {
    // Check if PCI device still exists
    sysfsPath := fmt.Sprintf("/sys/bus/pci/devices/%s", dev.PCIAddr)
    if _, err := os.Stat(sysfsPath); os.IsNotExist(err) {
        return false
    }
    // Check if device nodes exist
    for _, node := range dev.DevNodes {
        if _, err := os.Stat(node); os.IsNotExist(err) {
            return false
        }
    }
    return true
}

// Allocate assigns FPGA devices to a container
func (p *FPGAPlugin) Allocate(ctx context.Context, req *pluginapi.AllocateRequest) (*pluginapi.AllocateResponse, error) {
    var response pluginapi.AllocateResponse

    for _, containerReq := range req.ContainerRequests {
        var containerResponse pluginapi.ContainerAllocateResponse

        for _, deviceID := range containerReq.DevicesIDs {
            dev, ok := p.devices[deviceID]
            if !ok {
                return nil, fmt.Errorf("unknown device: %s", deviceID)
            }

            // Expose device nodes to the container
            for _, devNode := range dev.DevNodes {
                containerResponse.Devices = append(containerResponse.Devices,
                    &pluginapi.DeviceSpec{
                        ContainerPath: devNode,
                        HostPath:      devNode,
                        Permissions:   "rw",
                    },
                )
            }

            // Mount sysfs entry (for firmware loading)
            sysfsPath := fmt.Sprintf("/sys/bus/pci/devices/%s", dev.PCIAddr)
            containerResponse.Mounts = append(containerResponse.Mounts,
                &pluginapi.Mount{
                    ContainerPath: sysfsPath,
                    HostPath:      sysfsPath,
                    ReadOnly:      false,
                },
            )

            // Set environment variables
            containerResponse.Envs = map[string]string{
                "FPGA_DEVICE_ID":   dev.ID,
                "FPGA_PCI_ADDRESS": dev.PCIAddr,
            }

            log.Printf("Allocated FPGA %s to container", deviceID)
        }

        response.ContainerResponses = append(response.ContainerResponses, &containerResponse)
    }

    return &response, nil
}

// GetPreferredAllocation returns preferred device allocation order
func (p *FPGAPlugin) GetPreferredAllocation(ctx context.Context, req *pluginapi.PreferredAllocationRequest) (*pluginapi.PreferredAllocationResponse, error) {
    var response pluginapi.PreferredAllocationResponse

    for _, containerReq := range req.ContainerRequests {
        // Prefer NUMA-local FPGAs (simplified: return in discovery order)
        var preferred []string
        for _, id := range containerReq.AvailableDeviceIDs {
            preferred = append(preferred, id)
            if len(preferred) >= int(containerReq.AllocationSize) {
                break
            }
        }
        response.ContainerResponses = append(response.ContainerResponses,
            &pluginapi.ContainerPreferredAllocationResponse{
                DeviceIDs: preferred,
            },
        )
    }

    return &response, nil
}

// PreStartContainer is called before container start (optional hook)
func (p *FPGAPlugin) PreStartContainer(ctx context.Context, req *pluginapi.PreStartContainerRequest) (*pluginapi.PreStartContainerResponse, error) {
    // Reset FPGA to clean state before assignment
    for _, deviceID := range req.DevicesIDs {
        dev, ok := p.devices[deviceID]
        if !ok {
            continue
        }
        log.Printf("Pre-start: resetting FPGA %s", dev.ID)
        // Call FPGA reset utility here
    }
    return &pluginapi.PreStartContainerResponse{}, nil
}

func main() {
    log.SetFlags(log.LstdFlags | log.Lshortfile)
    log.Println("Starting FPGA device plugin")

    plugin := NewFPGAPlugin()

    // Handle signals for graceful shutdown
    sigs := make(chan os.Signal, 1)
    signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        <-sigs
        log.Println("Shutting down FPGA device plugin")
        close(plugin.stop)
        plugin.server.GracefulStop()
    }()

    // Start plugin with restart loop
    for {
        if err := plugin.Start(); err != nil {
            log.Printf("Failed to start plugin: %v. Retrying in 5s...", err)
            time.Sleep(maxRestartDelay)
            continue
        }

        if err := plugin.Register(); err != nil {
            log.Printf("Failed to register plugin: %v. Retrying in 5s...", err)
            plugin.server.Stop()
            time.Sleep(maxRestartDelay)
            continue
        }

        // Watch for kubelet restart (socket disappearance)
        for {
            if _, err := os.Stat(kubeletSock); os.IsNotExist(err) {
                log.Println("Kubelet socket disappeared, waiting for restart")
                time.Sleep(5 * time.Second)
            } else {
                break
            }
        }

        // Re-register after kubelet restart
        log.Println("Kubelet appears to have restarted, re-registering")
        plugin.server.Stop()
        break
    }
}
```

### DaemonSet for the Custom Device Plugin

```yaml
# fpga-device-plugin-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fpga-device-plugin
  namespace: kube-system
  labels:
    app: fpga-device-plugin
spec:
  selector:
    matchLabels:
      app: fpga-device-plugin
  updateStrategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: fpga-device-plugin
    spec:
      # Only run on nodes with FPGAs (per NFD labels)
      nodeSelector:
        feature.node.kubernetes.io/pci-8086_1200.present: "true"
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      priorityClassName: system-node-critical
      hostNetwork: true
      hostPID: true
      containers:
        - name: fpga-device-plugin
          image: myregistry/fpga-device-plugin:v1.0
          securityContext:
            privileged: true
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: device-plugin
              mountPath: /var/lib/kubelet/device-plugins
            - name: dev
              mountPath: /dev
            - name: sys
              mountPath: /sys
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
          livenessProbe:
            exec:
              command:
                - ls
                - /var/lib/kubelet/device-plugins/fpga-xilinx-u250.sock
            periodSeconds: 10
            failureThreshold: 3
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
```

## FPGA Time-Slicing with Allocation Policies

Unlike GPUs, FPGAs do not natively support time-slicing at the hardware level. Software-based sharing requires a different approach:

```yaml
# fpga-timeslicing-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fpga-allocation-policy
  namespace: kube-system
data:
  policy.json: |
    {
      "resources": {
        "fpga.company.io/xilinx-u250": {
          "sharing": {
            "strategy": "exclusive",
            "maxPerDevice": 1
          }
        },
        "fpga.company.io/xilinx-u250-slice": {
          "sharing": {
            "strategy": "shared",
            "maxPerDevice": 4,
            "isolationMethod": "process"
          }
        }
      }
    }
```

## Resource Quotas for Device Resources

ResourceQuotas can limit device resource consumption per namespace:

```yaml
# namespace-gpu-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: ml-team
spec:
  hard:
    # GPU limits
    requests.nvidia.com/gpu: "8"
    limits.nvidia.com/gpu: "8"
    # MIG GPU limits
    requests.nvidia.com/mig-1g.5gb: "16"
    requests.nvidia.com/mig-2g.10gb: "8"
    requests.nvidia.com/mig-3g.20gb: "4"
    # FPGA limits
    requests.fpga.company.io/xilinx-u250: "4"
    limits.fpga.company.io/xilinx-u250: "4"
    # Standard resource limits
    requests.cpu: "128"
    requests.memory: "512Gi"
    pods: "50"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: inference-team
spec:
  hard:
    requests.nvidia.com/gpu: "16"
    limits.nvidia.com/gpu: "16"
    requests.cpu: "256"
    requests.memory: "1Ti"
    pods: "200"
---
# LimitRange for GPU pods
apiVersion: v1
kind: LimitRange
metadata:
  name: gpu-limits
  namespace: ml-team
spec:
  limits:
    - type: Container
      default:
        nvidia.com/gpu: "1"
      defaultRequest:
        nvidia.com/gpu: "1"
      max:
        nvidia.com/gpu: "8"
      min:
        nvidia.com/gpu: "1"
```

## Node Taint Strategy for Hardware Nodes

Prevent non-hardware workloads from landing on expensive GPU/FPGA nodes:

```bash
# Taint GPU nodes - only pods requesting GPU can land here
kubectl taint nodes gpu-node-01 nvidia.com/gpu=present:NoSchedule
kubectl taint nodes gpu-node-02 nvidia.com/gpu=present:NoSchedule

# Taint FPGA nodes
kubectl taint nodes fpga-node-01 fpga.company.io/xilinx=present:NoSchedule

# Toleration in workload manifests
# The NVIDIA device plugin DaemonSet already handles this with operator: Exists
```

```yaml
# Pod that tolerates GPU taint
spec:
  tolerations:
    - key: "nvidia.com/gpu"
      operator: "Exists"
      effect: "NoSchedule"
  containers:
    - name: gpu-workload
      resources:
        limits:
          nvidia.com/gpu: "1"
```

## Monitoring Device Resources

```yaml
# device-resource-monitoring.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: device-resource-alerts
  namespace: monitoring
spec:
  groups:
    - name: device-resources
      interval: 30s
      rules:
        - alert: GPUResourcesFullyAllocated
          expr: |
            (
              sum(kube_node_status_allocatable{resource="nvidia_com_gpu"}) -
              sum(kube_pod_container_resource_requests{resource="nvidia_com_gpu"})
            ) == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "All GPU resources are allocated"
            description: "No GPU capacity available for new workloads"

        - alert: FPGADeviceUnhealthy
          expr: |
            kube_node_status_condition{condition="Ready",status="false"} == 1
            and on(node) kube_node_labels{label_feature_node_kubernetes_io_pci_8086_1200_present="true"}
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "FPGA node {{ $labels.node }} is not ready"

        - alert: GPUMemoryExhausted
          expr: |
            DCGM_FI_DEV_FB_FREE < 1000  # Less than 1GB GPU memory free
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU {{ $labels.gpu }} on {{ $labels.Hostname }} low on memory"
```

## Key Takeaways

Kubernetes hardware scheduling through NFD and device plugins requires several layers working together:

1. **NFD provides the discovery layer**: Hardware properties become node labels automatically without manual intervention, and `NodeFeatureRule` CRDs let you define business-meaningful labels from hardware primitives.
2. **Device plugins expose hardware as resources**: The gRPC protocol between kubelet and device plugins is stable and straightforward to implement; the main complexity is hardware-specific device discovery and health checking.
3. **GPU time-slicing vs MIG**: Time-slicing provides software sharing with potential interference; MIG provides hardware-level isolation at the cost of fixed partition sizes. Choose based on isolation requirements.
4. **Taints protect hardware nodes**: Without taints, general-purpose workloads will fill GPU/FPGA nodes, starving hardware workloads. Taint hardware nodes and let only properly tolerated pods schedule there.
5. **ResourceQuotas enforce capacity boundaries**: Without quotas, a single team can exhaust all GPU capacity. Namespace-level ResourceQuotas with device resource limits are essential in multi-team clusters.
6. **Monitor device health and allocation**: DCGM for NVIDIA GPUs and custom exporters for FPGAs feed Prometheus, enabling alerting on capacity exhaustion and device failures before they impact workloads.
