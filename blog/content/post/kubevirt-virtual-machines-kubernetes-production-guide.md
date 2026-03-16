---
title: "KubeVirt: Running Virtual Machines on Kubernetes in Production"
date: 2027-01-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KubeVirt", "Virtualization", "VMs"]
categories: ["Kubernetes", "Virtualization", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to KubeVirt covering architecture, VirtualMachine CRDs, CDI for disk images, live migration, CPU pinning, Multus networking, RBAC, and Prometheus monitoring."
more_link: "yes"
url: "/kubevirt-virtual-machines-kubernetes-production-guide/"
---

The dream of a single control plane for both containerised workloads and virtual machines is now production-ready. **KubeVirt** extends Kubernetes with first-class VM primitives, allowing platform teams to retire dedicated hypervisor infrastructure while retaining the operational capabilities — live migration, hardware-level isolation, full OS control — that some workloads still require. This guide covers the full deployment lifecycle: architecture, installation, disk image management with CDI, live migration, CPU pinning, network attachment with Multus, RBAC, and observability.

<!--more-->

## KubeVirt Architecture

KubeVirt introduces four core components that integrate cleanly with the Kubernetes control plane.

### Control Plane Components

**virt-operator** manages the lifecycle of the other KubeVirt components. It deploys, upgrades, and monitors the remaining pieces, much like an operator for the operator itself.

**virt-api** serves the KubeVirt-specific API endpoints (the `VirtualMachine`, `VirtualMachineInstance`, and related CRDs). It acts as an aggregated API server registered with the Kubernetes API server, so `kubectl` commands work natively.

**virt-controller** watches VirtualMachine and VirtualMachineInstance objects and drives the reconciliation loop — creating the virt-launcher Pod, managing VM lifecycle transitions, and coordinating live migration.

**virt-handler** runs as a DaemonSet on every node. It receives instructions from virt-controller and communicates with libvirt on the node to start, stop, migrate, and monitor individual VM instances.

### Data Plane: virt-launcher and libvirt

Each running VM corresponds to a dedicated `virt-launcher` Pod. Inside that Pod, a KVM/QEMU process manages the actual virtual machine. The virt-handler on the node communicates with the virt-launcher's local libvirt daemon over a Unix socket. This architecture means that losing a virt-handler does not immediately kill running VMs — they continue until the Pod is terminated.

```
Kubernetes API Server
    │
    ├── virt-api (aggregated API)
    │
    └── virt-controller (Deployment, 2 replicas)
         │
         └── watches VMI → creates virt-launcher Pod
                                │
                                └── libvirtd
                                      └── QEMU/KVM (the actual VM)

Per-node: virt-handler (DaemonSet)
    └── communicates with virt-launcher libvirtd
```

## Installation

### Hardware Prerequisites

KubeVirt requires nodes with hardware virtualisation support (Intel VT-x or AMD-V). Verify this before deploying:

```bash
# Check virtualisation support on every node
kubectl get nodes -o name | while read node; do
  echo -n "${node}: "
  kubectl debug node/"${node##*/}" -it \
    --image=busybox \
    -- grep -c vmx /proc/cpuinfo 2>/dev/null || echo "no vmx — check AMD-V"
done

# Alternatively, check from the node directly
egrep -c '(vmx|svm)' /proc/cpuinfo
```

If running in a cloud environment without nested virtualisation, KubeVirt can fall back to software emulation (`useEmulation: true`), but that is not suitable for production VM workloads.

### Deploy KubeVirt

```bash
KUBEVIRT_VERSION="v1.3.0"

# Deploy the operator
kubectl apply -f \
  https://github.com/kubevirt/kubevirt/releases/download/${KUBEVIRT_VERSION}/kubevirt-operator.yaml

# Wait for operator to be ready
kubectl -n kubevirt rollout status deployment/virt-operator

# Deploy KubeVirt with a custom configuration
cat <<'EOF' | kubectl apply -f -
apiVersion: kubevirt.io/v1
kind: KubeVirt
metadata:
  name: kubevirt
  namespace: kubevirt
spec:
  certificateRotateStrategy: {}
  configuration:
    developerConfiguration:
      useEmulation: false
    # Enable live migration globally
    migrations:
      allowAutoConverge: true
      allowPostCopy: false
      completionTimeoutPerGiB: 800
      progressTimeout: 150
    # Network configuration
    network:
      defaultNetworkInterface: masquerade
      permitSlirpInterface: false
    # NUMA topology awareness
    cpuModel: host-passthrough
    # Machine type baseline
    machineType: q35
  imagePullPolicy: IfNotPresent
  workloadUpdateStrategy:
    workloadUpdateMethods:
      - LiveMigrate
EOF

# Verify all components reach Running state
kubectl -n kubevirt get pods --watch
```

## Containerised Data Importer (CDI)

CDI is the companion project that handles disk image management: importing from HTTP URLs, S3 buckets, or existing PVCs, and providing the DataVolume abstraction.

```bash
CDI_VERSION="v1.59.0"

kubectl apply -f \
  https://github.com/kubevirt/containerized-data-importer/releases/download/${CDI_VERSION}/cdi-operator.yaml

kubectl apply -f \
  https://github.com/kubevirt/containerized-data-importer/releases/download/${CDI_VERSION}/cdi-cr.yaml

kubectl -n cdi rollout status deployment/cdi-operator
kubectl -n cdi rollout status deployment/cdi-deployment
```

### Importing a Disk Image via DataVolume

```yaml
# Import a cloud image from an HTTP source
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata:
  name: ubuntu-2204-base
  namespace: vm-workloads
spec:
  source:
    http:
      url: "https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-amd64.img"
      # Optionally supply a checksum for integrity verification
      # certConfigMap: tls-certs
  storage:
    accessModes:
      - ReadWriteMany      # Required for live migration
    resources:
      requests:
        storage: 20Gi
    storageClassName: ceph-rbd
```

```bash
# Monitor import progress
kubectl -n vm-workloads get datavolume ubuntu-2204-base --watch

# Clone an existing DataVolume to create a new VM disk
cat <<'EOF' | kubectl apply -f -
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata:
  name: webapp-vm-disk
  namespace: vm-workloads
spec:
  source:
    pvc:
      namespace: vm-workloads
      name: ubuntu-2204-base
  storage:
    accessModes:
      - ReadWriteMany
    resources:
      requests:
        storage: 20Gi
    storageClassName: ceph-rbd
EOF
```

## VirtualMachine CRD

The `VirtualMachine` CRD is the stable, declarative representation of a VM — analogous to a Deployment. It controls the desired state (running or stopped) and references a `VirtualMachineInstance` spec.

### Production VM Manifest

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: webapp-vm-01
  namespace: vm-workloads
  labels:
    app: webapp
    tier: frontend
spec:
  running: true

  # Template used to create VirtualMachineInstance objects
  template:
    metadata:
      labels:
        app: webapp
        kubevirt.io/domain: webapp-vm-01
    spec:
      # Node placement
      nodeSelector:
        node-role.kubernetes.io/worker: ""
        kubevirt.io/schedulable: "true"
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/arch
                    operator: In
                    values: ["amd64"]
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 50
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: webapp
                topologyKey: kubernetes.io/hostname

      # Tolerations for dedicated VM nodes
      tolerations:
        - key: "vm-workloads"
          operator: "Exists"
          effect: "NoSchedule"

      # Priority for eviction decisions
      priorityClassName: vm-workloads-high

      domain:
        # Machine type and CPU model
        machine:
          type: q35

        cpu:
          cores: 4
          sockets: 1
          threads: 2
          model: host-passthrough
          # Pin vCPUs to dedicated host CPUs
          dedicatedCpuPlacement: true
          isolateEmulatorThread: true
          features:
            - name: x2apic
              policy: require
            - name: pcid
              policy: require

        memory:
          guest: 8Gi
          hugepages:
            pageSize: 2Mi

        resources:
          requests:
            memory: 8Gi
            cpu: "8"       # physical CPUs reserved for CPU pinning
          limits:
            memory: 8Gi
            cpu: "8"

        firmware:
          bootloader:
            efi:
              secureBoot: false

        features:
          acpi: {}
          apic: {}
          smm:
            enabled: false

        # Watchdog for automatic VM recovery
        watchdog:
          name: mywatchdog
          i6300esb:
            action: poweroff

        # Devices
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
              bootOrder: 1
            - name: cloudinit
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
              model: virtio
              ports:
                - port: 22
                  protocol: TCP
                - port: 8080
                  protocol: TCP
          # Enable serial console access
          autoattachSerialConsole: true
          autoattachGraphicsDevice: false
          # Enable memory balloon for dynamic memory adjustment
          memBalloon:
            model: virtio

      # Network attachments
      networks:
        - name: default
          pod: {}

      # Volume sources
      volumes:
        - name: rootdisk
          dataVolume:
            name: webapp-vm-disk
        - name: cloudinit
          cloudInitNoCloud:
            networkData: |
              version: 2
              ethernets:
                eth0:
                  dhcp4: true
            userData: |
              #cloud-config
              hostname: webapp-vm-01
              users:
                - name: ops
                  sudo: ALL=(ALL) NOPASSWD:ALL
                  shell: /bin/bash
                  ssh_authorized_keys:
                    - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... ops@platform
              packages:
                - qemu-guest-agent
              runcmd:
                - systemctl enable --now qemu-guest-agent
```

### VMI Lifecycle Management

```bash
# Start a stopped VM
virtctl start webapp-vm-01 -n vm-workloads

# Stop a running VM (graceful)
virtctl stop webapp-vm-01 -n vm-workloads

# Restart a running VM
virtctl restart webapp-vm-01 -n vm-workloads

# Open a serial console
virtctl console webapp-vm-01 -n vm-workloads

# Open VNC (requires virtctl port-forward or a VNC client)
virtctl vnc webapp-vm-01 -n vm-workloads

# SSH via virtctl port-forward
virtctl ssh ops@webapp-vm-01 -n vm-workloads
```

## Live Migration

Live migration moves a running VM from one node to another without downtime. It requires:

- `ReadWriteMany` (RWX) storage (Ceph RBD with krbd, CephFS, or NFS)
- Sufficient CPU and memory on the destination node
- A migration network (optional but recommended for large memory footprints)

### Triggering a Migration

```yaml
# Manual live migration request
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstanceMigration
metadata:
  name: webapp-vm-01-migration-001
  namespace: vm-workloads
spec:
  vmiName: webapp-vm-01
```

```bash
kubectl apply -f migration.yaml

# Watch migration progress
kubectl -n vm-workloads get virtualmachineinstancemigration \
  webapp-vm-01-migration-001 --watch

# Describe for detailed status
kubectl -n vm-workloads describe \
  virtualmachineinstancemigration webapp-vm-01-migration-001
```

### Migration Policy for Bandwidth Control

```yaml
apiVersion: migrations.kubevirt.io/v1alpha1
kind: MigrationPolicy
metadata:
  name: bandwidth-limited-migration
spec:
  selectors:
    namespaceSelector:
      matchLabels:
        migration-policy: bandwidth-limited
    virtualMachineInstanceSelector:
      matchLabels:
        workload-class: production
  bandwidth: 256Mi         # bytes per second
  allowAutoConverge: true
  allowPostCopy: false
  completionTimeoutPerGiB: 800
```

## CPU Pinning and Hugepages

CPU pinning (`dedicatedCpuPlacement: true`) allocates exclusive physical CPUs to the VM, preventing noisy-neighbour interference. This requires nodes to have the CPU Manager policy set to `static`.

### Configure CPU Manager on Nodes

```bash
# In kubelet configuration (/var/lib/kubelet/config.yaml)
# cpuManagerPolicy: static
# cpuManagerReconcilePeriod: 5s
# reservedSystemCPUs: "0-1"    # reserve CPUs 0 and 1 for system use
```

Label nodes that have CPU manager static policy enabled:

```bash
kubectl label node worker-gpu-01 \
  kubevirt.io/schedulable=true \
  cpu-pinning=enabled
```

### Hugepages for Low-Latency VMs

```yaml
# VM spec section for hugepages
domain:
  memory:
    guest: 8Gi
    hugepages:
      pageSize: 1Gi    # use 1 GiB hugepages for best NUMA performance
  resources:
    requests:
      memory: 8Gi
```

Nodes must have hugepages pre-allocated. Configure this via the node's kubelet reserved resources or via the Node Feature Discovery operator.

## Multus Networking for Secondary NICs

Production VMs often need direct access to VLANs or SR-IOV interfaces. Multus CNI enables attaching additional network interfaces to VMs.

### Create a NetworkAttachmentDefinition

```yaml
# Bridge network using the host's br-tenant-vlan100 bridge
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: tenant-vlan100
  namespace: vm-workloads
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name": "tenant-vlan100",
      "type": "bridge",
      "bridge": "br-tenant-vlan100",
      "ipam": {
        "type": "dhcp"
      },
      "vlan": 100
    }
