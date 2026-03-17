---
title: "Kubernetes CSI Driver Development: Building Custom Storage Integrations"
date: 2028-10-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CSI", "Storage", "Go", "Operators"]
categories:
- Kubernetes
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building a custom Kubernetes CSI driver in Go covering Identity, Node, and Controller services, external sidecar containers, volume lifecycle, snapshot support, and testing with the CSI sanity package."
more_link: "yes"
url: "/kubernetes-storage-csi-driver-development-guide/"
---

The Container Storage Interface (CSI) is the standard way to add storage backends to Kubernetes. Building a custom CSI driver enables you to integrate proprietary storage systems, implement specialized volume semantics, or add policy enforcement to storage operations. This guide builds a functional CSI driver from scratch, covering the three gRPC services, external sidecar integration, the full volume lifecycle, snapshot support, and automated testing.

<!--more-->

# Kubernetes CSI Driver Development: Building Custom Storage Integrations

## CSI Architecture Overview

A CSI driver consists of two components:

**Controller Plugin**: Runs as a Deployment (one or a few replicas). Handles cluster-wide operations: creating/deleting volumes, creating/deleting snapshots, attaching/detaching volumes to nodes. Communicates with the storage backend API.

**Node Plugin**: Runs as a DaemonSet (one per node). Handles node-local operations: mounting/unmounting volumes on the node's filesystem, staging volumes to a path.

Both plugins expose gRPC services. The Kubernetes external sidecar containers (external-provisioner, external-attacher, external-resizer, external-snapshotter) call these services and translate Kubernetes events into CSI API calls.

### CSI Service Interfaces

Each plugin implements one or more of these gRPC services:

- `Identity`: All plugins implement this. Provides driver name, capabilities.
- `Controller`: Optional. CreateVolume, DeleteVolume, CreateSnapshot, etc.
- `Node`: Required in node plugin. NodePublishVolume, NodeUnpublishVolume, NodeStageVolume, etc.

## Project Setup

```bash
mkdir my-csi-driver && cd my-csi-driver
go mod init github.com/yourorg/my-csi-driver

go get google.golang.org/grpc@v1.59.0
go get github.com/container-storage-interface/spec@v1.9.0
go get k8s.io/client-go@v0.28.4
go get k8s.io/mount-utils@v0.28.4
go get go.uber.org/zap@v1.26.0
go get github.com/kubernetes-csi/csi-test/v5@v5.2.0  # sanity test package
```

Project structure:

```
my-csi-driver/
├── cmd/
│   └── driver/
│       └── main.go
├── internal/
│   ├── driver/
│   │   ├── identity.go
│   │   ├── controller.go
│   │   ├── node.go
│   │   └── server.go
│   └── storage/
│       └── backend.go
├── deploy/
│   ├── controller.yaml
│   ├── node.yaml
│   ├── rbac.yaml
│   └── storageclass.yaml
├── tests/
│   └── sanity_test.go
└── Dockerfile
```

## Identity Service

```go
// internal/driver/identity.go
package driver

import (
	"context"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	DriverName    = "my-csi-driver.example.com"
	DriverVersion = "1.0.0"
)

// IdentityServer implements the CSI Identity service.
type IdentityServer struct {
	csi.UnimplementedIdentityServer
	log *zap.Logger
}

// NewIdentityServer creates an IdentityServer.
func NewIdentityServer(log *zap.Logger) *IdentityServer {
	return &IdentityServer{log: log}
}

// GetPluginInfo returns driver name and version.
func (s *IdentityServer) GetPluginInfo(ctx context.Context, req *csi.GetPluginInfoRequest) (*csi.GetPluginInfoResponse, error) {
	return &csi.GetPluginInfoResponse{
		Name:          DriverName,
		VendorVersion: DriverVersion,
	}, nil
}

// GetPluginCapabilities declares what this driver supports.
func (s *IdentityServer) GetPluginCapabilities(ctx context.Context, req *csi.GetPluginCapabilitiesRequest) (*csi.GetPluginCapabilitiesResponse, error) {
	return &csi.GetPluginCapabilitiesResponse{
		Capabilities: []*csi.PluginCapability{
			{
				Type: &csi.PluginCapability_Service_{
					Service: &csi.PluginCapability_Service{
						Type: csi.PluginCapability_Service_CONTROLLER_SERVICE,
					},
				},
			},
			{
				Type: &csi.PluginCapability_Service_{
					Service: &csi.PluginCapability_Service{
						Type: csi.PluginCapability_Service_VOLUME_ACCESSIBILITY_CONSTRAINTS,
					},
				},
			},
			{
				Type: &csi.PluginCapability_VolumeExpansion_{
					VolumeExpansion: &csi.PluginCapability_VolumeExpansion{
						Type: csi.PluginCapability_VolumeExpansion_ONLINE,
					},
				},
			},
		},
	}, nil
}

// Probe checks driver readiness.
func (s *IdentityServer) Probe(ctx context.Context, req *csi.ProbeRequest) (*csi.ProbeResponse, error) {
	return &csi.ProbeResponse{Ready: &wrappers.BoolValue{Value: true}}, nil
}
```

