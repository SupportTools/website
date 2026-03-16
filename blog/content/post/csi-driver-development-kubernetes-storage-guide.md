---
title: "CSI Driver Development for Kubernetes: Complete Implementation Guide"
date: 2026-05-31T00:00:00-05:00
draft: false
tags: ["CSI", "Kubernetes", "Storage", "Driver Development", "Go", "gRPC", "Container Storage Interface", "Production"]
categories: ["Kubernetes", "Storage", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to developing production-grade CSI (Container Storage Interface) drivers for Kubernetes with complete implementation examples, testing strategies, and deployment patterns."
more_link: "yes"
url: "/csi-driver-development-kubernetes-storage-guide/"
---

The Container Storage Interface (CSI) standardizes storage provisioning in Kubernetes, enabling third-party storage vendors to develop plugins without modifying Kubernetes core. This comprehensive guide covers CSI driver architecture, complete implementation in Go, testing strategies, and production deployment patterns.

<!--more-->

# CSI Driver Development for Kubernetes: Complete Implementation Guide

## Executive Summary

CSI drivers provide a standardized interface for storage systems to integrate with Kubernetes and other container orchestrators. This guide provides a complete walkthrough of CSI driver development, from understanding the CSI specification to implementing production-ready drivers with advanced features like snapshots, cloning, volume expansion, and topology-aware provisioning.

## CSI Architecture Overview

### CSI Components

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                            │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              Kubernetes Master                              │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │  External Provisioner (Sidecar)                     │   │ │
│  │  │  • Watches PVC creation                             │   │ │
│  │  │  • Calls CSI Controller.CreateVolume()              │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │  External Attacher (Sidecar)                        │   │ │
│  │  │  • Watches VolumeAttachment creation                │   │ │
│  │  │  • Calls CSI Controller.ControllerPublishVolume()   │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │  External Snapshotter (Sidecar)                     │   │ │
│  │  │  • Handles snapshot operations                      │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │  CSI Controller Service (Your Driver)               │   │ │
│  │  │  • CreateVolume, DeleteVolume                       │   │ │
│  │  │  • ControllerPublishVolume, ControllerUnpublishVolume│   │ │
│  │  │  • CreateSnapshot, DeleteSnapshot                   │   │ │
│  │  │  • ValidateVolumeCapabilities                       │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              Worker Nodes                                   │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │  Node Registrar (Sidecar)                           │   │ │
│  │  │  • Registers driver with kubelet                    │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │  CSI Node Service (Your Driver)                     │   │ │
│  │  │  • NodeStageVolume, NodeUnstageVolume               │   │ │
│  │  │  • NodePublishVolume, NodeUnpublishVolume           │   │ │
│  │  │  • NodeGetVolumeStats                               │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │  Kubelet                                             │   │ │
│  │  │  • Calls CSI gRPC services                          │   │ │
│  │  │  • Mounts volumes to pods                           │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
    ┌───────────▼──────────┐    ┌────────────▼────────────┐
    │  Storage Backend     │    │  Storage Backend API    │
    │  (Block/File/Object) │    │  (REST/gRPC)            │
    └──────────────────────┘    └─────────────────────────┘
```

## Complete CSI Driver Implementation

### Project Structure

```
my-csi-driver/
├── cmd/
│   └── my-csi-driver/
│       └── main.go
├── pkg/
│   ├── driver/
│   │   ├── driver.go
│   │   ├── controller.go
│   │   ├── node.go
│   │   └── identity.go
│   ├── storage/
│   │   ├── storage.go
│   │   └── client.go
│   └── utils/
│       └── utils.go
├── deploy/
│   ├── kubernetes/
│   │   ├── controller.yaml
│   │   ├── node.yaml
│   │   ├── storageclass.yaml
│   │   └── rbac.yaml
│   └── helm/
│       └── my-csi-driver/
├── test/
│   ├── e2e/
│   └── sanity/
├── go.mod
├── go.sum
├── Dockerfile
└── README.md
```

### Main Driver Implementation

```go
// cmd/my-csi-driver/main.go
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/my-org/my-csi-driver/pkg/driver"
	"k8s.io/klog/v2"
)