```

### Attach Secondary Interface to a VM

```yaml
# Inside the VirtualMachine spec.template.spec
networks:
  - name: default
    pod: {}
  - name: tenant-net
    multus:
      networkName: vm-workloads/tenant-vlan100

domain:
  devices:
    interfaces:
      - name: default
        masquerade: {}
        model: virtio
      - name: tenant-net
        bridge: {}
        model: virtio
```

For SR-IOV (highest performance, lowest CPU overhead):

```yaml
# NetworkAttachmentDefinition for SR-IOV
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: sriov-net
  namespace: vm-workloads
  annotations:
    k8s.v1.cni.cncf.io/resourceName: intel.com/intel_sriov_netdevice
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "name": "sriov-net",
      "type": "sriov",
      "ipam": {
        "type": "dhcp"
      }
    }
---
# In the VM spec, add the SR-IOV interface
# networks:
#   - name: sriov-net
#     multus:
#       networkName: vm-workloads/sriov-net
# domain.devices.interfaces:
#   - name: sriov-net
#     sriov: {}
```

## RBAC for VM Operators

```yaml
# Role for operators who can manage VMs but not KubeVirt configuration
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: vm-operator
rules:
  - apiGroups: ["kubevirt.io"]
    resources:
      - virtualmachines
      - virtualmachineinstances
      - virtualmachineinstancemigrations
      - virtualmachineinstancepresets
      - virtualmachineinstancereplicasets
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["subresources.kubevirt.io"]
    resources:
      - virtualmachines/start
      - virtualmachines/stop
      - virtualmachines/restart
      - virtualmachineinstances/console
      - virtualmachineinstances/vnc
      - virtualmachineinstances/ssh
    verbs: ["update"]
  - apiGroups: ["cdi.kubevirt.io"]
    resources:
      - datavolumes
      - datasources
    verbs: ["get", "list", "watch", "create", "delete"]