## Controller Service

```go
// internal/driver/controller.go
package driver

import (
	"context"
	"fmt"
	"strconv"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/yourorg/my-csi-driver/internal/storage"
)

// ControllerServer implements the CSI Controller service.
type ControllerServer struct {
	csi.UnimplementedControllerServer
	backend storage.Backend
	log     *zap.Logger
}

// NewControllerServer creates a ControllerServer.
func NewControllerServer(backend storage.Backend, log *zap.Logger) *ControllerServer {
	return &ControllerServer{backend: backend, log: log}
}

// ControllerGetCapabilities declares which controller operations are supported.
func (s *ControllerServer) ControllerGetCapabilities(ctx context.Context, req *csi.ControllerGetCapabilitiesRequest) (*csi.ControllerGetCapabilitiesResponse, error) {
	caps := []csi.ControllerServiceCapability_RPC_Type{
		csi.ControllerServiceCapability_RPC_CREATE_DELETE_VOLUME,
		csi.ControllerServiceCapability_RPC_LIST_VOLUMES,
		csi.ControllerServiceCapability_RPC_GET_CAPACITY,
		csi.ControllerServiceCapability_RPC_CREATE_DELETE_SNAPSHOT,
		csi.ControllerServiceCapability_RPC_LIST_SNAPSHOTS,
		csi.ControllerServiceCapability_RPC_EXPAND_VOLUME,
	}

	var capabilities []*csi.ControllerServiceCapability
	for _, cap := range caps {
		capabilities = append(capabilities, &csi.ControllerServiceCapability{
			Type: &csi.ControllerServiceCapability_Rpc{
				Rpc: &csi.ControllerServiceCapability_RPC{Type: cap},
			},
		})
	}

	return &csi.ControllerGetCapabilitiesResponse{Capabilities: capabilities}, nil
}

// CreateVolume creates a new storage volume.
func (s *ControllerServer) CreateVolume(ctx context.Context, req *csi.CreateVolumeRequest) (*csi.CreateVolumeResponse, error) {
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "volume name required")
	}
	if len(req.VolumeCapabilities) == 0 {
		return nil, status.Error(codes.InvalidArgument, "volume capabilities required")
	}

	// Parse requested size
	capacityRange := req.GetCapacityRange()
	sizeBytes := int64(10 * 1024 * 1024 * 1024) // Default: 10Gi
	if capacityRange != nil && capacityRange.RequiredBytes > 0 {
		sizeBytes = capacityRange.RequiredBytes
	}

	s.log.Info("CreateVolume",
		zap.String("name", req.Name),
		zap.Int64("size_bytes", sizeBytes),
	)

	// Check for idempotency: volume may already exist from a retried request
	existingVolume, err := s.backend.GetVolume(ctx, req.Name)
	if err == nil && existingVolume != nil {
		// Volume exists: verify requested parameters match
		if existingVolume.SizeBytes < sizeBytes {
			return nil, status.Errorf(codes.AlreadyExists,
				"volume %q already exists with smaller size %d, requested %d",
				req.Name, existingVolume.SizeBytes, sizeBytes)
		}
		return &csi.CreateVolumeResponse{
			Volume: &csi.Volume{
				VolumeId:      existingVolume.ID,
				CapacityBytes: existingVolume.SizeBytes,
				VolumeContext: req.Parameters,
			},
		}, nil
	}

	// Parse storage class parameters
	params := req.Parameters
	volumeType := params["type"]
	if volumeType == "" {
		volumeType = "standard"
	}

	// Create the volume in the backend
	vol, err := s.backend.CreateVolume(ctx, storage.CreateVolumeRequest{
		Name:       req.Name,
		SizeBytes:  sizeBytes,
		VolumeType: volumeType,
		Labels:     params,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "create volume: %v", err)
	}

	return &csi.CreateVolumeResponse{
		Volume: &csi.Volume{
			VolumeId:      vol.ID,
			CapacityBytes: vol.SizeBytes,
			VolumeContext: map[string]string{
				"volumeType": vol.VolumeType,
			},
			AccessibleTopology: []*csi.Topology{
				{Segments: map[string]string{
					"topology.kubernetes.io/zone": vol.Zone,
				}},
			},
		},
	}, nil
}

// DeleteVolume deletes a volume.
func (s *ControllerServer) DeleteVolume(ctx context.Context, req *csi.DeleteVolumeRequest) (*csi.DeleteVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "volume ID required")
	}

	s.log.Info("DeleteVolume", zap.String("volume_id", req.VolumeId))

	if err := s.backend.DeleteVolume(ctx, req.VolumeId); err != nil {
		if storage.IsNotFoundError(err) {
			// Idempotent: volume already deleted
			return &csi.DeleteVolumeResponse{}, nil
		}
		return nil, status.Errorf(codes.Internal, "delete volume: %v", err)
	}

	return &csi.DeleteVolumeResponse{}, nil
}

// ControllerExpandVolume increases the volume size.
func (s *ControllerServer) ControllerExpandVolume(ctx context.Context, req *csi.ControllerExpandVolumeRequest) (*csi.ControllerExpandVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "volume ID required")
	}

	newSize := req.CapacityRange.RequiredBytes

	if err := s.backend.ResizeVolume(ctx, req.VolumeId, newSize); err != nil {
		return nil, status.Errorf(codes.Internal, "resize volume: %v", err)
	}

	return &csi.ControllerExpandVolumeResponse{
		CapacityBytes:         newSize,
		NodeExpansionRequired: true, // Node must also resize the filesystem
	}, nil
}

// CreateSnapshot creates a volume snapshot.
func (s *ControllerServer) CreateSnapshot(ctx context.Context, req *csi.CreateSnapshotRequest) (*csi.CreateSnapshotResponse, error) {
	if req.SourceVolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "source volume ID required")
	}
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "snapshot name required")
	}

	s.log.Info("CreateSnapshot",
		zap.String("name", req.Name),
		zap.String("source_volume", req.SourceVolumeId),
	)

	snap, err := s.backend.CreateSnapshot(ctx, storage.CreateSnapshotRequest{
		Name:     req.Name,
		VolumeID: req.SourceVolumeId,
		Labels:   req.Parameters,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "create snapshot: %v", err)
	}

	return &csi.CreateSnapshotResponse{
		Snapshot: &csi.Snapshot{
			SnapshotId:     snap.ID,
			SourceVolumeId: req.SourceVolumeId,
			SizeBytes:      snap.SizeBytes,
			CreationTime:   snap.CreatedAt,
			ReadyToUse:     snap.Ready,
		},
	}, nil
}

// DeleteSnapshot deletes a volume snapshot.
func (s *ControllerServer) DeleteSnapshot(ctx context.Context, req *csi.DeleteSnapshotRequest) (*csi.DeleteSnapshotResponse, error) {
	if req.SnapshotId == "" {
		return nil, status.Error(codes.InvalidArgument, "snapshot ID required")
	}

	if err := s.backend.DeleteSnapshot(ctx, req.SnapshotId); err != nil {
		if storage.IsNotFoundError(err) {
			return &csi.DeleteSnapshotResponse{}, nil
		}
		return nil, status.Errorf(codes.Internal, "delete snapshot: %v", err)
	}

	return &csi.DeleteSnapshotResponse{}, nil
}
```