var (
	endpoint      = flag.String("endpoint", "unix:///csi/csi.sock", "CSI endpoint")
	nodeID        = flag.String("nodeid", "", "Node ID")
	driverName    = flag.String("drivername", "csi.example.com", "Name of the driver")
	version       = flag.String("version", "1.0.0", "Version of the driver")
	storageAPIURL = flag.String("storage-api-url", "", "Storage backend API URL")
)

func main() {
	klog.InitFlags(nil)
	flag.Parse()

	if *nodeID == "" {
		klog.Fatal("--nodeid must be provided")
	}

	if *storageAPIURL == "" {
		klog.Fatal("--storage-api-url must be provided")
	}

	// Create driver
	drv, err := driver.NewDriver(
		*driverName,
		*version,
		*nodeID,
		*endpoint,
		*storageAPIURL,
	)
	if err != nil {
		klog.Fatalf("Failed to create driver: %v", err)
	}

	// Run driver
	if err := drv.Run(); err != nil {
		klog.Fatalf("Failed to run driver: %v", err)
	}
}
```

### Driver Core Implementation

```go
// pkg/driver/driver.go
package driver

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"path"
	"path/filepath"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/grpc"
	"k8s.io/klog/v2"
)

const (
	// Driver capabilities
	PluginCapability_Service_CONTROLLER_SERVICE             = csi.PluginCapability_Service_CONTROLLER_SERVICE
	PluginCapability_Service_VOLUME_ACCESSIBILITY_CONSTRAINTS = csi.PluginCapability_Service_VOLUME_ACCESSIBILITY_CONSTRAINTS
	PluginCapability_VolumeExpansion_ONLINE                  = csi.PluginCapability_VolumeExpansion_ONLINE
	PluginCapability_VolumeExpansion_OFFLINE                 = csi.PluginCapability_VolumeExpansion_OFFLINE
)

type Driver struct {
	name              string
	version           string
	nodeID            string
	endpoint          string
	storageAPIURL     string

	// CSI services
	identityServer   csi.IdentityServer
	controllerServer csi.ControllerServer
	nodeServer       csi.NodeServer

	// gRPC server
	server *grpc.Server
}

func NewDriver(name, version, nodeID, endpoint, storageAPIURL string) (*Driver, error) {
	klog.Infof("Creating CSI driver: %s version %s", name, version)

	d := &Driver{
		name:          name,
		version:       version,
		nodeID:        nodeID,
		endpoint:      endpoint,
		storageAPIURL: storageAPIURL,
	}

	// Initialize services
	d.identityServer = NewIdentityServer(d)
	d.controllerServer = NewControllerServer(d)
	d.nodeServer = NewNodeServer(d)

	return d, nil
}

func (d *Driver) Run() error {
	// Parse endpoint
	u, err := url.Parse(d.endpoint)
	if err != nil {
		return fmt.Errorf("unable to parse endpoint: %v", err)
	}

	// Remove existing socket file
	if u.Scheme == "unix" {
		addr := path.Join(u.Host, filepath.FromSlash(u.Path))
		if err := os.Remove(addr); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to remove unix domain socket %s: %v", addr, err)
		}
	}

	// Create listener
	listener, err := net.Listen(u.Scheme, path.Join(u.Host, filepath.FromSlash(u.Path)))
	if err != nil {
		return fmt.Errorf("failed to listen: %v", err)
	}

	// Create gRPC server
	opts := []grpc.ServerOption{
		grpc.UnaryInterceptor(d.logGRPC),
	}
	d.server = grpc.NewServer(opts...)

	// Register services
	csi.RegisterIdentityServer(d.server, d.identityServer)
	csi.RegisterControllerServer(d.server, d.controllerServer)
	csi.RegisterNodeServer(d.server, d.nodeServer)

	klog.Infof("Starting CSI driver server on %s", d.endpoint)

	// Start serving
	return d.server.Serve(listener)
}

func (d *Driver) Stop() {
	klog.Info("Stopping CSI driver server")
	d.server.GracefulStop()
}

func (d *Driver) logGRPC(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
	klog.V(3).Infof("GRPC call: %s", info.FullMethod)
	klog.V(5).Infof("GRPC request: %+v", req)

	resp, err := handler(ctx, req)

	if err != nil {
		klog.Errorf("GRPC error: %v", err)
	} else {
		klog.V(5).Infof("GRPC response: %+v", resp)
	}

	return resp, err
}
```

### Identity Service Implementation

```go
// pkg/driver/identity.go
package driver

