---
title: "Kubernetes Storage: CSI Driver Development and Volume Lifecycle Management"
date: 2029-12-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CSI", "Storage", "Volume Snapshots", "Go", "StorageClass", "PersistentVolume"]
categories:
- Kubernetes
- Storage
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to CSI driver architecture, node and controller plugin implementation, volume snapshots, storage capacity tracking, and inline ephemeral volumes for production Kubernetes storage."
more_link: "yes"
url: "/kubernetes-storage-csi-driver-volume-lifecycle/"
---

The Container Storage Interface (CSI) is the universal storage plugin API for Kubernetes. Every major storage system — from cloud block volumes to distributed file systems to NVMe-oF fabrics — speaks CSI. Building a custom CSI driver is the path to integrating any storage backend into Kubernetes, and understanding the driver lifecycle deeply enables you to debug the persistent storage failures that production systems inevitably encounter. This guide covers the complete CSI specification, driver implementation in Go, volume snapshots, capacity tracking, and inline ephemeral volumes.

<!--more-->

## CSI Architecture

A CSI driver consists of two independently deployed components:

**Controller Plugin**: Manages volume lifecycle at the storage backend level. Provisions and deletes volumes, creates snapshots, manages replication. Runs as a Deployment (not DaemonSet) — one instance is sufficient since these operations don't require node-local context. The controller plugin runs alongside several sidecar containers provided by the Kubernetes CSI community.

**Node Plugin**: Mounts and unmounts volumes on specific nodes. Runs as a DaemonSet because it needs to execute on the node where the pod is scheduled. The node plugin interacts with the kubelet via a Unix socket registered with the kubelet plugin registration mechanism.

```
┌───────────────────────────────────────────────────────────────┐
│ Kubernetes Control Plane                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ CSI Controller Deployment                              │  │
│  │  ┌──────────────────┐  ┌───────────────────────────┐  │  │
│  │  │ external-provisioner│ external-attacher          │  │  │
│  │  │ external-snapshotter│ external-resizer           │  │  │
│  │  └────────┬─────────┘  └─────────────┬─────────────┘  │  │
│  │           │  gRPC (unix socket)       │                │  │
│  │  ┌────────▼──────────────────────────▼─────────────┐  │  │
│  │  │                Controller Plugin                  │  │  │
│  │  └───────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│ Kubernetes Node                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ CSI Node DaemonSet                                     │  │
│  │  ┌──────────────────┐                                  │  │
│  │  │ node-driver-registrar (registers with kubelet)      │  │
│  │  └────────┬─────────┘                                  │  │
│  │           │  gRPC                                       │  │
│  │  ┌────────▼─────────────────────────────────────────┐  │  │
│  │  │               Node Plugin                         │  │  │
│  │  └───────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

## CSI gRPC Interface

The CSI specification defines three gRPC services:

```protobuf
service Identity {
    rpc GetPluginInfo(GetPluginInfoRequest) returns (GetPluginInfoResponse);
    rpc GetPluginCapabilities(GetPluginCapabilitiesRequest) returns (GetPluginCapabilitiesResponse);
    rpc Probe(ProbeRequest) returns (ProbeResponse);
}

service Controller {
    rpc CreateVolume(CreateVolumeRequest) returns (CreateVolumeResponse);
    rpc DeleteVolume(DeleteVolumeRequest) returns (DeleteVolumeResponse);
    rpc ControllerPublishVolume(ControllerPublishVolumeRequest) returns (ControllerPublishVolumeResponse);
    rpc ControllerUnpublishVolume(ControllerUnpublishVolumeRequest) returns (ControllerUnpublishVolumeResponse);
    rpc ValidateVolumeCapabilities(ValidateVolumeCapabilitiesRequest) returns (ValidateVolumeCapabilitiesResponse);
    rpc ListVolumes(ListVolumesRequest) returns (ListVolumesResponse);
    rpc GetCapacity(GetCapacityRequest) returns (GetCapacityResponse);
    rpc ControllerGetCapabilities(ControllerGetCapabilitiesRequest) returns (ControllerGetCapabilitiesResponse);
    rpc CreateSnapshot(CreateSnapshotRequest) returns (CreateSnapshotResponse);
    rpc DeleteSnapshot(DeleteSnapshotRequest) returns (DeleteSnapshotResponse);
    rpc ListSnapshots(ListSnapshotsRequest) returns (ListSnapshotsResponse);
    rpc ControllerExpandVolume(ControllerExpandVolumeRequest) returns (ControllerExpandVolumeResponse);
    rpc ControllerGetVolume(ControllerGetVolumeRequest) returns (ControllerGetVolumeResponse);
}