## Node Service

```go
// internal/driver/node.go
package driver

import (
	"context"
	"fmt"
	"os"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	mount "k8s.io/mount-utils"
)

// NodeServer implements the CSI Node service.
type NodeServer struct {
	csi.UnimplementedNodeServer
	nodeID  string
	mounter mount.Interface
	log     *zap.Logger
}

// NewNodeServer creates a NodeServer.
func NewNodeServer(nodeID string, log *zap.Logger) *NodeServer {
	return &NodeServer{
		nodeID:  nodeID,
		mounter: mount.New(""),
		log:     log,
	}
}

// NodeGetCapabilities declares which node operations are supported.
func (s *NodeServer) NodeGetCapabilities(ctx context.Context, req *csi.NodeGetCapabilitiesRequest) (*csi.NodeGetCapabilitiesResponse, error) {
	return &csi.NodeGetCapabilitiesResponse{
		Capabilities: []*csi.NodeServiceCapability{
			{
				Type: &csi.NodeServiceCapability_Rpc{
					Rpc: &csi.NodeServiceCapability_RPC{
						Type: csi.NodeServiceCapability_RPC_STAGE_UNSTAGE_VOLUME,
					},
				},
			},
			{
				Type: &csi.NodeServiceCapability_Rpc{
					Rpc: &csi.NodeServiceCapability_RPC{
						Type: csi.NodeServiceCapability_RPC_EXPAND_VOLUME,
					},
				},
			},
			{
				Type: &csi.NodeServiceCapability_Rpc{
					Rpc: &csi.NodeServiceCapability_RPC{
						Type: csi.NodeServiceCapability_RPC_GET_VOLUME_STATS,
					},
				},
			},
		},
	}, nil
}

// NodeGetInfo returns information about this node.
func (s *NodeServer) NodeGetInfo(ctx context.Context, req *csi.NodeGetInfoRequest) (*csi.NodeGetInfoResponse, error) {
	zone := os.Getenv("TOPOLOGY_ZONE")
	return &csi.NodeGetInfoResponse{
		NodeId: s.nodeID,
		AccessibleTopology: &csi.Topology{
			Segments: map[string]string{
				"topology.kubernetes.io/zone": zone,
			},
		},
		MaxVolumesPerNode: 128,
	}, nil
}

// NodeStageVolume prepares a volume on the node (global mount point).
// This is called once per volume per node, before NodePublishVolume.
func (s *NodeServer) NodeStageVolume(ctx context.Context, req *csi.NodeStageVolumeRequest) (*csi.NodeStageVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "volume ID required")
	}
	if req.StagingTargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "staging target path required")
	}

	s.log.Info("NodeStageVolume",
		zap.String("volume_id", req.VolumeId),
		zap.String("staging_path", req.StagingTargetPath),
	)

	// Determine device path from volume context or via device enumeration
	devicePath := req.PublishContext["devicePath"]
	if devicePath == "" {
		return nil, status.Error(codes.InvalidArgument, "device path not provided in publish context")
	}

	// Check if already staged (idempotency)
	notMnt, err := mount.IsNotMountPoint(s.mounter, req.StagingTargetPath)
	if err != nil && !os.IsNotExist(err) {
		return nil, status.Errorf(codes.Internal, "check mount: %v", err)
	}

	if !notMnt {
		// Already staged
		return &csi.NodeStageVolumeResponse{}, nil
	}

	// Create staging directory
	if err := os.MkdirAll(req.StagingTargetPath, 0750); err != nil {
		return nil, status.Errorf(codes.Internal, "create staging path: %v", err)
	}

	// Format and mount the device
	diskMounter := &mount.SafeFormatAndMount{
		Interface: s.mounter,
		Exec:      mount.NewOsExec(),
	}

	fsType := "ext4"
	if req.VolumeCapability != nil {
		if mnt := req.VolumeCapability.GetMount(); mnt != nil && mnt.FsType != "" {
			fsType = mnt.FsType
		}
	}

	mountOptions := []string{"defaults"}
	if req.VolumeCapability != nil {
		if mnt := req.VolumeCapability.GetMount(); mnt != nil {
			mountOptions = append(mountOptions, mnt.MountFlags...)
		}
	}

	if err := diskMounter.FormatAndMount(devicePath, req.StagingTargetPath, fsType, mountOptions); err != nil {
		return nil, status.Errorf(codes.Internal, "format and mount: %v", err)
	}

	s.log.Info("volume staged",
		zap.String("volume_id", req.VolumeId),
		zap.String("device", devicePath),
		zap.String("staging_path", req.StagingTargetPath),
		zap.String("fs_type", fsType),
	)

	return &csi.NodeStageVolumeResponse{}, nil
}

// NodeUnstageVolume unmounts the staged volume from the node.
func (s *NodeServer) NodeUnstageVolume(ctx context.Context, req *csi.NodeUnstageVolumeRequest) (*csi.NodeUnstageVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "volume ID required")
	}
	if req.StagingTargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "staging target path required")
	}

	s.log.Info("NodeUnstageVolume",
		zap.String("volume_id", req.VolumeId),
		zap.String("staging_path", req.StagingTargetPath),
	)

	if err := mount.CleanupMountPoint(req.StagingTargetPath, s.mounter, true); err != nil {
		return nil, status.Errorf(codes.Internal, "cleanup mount point: %v", err)
	}

	return &csi.NodeUnstageVolumeResponse{}, nil
}

// NodePublishVolume bind-mounts a staged volume into a pod's target path.
func (s *NodeServer) NodePublishVolume(ctx context.Context, req *csi.NodePublishVolumeRequest) (*csi.NodePublishVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "volume ID required")
	}
	if req.TargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "target path required")
	}

	s.log.Info("NodePublishVolume",
		zap.String("volume_id", req.VolumeId),
		zap.String("target_path", req.TargetPath),
		zap.String("staging_path", req.StagingTargetPath),
	)

	// Check if already published (idempotency)
	notMnt, err := mount.IsNotMountPoint(s.mounter, req.TargetPath)
	if err != nil && !os.IsNotExist(err) {
		return nil, status.Errorf(codes.Internal, "check mount: %v", err)
	}
	if !notMnt {
		return &csi.NodePublishVolumeResponse{}, nil
	}

	// Create target directory
	if err := os.MkdirAll(req.TargetPath, 0750); err != nil {
		return nil, status.Errorf(codes.Internal, "create target path: %v", err)
	}

	// Bind-mount from staging to target
	mountOptions := []string{"bind"}
	if req.Readonly {
		mountOptions = append(mountOptions, "ro")
	}

	if err := s.mounter.Mount(req.StagingTargetPath, req.TargetPath, "", mountOptions); err != nil {
		return nil, status.Errorf(codes.Internal, "bind mount: %v", err)
	}

	return &csi.NodePublishVolumeResponse{}, nil
}

// NodeUnpublishVolume removes the bind mount from the pod's path.
func (s *NodeServer) NodeUnpublishVolume(ctx context.Context, req *csi.NodeUnpublishVolumeRequest) (*csi.NodeUnpublishVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "volume ID required")
	}
	if req.TargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "target path required")
	}

	if err := mount.CleanupMountPoint(req.TargetPath, s.mounter, true); err != nil {
		return nil, status.Errorf(codes.Internal, "cleanup: %v", err)
	}

	return &csi.NodeUnpublishVolumeResponse{}, nil
}

// NodeGetVolumeStats returns usage statistics for a published volume.
func (s *NodeServer) NodeGetVolumeStats(ctx context.Context, req *csi.NodeGetVolumeStatsRequest) (*csi.NodeGetVolumeStatsResponse, error) {
	if req.VolumePath == "" {
		return nil, status.Error(codes.InvalidArgument, "volume path required")
	}

	stats, err := getVolumeStats(req.VolumePath)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "get stats: %v", err)
	}

	return &csi.NodeGetVolumeStatsResponse{
		Usage: []*csi.VolumeUsage{
			{
				Unit:      csi.VolumeUsage_BYTES,
				Total:     stats.TotalBytes,
				Used:      stats.UsedBytes,
				Available: stats.AvailableBytes,
			},
			{
				Unit:      csi.VolumeUsage_INODES,
				Total:     stats.TotalInodes,
				Used:      stats.UsedInodes,
				Available: stats.AvailableInodes,
			},
		},
	}, nil
}

// NodeExpandVolume resizes the filesystem after a controller volume expansion.
func (s *NodeServer) NodeExpandVolume(ctx context.Context, req *csi.NodeExpandVolumeRequest) (*csi.NodeExpandVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "volume ID required")
	}
	if req.VolumePath == "" {
		return nil, status.Error(codes.InvalidArgument, "volume path required")
	}

	// Resize the filesystem online
	resizer := mount.NewResizeFs(mount.NewOsExec())
	if _, err := resizer.Resize(req.StagingTargetPath, req.VolumePath); err != nil {
		return nil, status.Errorf(codes.Internal, "resize filesystem: %v", err)
	}

	return &csi.NodeExpandVolumeResponse{
		CapacityBytes: req.CapacityRange.RequiredBytes,
	}, nil
}
```