import (
	"context"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type IdentityServer struct {
	Driver *Driver
}

func NewIdentityServer(driver *Driver) csi.IdentityServer {
	return &IdentityServer{
		Driver: driver,
	}
}

func (ids *IdentityServer) GetPluginInfo(ctx context.Context, req *csi.GetPluginInfoRequest) (*csi.GetPluginInfoResponse, error) {
	return &csi.GetPluginInfoResponse{
		Name:          ids.Driver.name,
		VendorVersion: ids.Driver.version,
	}, nil
}

func (ids *IdentityServer) GetPluginCapabilities(ctx context.Context, req *csi.GetPluginCapabilitiesRequest) (*csi.GetPluginCapabilitiesResponse, error) {
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

func (ids *IdentityServer) Probe(ctx context.Context, req *csi.ProbeRequest) (*csi.ProbeResponse, error) {
	// Check if storage backend is accessible
	// This is a simplified example
	return &csi.ProbeResponse{
		Ready: wrapperspb.Bool(true),
	}, nil
}
```

### Controller Service Implementation

```go
// pkg/driver/controller.go
package driver

import (
	"context"
	"fmt"
	"strconv"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"k8s.io/klog/v2"
)

type ControllerServer struct {
	Driver *Driver
	// Add storage client here
}

func NewControllerServer(driver *Driver) csi.ControllerServer {
	return &ControllerServer{
		Driver: driver,
	}
}

func (cs *ControllerServer) CreateVolume(ctx context.Context, req *csi.CreateVolumeRequest) (*csi.CreateVolumeResponse, error) {
	// Validate request
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume name must be provided")
	}

	if req.VolumeCapabilities == nil || len(req.VolumeCapabilities) == 0 {
		return nil, status.Error(codes.InvalidArgument, "Volume capabilities must be provided")
	}

	// Extract capacity
	capacity := int64(10 * 1024 * 1024 * 1024) // Default 10GB
	if req.CapacityRange != nil && req.CapacityRange.RequiredBytes > 0 {
		capacity = req.CapacityRange.RequiredBytes
	}

	klog.Infof("Creating volume %s with capacity %d bytes", req.Name, capacity)

	// Check if volume already exists
	// In production, query your storage backend
	volumeID := fmt.Sprintf("vol-%s", req.Name)

	// Extract parameters
	parameters := req.Parameters
	fsType := parameters["fsType"]
	if fsType == "" {
		fsType = "ext4"
	}

	// Handle volume content source (cloning or snapshot restore)
	var sourceVolumeID string
	var sourceSnapshotID string

	if req.VolumeContentSource != nil {
		switch src := req.VolumeContentSource.Type.(type) {
		case *csi.VolumeContentSource_Volume:
			sourceVolumeID = src.Volume.VolumeId
			klog.Infof("Cloning from volume: %s", sourceVolumeID)
			// Implement volume cloning logic
		case *csi.VolumeContentSource_Snapshot:
			sourceSnapshotID = src.Snapshot.SnapshotId
			klog.Infof("Restoring from snapshot: %s", sourceSnapshotID)
			// Implement snapshot restore logic
		}
	}

	// Create volume in storage backend
	// This is where you'd call your storage API
	// volume, err := cs.storageClient.CreateVolume(ctx, ...)

	// Handle topology requirements
	var topology []*csi.Topology
	if req.AccessibilityRequirements != nil {
		// Process topology requirements
		for _, topo := range req.AccessibilityRequirements.Preferred {
			topology = append(topology, topo)
		}
	}

	return &csi.CreateVolumeResponse{
		Volume: &csi.Volume{
			VolumeId:      volumeID,
			CapacityBytes: capacity,
			VolumeContext: map[string]string{
				"fsType":           fsType,
				"sourceVolumeID":   sourceVolumeID,
				"sourceSnapshotID": sourceSnapshotID,
			},
			ContentSource:      req.VolumeContentSource,
			AccessibleTopology: topology,
		},
	}, nil
}

func (cs *ControllerServer) DeleteVolume(ctx context.Context, req *csi.DeleteVolumeRequest) (*csi.DeleteVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	klog.Infof("Deleting volume: %s", req.VolumeId)

	// Delete volume from storage backend
	// err := cs.storageClient.DeleteVolume(ctx, req.VolumeId)

	return &csi.DeleteVolumeResponse{}, nil
}

func (cs *ControllerServer) ControllerPublishVolume(ctx context.Context, req *csi.ControllerPublishVolumeRequest) (*csi.ControllerPublishVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.NodeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Node ID must be provided")
	}

	klog.Infof("Publishing volume %s to node %s", req.VolumeId, req.NodeId)

	// Attach volume to node in storage backend
	// This might involve:
	// - iSCSI target creation
	// - NFS export creation
	// - Block device attachment

	publishContext := map[string]string{
		"devicePath": "/dev/disk/by-id/xxx",
		// Add other metadata needed for NodeStageVolume
	}

	return &csi.ControllerPublishVolumeResponse{
		PublishContext: publishContext,
	}, nil
}