service Node {
    rpc NodeStageVolume(NodeStageVolumeRequest) returns (NodeStageVolumeResponse);
    rpc NodeUnstageVolume(NodeUnstageVolumeRequest) returns (NodeUnstageVolumeResponse);
    rpc NodePublishVolume(NodePublishVolumeRequest) returns (NodePublishVolumeResponse);
    rpc NodeUnpublishVolume(NodeUnpublishVolumeRequest) returns (NodeUnpublishVolumeResponse);
    rpc NodeGetVolumeStats(NodeGetVolumeStatsRequest) returns (NodeGetVolumeStatsResponse);
    rpc NodeExpandVolume(NodeExpandVolumeRequest) returns (NodeExpandVolumeResponse);
    rpc NodeGetCapabilities(NodeGetCapabilitiesRequest) returns (NodeGetCapabilitiesResponse);
    rpc NodeGetInfo(NodeGetInfoRequest) returns (NodeGetInfoResponse);
}
```

## Implementing the Controller Plugin

```go
package driver

import (
    "context"
    "fmt"

    "github.com/container-storage-interface/spec/lib/go/csi"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type ControllerServer struct {
    csi.UnimplementedControllerServer
    backend StorageBackend
    caps    []*csi.ControllerServiceCapability
}

func NewControllerServer(backend StorageBackend) *ControllerServer {
    caps := []csi.ControllerServiceCapability_RPC_Type{
        csi.ControllerServiceCapability_RPC_CREATE_DELETE_VOLUME,
        csi.ControllerServiceCapability_RPC_PUBLISH_UNPUBLISH_VOLUME,
        csi.ControllerServiceCapability_RPC_LIST_VOLUMES,
        csi.ControllerServiceCapability_RPC_GET_CAPACITY,
        csi.ControllerServiceCapability_RPC_CREATE_DELETE_SNAPSHOT,
        csi.ControllerServiceCapability_RPC_EXPAND_VOLUME,
    }
    csiCaps := make([]*csi.ControllerServiceCapability, len(caps))
    for i, c := range caps {
        csiCaps[i] = &csi.ControllerServiceCapability{
            Type: &csi.ControllerServiceCapability_Rpc{
                Rpc: &csi.ControllerServiceCapability_RPC{Type: c},
            },
        }
    }
    return &ControllerServer{backend: backend, caps: csiCaps}
}

func (c *ControllerServer) CreateVolume(ctx context.Context, req *csi.CreateVolumeRequest) (*csi.CreateVolumeResponse, error) {
    if req.Name == "" {
        return nil, status.Error(codes.InvalidArgument, "volume name is required")
    }
    if len(req.VolumeCapabilities) == 0 {
        return nil, status.Error(codes.InvalidArgument, "volume capabilities are required")
    }

    // Validate capabilities
    for _, cap := range req.VolumeCapabilities {
        if err := c.validateCapability(cap); err != nil {
            return nil, status.Errorf(codes.InvalidArgument, "unsupported capability: %v", err)
        }
    }

    // Extract requested size
    requestedBytes := req.CapacityRange.GetRequiredBytes()
    if requestedBytes == 0 {
        requestedBytes = 10 * 1024 * 1024 * 1024 // 10Gi default
    }

    // Check if volume already exists (idempotency)
    existing, err := c.backend.GetVolume(ctx, req.Name)
    if err == nil && existing != nil {
        if existing.CapacityBytes < requestedBytes {
            return nil, status.Errorf(codes.AlreadyExists,
                "volume %q exists with smaller size %d < %d", req.Name, existing.CapacityBytes, requestedBytes)
        }
        return &csi.CreateVolumeResponse{
            Volume: &csi.Volume{
                VolumeId:      existing.ID,
                CapacityBytes: existing.CapacityBytes,
                VolumeContext: existing.Context,
            },
        }, nil
    }

    // Create new volume
    vol, err := c.backend.CreateVolume(ctx, CreateVolumeParams{
        Name:       req.Name,
        SizeBytes:  requestedBytes,
        Parameters: req.Parameters,
        Labels:     req.Parameters,
    })
    if err != nil {
        return nil, status.Errorf(codes.Internal, "creating volume: %v", err)
    }

    return &csi.CreateVolumeResponse{
        Volume: &csi.Volume{
            VolumeId:      vol.ID,
            CapacityBytes: vol.CapacityBytes,
            VolumeContext: map[string]string{
                "volumeName": req.Name,
                "endpoint":   vol.Endpoint,
            },
        },
    }, nil
}

func (c *ControllerServer) DeleteVolume(ctx context.Context, req *csi.DeleteVolumeRequest) (*csi.DeleteVolumeResponse, error) {
    if req.VolumeId == "" {
        return nil, status.Error(codes.InvalidArgument, "volume ID is required")
    }

    // Idempotent: if volume doesn't exist, succeed silently
    if err := c.backend.DeleteVolume(ctx, req.VolumeId); err != nil {
        if isNotFound(err) {
            return &csi.DeleteVolumeResponse{}, nil
        }
        return nil, status.Errorf(codes.Internal, "deleting volume %q: %v", req.VolumeId, err)
    }
    return &csi.DeleteVolumeResponse{}, nil
}
```

## Implementing the Node Plugin

The node plugin handles two-phase mounting: `NodeStageVolume` mounts the device to a staging path (once per node per volume), and `NodePublishVolume` bind-mounts from the staging path to the pod's volume path (once per pod).

```go
type NodeServer struct {
    csi.UnimplementedNodeServer
    nodeID  string
    mounter mount.Interface
}

func (n *NodeServer) NodeStageVolume(ctx context.Context, req *csi.NodeStageVolumeRequest) (*csi.NodeStageVolumeResponse, error) {
    if req.VolumeId == "" {
        return nil, status.Error(codes.InvalidArgument, "volume ID required")
    }
    if req.StagingTargetPath == "" {
        return nil, status.Error(codes.InvalidArgument, "staging target path required")
    }

    // Determine the device path from volume context
    devicePath, ok := req.VolumeContext["devicePath"]
    if !ok {
        return nil, status.Error(codes.InvalidArgument, "devicePath missing from volume context")
    }

    // Create staging directory if it doesn't exist
    if err := os.MkdirAll(req.StagingTargetPath, 0750); err != nil {
        return nil, status.Errorf(codes.Internal, "creating staging dir: %v", err)
    }

    // Check if already mounted (idempotency)
    mounted, err := n.mounter.IsMountPoint(req.StagingTargetPath)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "checking mount point: %v", err)
    }
    if mounted {
        return &csi.NodeStageVolumeResponse{}, nil
    }

    // Format if needed
    fsType := req.VolumeCapability.GetMount().GetFsType()
    if fsType == "" {
        fsType = "ext4"
    }
    if err := n.formatIfNeeded(ctx, devicePath, fsType); err != nil {
        return nil, status.Errorf(codes.Internal, "formatting device: %v", err)
    }

    // Mount device to staging path
    mountOptions := req.VolumeCapability.GetMount().GetMountFlags()
    if err := n.mounter.Mount(devicePath, req.StagingTargetPath, fsType, mountOptions); err != nil {
        return nil, status.Errorf(codes.Internal, "mounting device %q to %q: %v",
            devicePath, req.StagingTargetPath, err)
    }
    return &csi.NodeStageVolumeResponse{}, nil
}