## gRPC Server Setup

```go
// internal/driver/server.go
package driver

import (
	"context"
	"net"
	"os"
	"strings"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"go.uber.org/zap"
	"google.golang.org/grpc"

	"github.com/yourorg/my-csi-driver/internal/storage"
)

// Server manages the gRPC server for CSI services.
type Server struct {
	endpoint   string
	grpcServer *grpc.Server
	log        *zap.Logger
}

// NewServer creates a CSI driver gRPC server.
func NewServer(endpoint, nodeID string, backend storage.Backend, log *zap.Logger) *Server {
	grpcServer := grpc.NewServer(
		grpc.UnaryInterceptor(loggingInterceptor(log)),
	)

	identity := NewIdentityServer(log)
	csi.RegisterIdentityServer(grpcServer, identity)

	// Register Controller service if running in controller mode
	if os.Getenv("CSI_CONTROLLER_ENDPOINT") != "" || os.Getenv("CSI_MODE") == "controller" {
		controller := NewControllerServer(backend, log)
		csi.RegisterControllerServer(grpcServer, controller)
	}

	// Register Node service if running in node mode
	if os.Getenv("KUBE_NODE_NAME") != "" || os.Getenv("CSI_MODE") == "node" {
		node := NewNodeServer(nodeID, log)
		csi.RegisterNodeServer(grpcServer, node)
	}

	return &Server{
		endpoint:   endpoint,
		grpcServer: grpcServer,
		log:        log,
	}
}

// Run starts the gRPC server.
func (s *Server) Run(ctx context.Context) error {
	// Parse endpoint: unix:///tmp/csi.sock or tcp://0.0.0.0:10000
	scheme, addr, err := parseEndpoint(s.endpoint)
	if err != nil {
		return err
	}

	if scheme == "unix" {
		// Remove stale socket
		if err := os.Remove(addr); err != nil && !os.IsNotExist(err) {
			return err
		}
	}

	listener, err := net.Listen(scheme, addr)
	if err != nil {
		return err
	}

	s.log.Info("CSI driver listening", zap.String("endpoint", s.endpoint))

	go func() {
		<-ctx.Done()
		s.grpcServer.GracefulStop()
	}()

	return s.grpcServer.Serve(listener)
}

func parseEndpoint(endpoint string) (string, string, error) {
	parts := strings.SplitN(endpoint, "://", 2)
	if len(parts) != 2 {
		return "", "", fmt.Errorf("invalid endpoint: %q", endpoint)
	}
	return parts[0], parts[1], nil
}

func loggingInterceptor(log *zap.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		log.Debug("CSI call", zap.String("method", info.FullMethod))
		resp, err := handler(ctx, req)
		if err != nil {
			log.Error("CSI error", zap.String("method", info.FullMethod), zap.Error(err))
		}
		return resp, err
	}
}
```