func (cs *ControllerServer) ControllerUnpublishVolume(ctx context.Context, req *csi.ControllerUnpublishVolumeRequest) (*csi.ControllerUnpublishVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	klog.Infof("Unpublishing volume %s from node %s", req.VolumeId, req.NodeId)

	// Detach volume from node in storage backend

	return &csi.ControllerUnpublishVolumeResponse{}, nil
}

func (cs *ControllerServer) ValidateVolumeCapabilities(ctx context.Context, req *csi.ValidateVolumeCapabilitiesRequest) (*csi.ValidateVolumeCapabilitiesResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.VolumeCapabilities == nil || len(req.VolumeCapabilities) == 0 {
		return nil, status.Error(codes.InvalidArgument, "Volume capabilities must be provided")
	}

	// Validate if the volume supports requested capabilities
	// Check if volume exists first
	// volume, err := cs.storageClient.GetVolume(ctx, req.VolumeId)

	// Validate each capability
	for _, cap := range req.VolumeCapabilities {
		if cap.GetMount() != nil {
			// Validate mount volume capability
			fsType := cap.GetMount().FsType
			if fsType != "" && fsType != "ext4" && fsType != "xfs" {
				return &csi.ValidateVolumeCapabilitiesResponse{
					Message: fmt.Sprintf("Unsupported fsType: %s", fsType),
				}, nil
			}
		} else if cap.GetBlock() != nil {
			// Validate block volume capability
		}

		// Validate access mode
		switch cap.AccessMode.Mode {
		case csi.VolumeCapability_AccessMode_SINGLE_NODE_WRITER,
			csi.VolumeCapability_AccessMode_SINGLE_NODE_READER_ONLY,
			csi.VolumeCapability_AccessMode_MULTI_NODE_READER_ONLY,
			csi.VolumeCapability_AccessMode_MULTI_NODE_MULTI_WRITER:
			// Supported
		default:
			return &csi.ValidateVolumeCapabilitiesResponse{
				Message: "Unsupported access mode",
			}, nil
		}
	}

	return &csi.ValidateVolumeCapabilitiesResponse{
		Confirmed: &csi.ValidateVolumeCapabilitiesResponse_Confirmed{
			VolumeCapabilities: req.VolumeCapabilities,
			VolumeContext:      req.VolumeContext,
			Parameters:         req.Parameters,
		},
	}, nil
}

func (cs *ControllerServer) ListVolumes(ctx context.Context, req *csi.ListVolumesRequest) (*csi.ListVolumesResponse, error) {
	// List volumes from storage backend
	// Handle pagination with req.StartingToken and req.MaxEntries

	return &csi.ListVolumesResponse{
		Entries: []*csi.ListVolumesResponse_Entry{
			// Populate with volumes
		},
		NextToken: "", // Set if more results available
	}, nil
}

func (cs *ControllerServer) GetCapacity(ctx context.Context, req *csi.GetCapacityRequest) (*csi.GetCapacityResponse, error) {
	// Return available capacity
	// Query storage backend for available space

	availableCapacity := int64(1024 * 1024 * 1024 * 1024) // 1TB example

	return &csi.GetCapacityResponse{
		AvailableCapacity: availableCapacity,
	}, nil
}