---
# Read-only role for auditors
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: vm-viewer
rules:
  - apiGroups: ["kubevirt.io", "cdi.kubevirt.io"]
    resources: ["*"]
    verbs: ["get", "list", "watch"]
```

## Prometheus Monitoring

KubeVirt exposes metrics via the virt-api and virt-handler components.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kubevirt-metrics
  namespace: kubevirt
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      prometheus.kubevirt.io: ""
  namespaceSelector:
    matchNames:
      - kubevirt
  endpoints:
    - port: metrics
      scheme: https
      tlsConfig:
        insecureSkipVerify: true
      interval: 30s
      honorLabels: true
```

### Critical Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubevirt-alerts
  namespace: monitoring
spec:
  groups:
    - name: kubevirt.rules
      rules:
        - alert: KubeVirtVMNotRunning
          expr: |
            kubevirt_vm_running_status_last_transition_timestamp_seconds{running="false"} > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "VM {{ $labels.name }} in namespace {{ $labels.namespace }} is not running"

        - alert: KubeVirtLiveMigrationFailed
          expr: |
            kubevirt_migrate_vmi_failed_total > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Live migration failed for VMI in {{ $labels.namespace }}"

        - alert: KubeVirtNodeKVMUnavailable
          expr: |
            kubevirt_node_schedulable == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Node {{ $labels.node }} KVM is not schedulable"

        - alert: KubeVirtHighVMMemoryUsage
          expr: |
            kubevirt_vmi_memory_used_bytes / kubevirt_vmi_memory_available_bytes > 0.90
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "VM {{ $labels.name }} memory usage above 90%"
```

### Key Metrics Reference

| Metric | Description |
|---|---|
| `kubevirt_vm_running_status_last_transition_timestamp_seconds` | Last state transition time |
| `kubevirt_vmi_phase_count` | VMI count by phase (Running, Pending, Failed) |
| `kubevirt_migrate_vmi_pending_count` | In-flight migrations |
| `kubevirt_migrate_vmi_failed_total` | Failed migrations counter |
| `kubevirt_vmi_vcpu_seconds_total` | vCPU time consumed |
| `kubevirt_vmi_network_traffic_bytes_total` | Network I/O per VMI |
| `kubevirt_vmi_storage_iops_read_total` | Disk read IOPS per VMI |
| `kubevirt_node_schedulable` | Whether a node can schedule new VMs |

## Use Cases and Anti-Patterns

### When KubeVirt is the Right Tool

**Legacy application modernisation**: Applications that require specific kernel versions, kernel modules, or OS-level configuration that cannot be containerised without significant re-engineering.

**Windows workloads**: Running Windows Server or desktop VMs alongside Linux containers on the same Kubernetes infrastructure.

**Hard multi-tenancy**: Regulated environments (finance, healthcare) that require hypervisor-level isolation between tenants even when containerisation is technically possible.

**Testing environments**: Running integration tests that require booting real VMs to test provisioning, OS-level software, or hardware emulation.

### Anti-Patterns to Avoid

Running stateless 12-factor applications as VMs on KubeVirt when containers would serve equally well adds unnecessary operational complexity. KubeVirt is most valuable when the workload genuinely needs VM-level isolation, specific kernel behaviour, or an OS environment that containers cannot provide.

Avoid running KubeVirt on nodes without hardware virtualisation and relying on `useEmulation: true` for production VM workloads. Emulated VMs are significantly slower and should be used only for CI testing or development environments.

## Upgrading KubeVirt

KubeVirt upgrades are managed by virt-operator. The operator handles rolling upgrades of all components while maintaining running VM availability through live migration.

```bash
NEW_VERSION="v1.4.0"

# Apply the new operator manifest — the operator upgrades itself first
kubectl apply -f \
  https://github.com/kubevirt/kubevirt/releases/download/${NEW_VERSION}/kubevirt-operator.yaml

# Watch the operator roll out
kubectl -n kubevirt rollout status deployment/virt-operator

# The operator then upgrades virt-api, virt-controller, and virt-handler
# VMs are live-migrated off nodes being updated
kubectl -n kubevirt get pods --watch

# Verify version
kubectl -n kubevirt get kubevirt kubevirt -o jsonpath='{.status.observedKubeVirtVersion}'
```

KubeVirt represents a mature path for organisations that need to consolidate VM and container workloads onto a single control plane, eliminating the operational split between a Kubernetes team and a VMware/OpenStack team.