## Deployment Manifests

```yaml
# deploy/controller.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-csi-controller
  namespace: kube-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: my-csi-controller
  template:
    metadata:
      labels:
        app: my-csi-controller
    spec:
      serviceAccountName: my-csi-controller
      containers:
        # CSI driver container
        - name: driver
          image: ghcr.io/yourorg/my-csi-driver:1.0.0
          args:
            - --endpoint=unix:///csi/csi.sock
            - --mode=controller
          env:
            - name: STORAGE_ENDPOINT
              valueFrom:
                secretKeyRef:
                  name: my-csi-credentials
                  key: endpoint
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi

        # external-provisioner: watches PVCs and calls CreateVolume/DeleteVolume
        - name: external-provisioner
          image: registry.k8s.io/sig-storage/csi-provisioner:v3.6.2
          args:
            - --csi-address=/csi/csi.sock
            - --v=5
            - --feature-gates=Topology=true
            - --timeout=60s
            - --default-fstype=ext4
            - --leader-election
          volumeMounts:
            - name: socket-dir
              mountPath: /csi

        # external-attacher: manages VolumeAttachment objects
        - name: external-attacher
          image: registry.k8s.io/sig-storage/csi-attacher:v4.4.2
          args:
            - --csi-address=/csi/csi.sock
            - --v=5
            - --leader-election
          volumeMounts:
            - name: socket-dir
              mountPath: /csi

        # external-resizer: handles volume expansion
        - name: external-resizer
          image: registry.k8s.io/sig-storage/csi-resizer:v1.9.2
          args:
            - --csi-address=/csi/csi.sock
            - --v=5
            - --leader-election
          volumeMounts:
            - name: socket-dir
              mountPath: /csi

        # external-snapshotter: manages VolumeSnapshot objects
        - name: external-snapshotter
          image: registry.k8s.io/sig-storage/csi-snapshotter:v7.0.1
          args:
            - --csi-address=/csi/csi.sock
            - --v=5
            - --leader-election
          volumeMounts:
            - name: socket-dir
              mountPath: /csi

      volumes:
        - name: socket-dir
          emptyDir: {}
---
# deploy/node.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-csi-node
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: my-csi-node
  template:
    metadata:
      labels:
        app: my-csi-node
    spec:
      hostNetwork: true
      serviceAccountName: my-csi-node
      containers:
        - name: driver
          image: ghcr.io/yourorg/my-csi-driver:1.0.0
          args:
            - --endpoint=unix:///csi/csi.sock
            - --mode=node
          env:
            - name: KUBE_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: TOPOLOGY_ZONE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.labels['topology.kubernetes.io/zone']
          securityContext:
            privileged: true  # Required for mounting
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
            - name: pods-mount-dir
              mountPath: /var/lib/kubelet/pods
              mountPropagation: Bidirectional
            - name: dev-dir
              mountPath: /dev

        # node-driver-registrar: registers the driver with kubelet
        - name: node-driver-registrar
          image: registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.9.2
          args:
            - --csi-address=/csi/csi.sock
            - --kubelet-registration-path=/var/lib/kubelet/plugins/my-csi-driver.example.com/csi.sock
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
            - name: registration-dir
              mountPath: /registration

        # liveness-probe sidecar
        - name: liveness-probe
          image: registry.k8s.io/sig-storage/livenessprobe:v2.11.0
          args:
            - --csi-address=/csi/csi.sock
          volumeMounts:
            - name: socket-dir
              mountPath: /csi

      volumes:
        - name: socket-dir
          hostPath:
            path: /var/lib/kubelet/plugins/my-csi-driver.example.com
            type: DirectoryOrCreate
        - name: registration-dir
          hostPath:
            path: /var/lib/kubelet/plugins_registry
            type: Directory
        - name: pods-mount-dir
          hostPath:
            path: /var/lib/kubelet/pods
            type: Directory
        - name: dev-dir
          hostPath:
            path: /dev
```