func (cs *ControllerServer) ControllerGetCapabilities(ctx context.Context, req *csi.ControllerGetCapabilitiesRequest) (*csi.ControllerGetCapabilitiesResponse, error) {
	return &csi.ControllerGetCapabilitiesResponse{
		Capabilities: []*csi.ControllerServiceCapability{
			{
				Type: &csi.ControllerServiceCapability_Rpc{
					Rpc: &csi.ControllerServiceCapability_RPC{
						Type: csi.ControllerServiceCapability_RPC_CREATE_DELETE_VOLUME,
					},
				},
			},
			{
				Type: &csi.ControllerServiceCapability_Rpc{
					Rpc: &csi.ControllerServiceCapability_RPC{
						Type: csi.ControllerServiceCapability_RPC_PUBLISH_UNPUBLISH_VOLUME,
					},
				},
			},
			{
				Type: &csi.ControllerServiceCapability_Rpc{
					Rpc: &csi.ControllerServiceCapability_RPC{
						Type: csi.ControllerServiceCapability_RPC_LIST_VOLUMES,
					},
				},
			},
			{
				Type: &csi.ControllerServiceCapability_Rpc{
					Rpc: &csi.ControllerServiceCapability_RPC{
						Type: csi.ControllerServiceCapability_RPC_GET_CAPACITY,
					},
				},
			},
			{
				Type: &csi.ControllerServiceCapability_Rpc{
					Rpc: &csi.ControllerServiceCapability_RPC{
						Type: csi.ControllerServiceCapability_RPC_CREATE_DELETE_SNAPSHOT,
					},
				},
			},
			{
				Type: &csi.ControllerServiceCapability_Rpc{
					Rpc: &csi.ControllerServiceCapability_RPC{
						Type: csi.ControllerServiceCapability_RPC_LIST_SNAPSHOTS,
					},
				},
			},
			{
				Type: &csi.ControllerServiceCapability_Rpc{
					Rpc: &csi.ControllerServiceCapability_RPC{
						Type: csi.ControllerServiceCapability_RPC_CLONE_VOLUME,
					},
				},
			},
			{
				Type: &csi.ControllerServiceCapability_Rpc{
					Rpc: &csi.ControllerServiceCapability_RPC{
						Type: csi.ControllerServiceCapability_RPC_EXPAND_VOLUME,
					},
				},
			},
		},
	}, nil
}

func (cs *ControllerServer) CreateSnapshot(ctx context.Context, req *csi.CreateSnapshotRequest) (*csi.CreateSnapshotResponse, error) {
	if req.SourceVolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Source volume ID must be provided")
	}

	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "Snapshot name must be provided")
	}

	klog.Infof("Creating snapshot %s from volume %s", req.Name, req.SourceVolumeId)

	// Create snapshot in storage backend
	snapshotID := fmt.Sprintf("snap-%s", req.Name)

	return &csi.CreateSnapshotResponse{
		Snapshot: &csi.Snapshot{
			SnapshotId:     snapshotID,
			SourceVolumeId: req.SourceVolumeId,
			CreationTime:   nil, // Set to actual creation time
			ReadyToUse:     true,
			SizeBytes:      0, // Set to actual size
		},
	}, nil
}

func (cs *ControllerServer) DeleteSnapshot(ctx context.Context, req *csi.DeleteSnapshotRequest) (*csi.DeleteSnapshotResponse, error) {
	if req.SnapshotId == "" {
		return nil, status.Error(codes.InvalidArgument, "Snapshot ID must be provided")
	}

	klog.Infof("Deleting snapshot: %s", req.SnapshotId)

	// Delete snapshot from storage backend

	return &csi.DeleteSnapshotResponse{}, nil
}

func (cs *ControllerServer) ListSnapshots(ctx context.Context, req *csi.ListSnapshotsRequest) (*csi.ListSnapshotsResponse, error) {
	// List snapshots from storage backend
	// Handle pagination

	return &csi.ListSnapshotsResponse{
		Entries: []*csi.ListSnapshotsResponse_Entry{
			// Populate with snapshots
		},
		NextToken: "",
	}, nil
}