func (n *NodeServer) NodePublishVolume(ctx context.Context, req *csi.NodePublishVolumeRequest) (*csi.NodePublishVolumeResponse, error) {
    if req.TargetPath == "" {
        return nil, status.Error(codes.InvalidArgument, "target path required")
    }

    // Create target directory
    if err := os.MkdirAll(req.TargetPath, 0750); err != nil {
        return nil, status.Errorf(codes.Internal, "creating target dir: %v", err)
    }

    // Check idempotency
    mounted, _ := n.mounter.IsMountPoint(req.TargetPath)
    if mounted {
        return &csi.NodePublishVolumeResponse{}, nil
    }

    // Bind mount from staging to target
    mountOptions := []string{"bind"}
    if req.Readonly {
        mountOptions = append(mountOptions, "ro")
    }

    if err := n.mounter.Mount(req.StagingTargetPath, req.TargetPath, "", mountOptions); err != nil {
        return nil, status.Errorf(codes.Internal, "bind mounting %q to %q: %v",
            req.StagingTargetPath, req.TargetPath, err)
    }
    return &csi.NodePublishVolumeResponse{}, nil
}
```

## Volume Snapshots

Volume snapshots require registering the `VolumeSnapshotContent` and `VolumeSnapshot` CRDs and deploying the external-snapshotter sidecar.

```yaml
# VolumeSnapshotClass
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: mydriver-snapclass
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: mycompany.com/mydriver
deletionPolicy: Delete
parameters:
  snapshotType: "incremental"
  replicationEnabled: "false"