## CSI Driver Registration

```yaml
# deploy/csidriver.yaml
apiVersion: storage.k8s.io/v1
kind: CSIDriver
metadata:
  name: my-csi-driver.example.com
spec:
  attachRequired: true
  podInfoOnMount: true
  storageCapacity: true
  volumeLifecycleModes:
    - Persistent
    - Ephemeral
  fsGroupPolicy: File
---
# deploy/storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: my-csi-storage
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: my-csi-driver.example.com
parameters:
  type: high-performance
  replicationFactor: "3"
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer  # Wait for pod scheduling before creating volume
allowVolumeExpansion: true
```

## Testing with CSI Sanity Package

```go
// tests/sanity_test.go
package tests

import (
	"os"
	"testing"

	"github.com/kubernetes-csi/csi-test/v5/pkg/sanity"

	"github.com/yourorg/my-csi-driver/internal/driver"
	"github.com/yourorg/my-csi-driver/internal/storage"
	"go.uber.org/zap"
)

func TestCSISanity(t *testing.T) {
	// Use a temp directory for socket files
	tmpDir := t.TempDir()
	endpoint := "unix://" + tmpDir + "/csi.sock"

	log, _ := zap.NewDevelopment()

	// Use an in-memory fake backend for tests
	backend := storage.NewFakeBackend()

	server := driver.NewServer(endpoint, "test-node-1", backend, log)

	ctx := context.Background()
	go server.Run(ctx)

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	config := sanity.NewTestConfig()
	config.Address = endpoint
	config.TargetPath = tmpDir + "/target"
	config.StagingPath = tmpDir + "/staging"
	config.CreateTargetDir = true
	config.CreateStagingDir = true

	// Run the full CSI sanity test suite
	sanity.Test(t, config)
}
```

Run the tests:

```bash
go test ./tests/... -v -timeout 120s
```

## Summary

Building a CSI driver requires implementing three gRPC services: Identity (capabilities), Controller (volume/snapshot lifecycle), and Node (mounting). The external sidecar containers handle the Kubernetes integration plumbing—you only implement the storage backend logic. Idempotency is critical in every operation because the API server and sidecars will retry failed calls. The CSI sanity test suite validates correctness against the full specification. Once the driver is deployed, the StorageClass, PersistentVolumeClaim, and CSIDriver objects provide the user-facing API.