func (cs *ControllerServer) ControllerExpandVolume(ctx context.Context, req *csi.ControllerExpandVolumeRequest) (*csi.ControllerExpandVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.CapacityRange == nil {
		return nil, status.Error(codes.InvalidArgument, "Capacity range must be provided")
	}

	newSize := req.CapacityRange.RequiredBytes

	klog.Infof("Expanding volume %s to %d bytes", req.VolumeId, newSize)

	// Expand volume in storage backend

	return &csi.ControllerExpandVolumeResponse{
		CapacityBytes:         newSize,
		NodeExpansionRequired: true, // Set to true if filesystem resize needed
	}, nil
}

func (cs *ControllerServer) ControllerGetVolume(ctx context.Context, req *csi.ControllerGetVolumeRequest) (*csi.ControllerGetVolumeResponse, error) {
	return nil, status.Error(codes.Unimplemented, "ControllerGetVolume not implemented")
}
```

### Node Service Implementation

```go
// pkg/driver/node.go
package driver

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"k8s.io/klog/v2"
	"k8s.io/mount-utils"
)

type NodeServer struct {
	Driver *Driver
	mounter mount.Interface
}

func NewNodeServer(driver *Driver) csi.NodeServer {
	return &NodeServer{
		Driver:  driver,
		mounter: mount.New(""),
	}
}

func (ns *NodeServer) NodeStageVolume(ctx context.Context, req *csi.NodeStageVolumeRequest) (*csi.NodeStageVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.StagingTargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "Staging target path must be provided")
	}

	if req.VolumeCapability == nil {
		return nil, status.Error(codes.InvalidArgument, "Volume capability must be provided")
	}

	klog.Infof("Staging volume %s to %s", req.VolumeId, req.StagingTargetPath)

	// Create staging directory
	if err := os.MkdirAll(req.StagingTargetPath, 0750); err != nil {
		return nil, status.Errorf(codes.Internal, "Failed to create staging path: %v", err)
	}

	// Get device path from publish context
	devicePath := req.PublishContext["devicePath"]
	if devicePath == "" {
		return nil, status.Error(codes.InvalidArgument, "Device path not found in publish context")
	}

	// Check if already staged
	notMnt, err := ns.mounter.IsLikelyNotMountPoint(req.StagingTargetPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, status.Errorf(codes.Internal, "Failed to check mount point: %v", err)
		}
	}

	if !notMnt {
		klog.Infof("Volume already staged at %s", req.StagingTargetPath)
		return &csi.NodeStageVolumeResponse{}, nil
	}

	// Format device if needed
	if req.VolumeCapability.GetMount() != nil {
		fsType := req.VolumeCapability.GetMount().FsType
		if fsType == "" {
			fsType = "ext4"
		}

		// Check if device is formatted
		existingFS, err := ns.getDeviceFS(devicePath)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "Failed to check filesystem: %v", err)
		}

		if existingFS == "" {
			// Format device
			klog.Infof("Formatting device %s with %s", devicePath, fsType)
			if err := ns.formatDevice(devicePath, fsType); err != nil {
				return nil, status.Errorf(codes.Internal, "Failed to format device: %v", err)
			}
		}

		// Mount device
		mountOptions := req.VolumeCapability.GetMount().MountFlags
		klog.Infof("Mounting %s to %s with options %v", devicePath, req.StagingTargetPath, mountOptions)

		if err := ns.mounter.Mount(devicePath, req.StagingTargetPath, fsType, mountOptions); err != nil {
			return nil, status.Errorf(codes.Internal, "Failed to mount device: %v", err)
		}
	} else if req.VolumeCapability.GetBlock() != nil {
		// For block volumes, create bind mount
		// This is a simplified example
		return nil, status.Error(codes.Unimplemented, "Block volumes not yet implemented")
	}

	return &csi.NodeStageVolumeResponse{}, nil
}