---
# Create a snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: database-snapshot-20291208
  namespace: production
spec:
  volumeSnapshotClassName: mydriver-snapclass
  source:
    persistentVolumeClaimName: database-data
---
# Restore from snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: database-data-restore
  namespace: production
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  dataSource:
    name: database-snapshot-20291208
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
```

Implementing `CreateSnapshot` in the controller:

```go
func (c *ControllerServer) CreateSnapshot(ctx context.Context, req *csi.CreateSnapshotRequest) (*csi.CreateSnapshotResponse, error) {
    if req.SourceVolumeId == "" {
        return nil, status.Error(codes.InvalidArgument, "source volume ID required")
    }
    if req.Name == "" {
        return nil, status.Error(codes.InvalidArgument, "snapshot name required")
    }

    // Idempotency check
    if snap, err := c.backend.GetSnapshotByName(ctx, req.Name); err == nil {
        return &csi.CreateSnapshotResponse{
            Snapshot: &csi.Snapshot{
                SnapshotId:     snap.ID,
                SourceVolumeId: req.SourceVolumeId,
                CreationTime:   timestamppb.New(snap.CreatedAt),
                ReadyToUse:     snap.Status == SnapshotStatusReady,
                SizeBytes:      snap.SizeBytes,
            },
        }, nil
    }

    snap, err := c.backend.CreateSnapshot(ctx, req.SourceVolumeId, req.Name, req.Parameters)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "creating snapshot: %v", err)
    }

    return &csi.CreateSnapshotResponse{
        Snapshot: &csi.Snapshot{
            SnapshotId:     snap.ID,
            SourceVolumeId: req.SourceVolumeId,
            CreationTime:   timestamppb.New(snap.CreatedAt),
            ReadyToUse:     snap.Status == SnapshotStatusReady,
            SizeBytes:      snap.SizeBytes,
        },
    }, nil
}
```

## Storage Capacity Tracking

CSI Storage Capacity tracking allows the scheduler to avoid scheduling pods on nodes where there isn't sufficient storage capacity. This is implemented via the `CSIStorageCapacity` object:

```go
// In the controller plugin: report capacity
func (c *ControllerServer) GetCapacity(ctx context.Context, req *csi.GetCapacityRequest) (*csi.GetCapacityResponse, error) {
    // Get capacity from storage backend
    totalCapacity, err := c.backend.GetAvailableCapacity(ctx, req.Parameters)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "getting capacity: %v", err)
    }

    return &csi.GetCapacityResponse{
        AvailableCapacity: totalCapacity,
    }, nil
}
```

Enable capacity tracking in the StorageClass:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: mydriver-fast
provisioner: mycompany.com/mydriver
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer  # Required for capacity-aware scheduling
parameters:
  type: nvme-ssd
  replication: "3"
```

`WaitForFirstConsumer` delays PVC binding until a pod is scheduled, at which point the scheduler has node topology information and can check CSIStorageCapacity objects to find a node with sufficient space.

## Inline Ephemeral Volumes

Inline ephemeral volumes are created and deleted with the pod, suitable for scratch space or secrets injection:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: app-with-scratch
spec:
  containers:
  - name: app
    image: myapp:1.0
    volumeMounts:
    - name: scratch
      mountPath: /scratch
  volumes:
  - name: scratch
    csi:
      driver: mycompany.com/mydriver
      readOnly: false
      volumeAttributes:
        sizeGiB: "5"
        type: "local-ssd"
```

For ephemeral volumes, the node plugin must implement `NodePublishVolume` without a prior `NodeStageVolume` call, since there's no persistent backing volume to stage:

```go
func (n *NodeServer) NodePublishVolume(ctx context.Context, req *csi.NodePublishVolumeRequest) (*csi.NodePublishVolumeResponse, error) {
    // For ephemeral volumes, VolumeContext contains "csi.storage.k8s.io/ephemeral": "true"
    if req.VolumeContext["csi.storage.k8s.io/ephemeral"] == "true" {
        return n.publishEphemeralVolume(ctx, req)
    }
    return n.publishPersistentVolume(ctx, req)
}

func (n *NodeServer) publishEphemeralVolume(ctx context.Context, req *csi.NodePublishVolumeRequest) (*csi.NodePublishVolumeResponse, error) {
    // Provision local storage inline
    sizeGiB, _ := strconv.ParseInt(req.VolumeContext["sizeGiB"], 10, 64)

    localPath, err := n.provisionLocalVolume(ctx, req.VolumeId, sizeGiB*1024*1024*1024)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "provisioning ephemeral volume: %v", err)
    }

    if err := os.MkdirAll(req.TargetPath, 0750); err != nil {
        return nil, status.Errorf(codes.Internal, "creating target path: %v", err)
    }

    if err := n.mounter.Mount(localPath, req.TargetPath, "", []string{"bind"}); err != nil {
        return nil, status.Errorf(codes.Internal, "mounting ephemeral volume: %v", err)
    }
    return &csi.NodePublishVolumeResponse{}, nil
}
```

## Volume Lifecycle Diagram

```
PVC Created
     │
     ▼
external-provisioner calls CreateVolume
     │ (Controller plugin creates storage)
     ▼
PV Created, PVC Bound
     │
     ▼
Pod Scheduled to Node
     │
     ▼
kubelet calls NodeStageVolume
     │ (Node plugin formats & mounts to staging path)
     ▼
kubelet calls NodePublishVolume
     │ (Node plugin bind-mounts to pod path)
     ▼
Pod Running, Volume Accessible
     │
     ▼ (pod deleted)
kubelet calls NodeUnpublishVolume
     │ (unmount pod path)
     ▼
kubelet calls NodeUnstageVolume
     │ (unmount staging path)
     ▼
external-attacher calls ControllerUnpublishVolume
     │ (detach from node)
     ▼
external-provisioner calls DeleteVolume
     │ (delete storage, if reclaimPolicy: Delete)
     ▼
PV Deleted
```

## Testing CSI Drivers

The Kubernetes Storage SIG provides the `csi-sanity` test suite that validates CSI spec compliance:

```bash
# Install csi-sanity
go install github.com/kubernetes-csi/csi-test/v5/cmd/csi-sanity@latest

# Run against your driver's Unix socket
csi-sanity \
  --csi.endpoint=unix:///tmp/csi.sock \
  --csi.testvolumesize=10737418240 \
  --csi.testvolumeparameters="type=ssd,replication=1" \
  -ginkgo.v
```

For integration tests in CI, run the driver against a mock storage backend and verify the full volume lifecycle end-to-end using envtest and real PVCs.

Production CSI drivers must be idempotent at every RPC (repeated calls with the same arguments return the same result), handle concurrent calls safely (the same volume may be published to multiple nodes for RWX volumes), and implement robust cleanup on NodeUnstageVolume/NodeUnpublishVolume even if the pod crashed mid-write.