func (ns *NodeServer) NodeUnstageVolume(ctx context.Context, req *csi.NodeUnstageVolumeRequest) (*csi.NodeUnstageVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.StagingTargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "Staging target path must be provided")
	}

	klog.Infof("Unstaging volume %s from %s", req.VolumeId, req.StagingTargetPath)

	// Check if mounted
	notMnt, err := ns.mounter.IsLikelyNotMountPoint(req.StagingTargetPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &csi.NodeUnstageVolumeResponse{}, nil
		}
		return nil, status.Errorf(codes.Internal, "Failed to check mount point: %v", err)
	}

	if notMnt {
		klog.Infof("Volume not mounted at %s", req.StagingTargetPath)
		return &csi.NodeUnstageVolumeResponse{}, nil
	}

	// Unmount
	if err := ns.mounter.Unmount(req.StagingTargetPath); err != nil {
		return nil, status.Errorf(codes.Internal, "Failed to unmount: %v", err)
	}

	return &csi.NodeUnstageVolumeResponse{}, nil
}

func (ns *NodeServer) NodePublishVolume(ctx context.Context, req *csi.NodePublishVolumeRequest) (*csi.NodePublishVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.TargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "Target path must be provided")
	}

	if req.VolumeCapability == nil {
		return nil, status.Error(codes.InvalidArgument, "Volume capability must be provided")
	}

	if req.StagingTargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "Staging target path must be provided")
	}

	klog.Infof("Publishing volume %s to %s", req.VolumeId, req.TargetPath)

	// Create target directory
	if err := os.MkdirAll(req.TargetPath, 0750); err != nil {
		return nil, status.Errorf(codes.Internal, "Failed to create target path: %v", err)
	}

	// Check if already published
	notMnt, err := ns.mounter.IsLikelyNotMountPoint(req.TargetPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, status.Errorf(codes.Internal, "Failed to check mount point: %v", err)
		}
	}

	if !notMnt {
		klog.Infof("Volume already published at %s", req.TargetPath)
		return &csi.NodePublishVolumeResponse{}, nil
	}

	// Bind mount from staging path to target path
	mountOptions := []string{"bind"}
	if req.Readonly {
		mountOptions = append(mountOptions, "ro")
	}

	if req.VolumeCapability.GetMount() != nil {
		mountOptions = append(mountOptions, req.VolumeCapability.GetMount().MountFlags...)
	}

	klog.Infof("Bind mounting %s to %s with options %v", req.StagingTargetPath, req.TargetPath, mountOptions)

	if err := ns.mounter.Mount(req.StagingTargetPath, req.TargetPath, "", mountOptions); err != nil {
		return nil, status.Errorf(codes.Internal, "Failed to bind mount: %v", err)
	}

	return &csi.NodePublishVolumeResponse{}, nil
}

func (ns *NodeServer) NodeUnpublishVolume(ctx context.Context, req *csi.NodeUnpublishVolumeRequest) (*csi.NodeUnpublishVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.TargetPath == "" {
		return nil, status.Error(codes.InvalidArgument, "Target path must be provided")
	}

	klog.Infof("Unpublishing volume %s from %s", req.VolumeId, req.TargetPath)

	// Check if mounted
	notMnt, err := ns.mounter.IsLikelyNotMountPoint(req.TargetPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &csi.NodeUnpublishVolumeResponse{}, nil
		}
		return nil, status.Errorf(codes.Internal, "Failed to check mount point: %v", err)
	}

	if notMnt {
		klog.Infof("Volume not mounted at %s", req.TargetPath)
		return &csi.NodeUnpublishVolumeResponse{}, nil
	}

	// Unmount
	if err := ns.mounter.Unmount(req.TargetPath); err != nil {
		return nil, status.Errorf(codes.Internal, "Failed to unmount: %v", err)
	}

	return &csi.NodeUnpublishVolumeResponse{}, nil
}

func (ns *NodeServer) NodeGetVolumeStats(ctx context.Context, req *csi.NodeGetVolumeStatsRequest) (*csi.NodeGetVolumeStatsResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.VolumePath == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume path must be provided")
	}

	// Get volume statistics
	available, capacity, used, inodesFree, inodes, inodesUsed, err := ns.getVolumeStats(req.VolumePath)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "Failed to get volume stats: %v", err)
	}

	return &csi.NodeGetVolumeStatsResponse{
		Usage: []*csi.VolumeUsage{
			{
				Unit:      csi.VolumeUsage_BYTES,
				Available: available,
				Total:     capacity,
				Used:      used,
			},
			{
				Unit:      csi.VolumeUsage_INODES,
				Available: inodesFree,
				Total:     inodes,
				Used:      inodesUsed,
			},
		},
	}, nil
}

func (ns *NodeServer) NodeExpandVolume(ctx context.Context, req *csi.NodeExpandVolumeRequest) (*csi.NodeExpandVolumeResponse, error) {
	if req.VolumeId == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume ID must be provided")
	}

	if req.VolumePath == "" {
		return nil, status.Error(codes.InvalidArgument, "Volume path must be provided")
	}

	klog.Infof("Expanding volume %s at %s", req.VolumeId, req.VolumePath)

	// Resize filesystem
	if err := ns.resizeFilesystem(req.VolumePath); err != nil {
		return nil, status.Errorf(codes.Internal, "Failed to resize filesystem: %v", err)
	}

	return &csi.NodeExpandVolumeResponse{
		CapacityBytes: req.CapacityRange.RequiredBytes,
	}, nil
}

func (ns *NodeServer) NodeGetCapabilities(ctx context.Context, req *csi.NodeGetCapabilitiesRequest) (*csi.NodeGetCapabilitiesResponse, error) {
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
						Type: csi.NodeServiceCapability_RPC_GET_VOLUME_STATS,
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
		},
	}, nil
}

func (ns *NodeServer) NodeGetInfo(ctx context.Context, req *csi.NodeGetInfoRequest) (*csi.NodeGetInfoResponse, error) {
	return &csi.NodeGetInfoResponse{
		NodeId: ns.Driver.nodeID,
		// Add topology information if needed
		AccessibleTopology: &csi.Topology{
			Segments: map[string]string{
				"topology.kubernetes.io/zone":   "zone-1",
				"topology.kubernetes.io/region": "region-1",
			},
		},
	}, nil
}

// Helper functions

func (ns *NodeServer) formatDevice(device, fsType string) error {
	mkfsCmd := fmt.Sprintf("mkfs.%s", fsType)
	_, err := exec.Command(mkfsCmd, device).CombinedOutput()
	return err
}

func (ns *NodeServer) getDeviceFS(device string) (string, error) {
	output, err := exec.Command("blkid", "-o", "value", "-s", "TYPE", device).CombinedOutput()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if exitErr.ExitCode() == 2 {
				// No filesystem found
				return "", nil
			}
		}
		return "", err
	}

	return string(output), nil
}

func (ns *NodeServer) getVolumeStats(volumePath string) (available, capacity, used, inodesFree, inodes, inodesUsed int64, err error) {
	// Use syscall to get filesystem stats
	// This is a simplified version
	return 0, 0, 0, 0, 0, 0, nil
}

func (ns *NodeServer) resizeFilesystem(volumePath string) error {
	// Detect filesystem type
	// Call resize2fs for ext4 or xfs_growfs for xfs
	_, err := exec.Command("resize2fs", volumePath).CombinedOutput()
	return err
}
```

Due to length limitations, I'll provide the deployment configurations and testing in a summary format:

## Deployment Configuration

```yaml
# deploy/kubernetes/controller.yaml
# StatefulSet for CSI controller with sidecars:
# - external-provisioner
# - external-attacher
# - external-snapshotter
# - external-resizer
# - liveness-probe

# deploy/kubernetes/node.yaml
# DaemonSet for CSI node with sidecars:
# - node-driver-registrar
# - liveness-probe

# deploy/kubernetes/storageclass.yaml
# StorageClass definitions with various parameters

# deploy/kubernetes/rbac.yaml
# RBAC permissions for controller and node
```

## Conclusion

CSI driver development enables custom storage integration with Kubernetes. Key points:

1. **Three Services**: Identity, Controller, and Node services
2. **gRPC Protocol**: Standard interface for all CSI drivers
3. **Sidecars**: Kubernetes provides helper containers
4. **Testing**: Sanity tests and E2E validation required
5. **Production Features**: Snapshots, cloning, expansion, topology

This provides a foundation for building production-grade CSI drivers.

## Additional Resources

- [CSI Specification](https://github.com/container-storage-interface/spec)
- [Kubernetes CSI Documentation](https://kubernetes-csi.github.io/docs/)
- [CSI Driver Examples](https://github.com/kubernetes-csi/drivers)
- [CSI Sanity Tests](https://github.com/kubernetes-csi/csi-test)