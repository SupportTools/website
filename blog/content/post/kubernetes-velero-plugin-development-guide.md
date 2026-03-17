---
title: "Kubernetes Velero Plugin Development: Custom Backup Hooks and Object Store Providers"
date: 2028-04-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Velero", "Backup", "Plugin Development", "Go"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to developing custom Velero plugins in Go, covering object store providers, backup item actions, restore item actions, volume snapshotter plugins, and the plugin gRPC protocol."
more_link: "yes"
url: "/kubernetes-velero-plugin-development-guide/"
---

Velero's plugin architecture allows teams to extend backup and restore behavior beyond what the built-in providers offer. Whether you need to back up to an internal object store, encrypt specific resources before writing them to S3, or run custom pre/post-restore hooks for stateful workloads, the Velero plugin system gives you a clean extension point. This guide builds each plugin type from scratch in Go.

<!--more-->

# Kubernetes Velero Plugin Development

## Plugin Architecture Overview

Velero plugins are standalone gRPC servers. The Velero server process launches each plugin as a subprocess, establishes a gRPC connection over a Unix socket, and calls the plugin's methods during backup and restore operations.

There are six plugin types:

| Type | Interface | When Called |
|------|-----------|-------------|
| Object Store | `ObjectStore` | All backup/restore object I/O |
| Volume Snapshotter | `VolumeSnapshotter` | PV snapshot creation/deletion |
| Backup Item Action | `BackupItemAction` | Per-resource during backup |
| Restore Item Action | `RestoreItemAction` | Per-resource during restore |
| Delete Item Action | `DeleteItemAction` | Per-resource during backup deletion |
| Item Snapshotter | `ItemSnapshotter` | Custom snapshot backends |

The SDK is `github.com/vmware-tanzu/velero/pkg/plugin/velero`.

## Project Setup

```bash
mkdir velero-plugin-example
cd velero-plugin-example
go mod init github.com/yourorg/velero-plugin-example
go get github.com/vmware-tanzu/velero@v1.14.0
go get github.com/sirupsen/logrus@v1.9.3
```

Directory structure:

```
velero-plugin-example/
├── cmd/
│   └── velero-plugin-example/
│       └── main.go
├── pkg/
│   ├── objectstore/
│   │   └── plugin.go
│   ├── backupaction/
│   │   └── secret_encryptor.go
│   ├── restoreaction/
│   │   └── namespace_mapper.go
│   └── volumesnapshotter/
│       └── plugin.go
├── Dockerfile
└── go.mod
```

## The Plugin Main Entry Point

Every Velero plugin binary uses `plugin.NewServer()` to register all plugin implementations:

```go
// cmd/velero-plugin-example/main.go
package main

import (
    "github.com/sirupsen/logrus"
    "github.com/vmware-tanzu/velero/pkg/plugin/framework"

    "github.com/yourorg/velero-plugin-example/pkg/backupaction"
    "github.com/yourorg/velero-plugin-example/pkg/objectstore"
    "github.com/yourorg/velero-plugin-example/pkg/restoreaction"
    "github.com/yourorg/velero-plugin-example/pkg/volumesnapshotter"
)

func main() {
    framework.NewServer().
        RegisterObjectStore("example.io/internal-s3", newObjectStorePlugin).
        RegisterBackupItemAction("example.io/secret-encryptor", newSecretEncryptorPlugin).
        RegisterRestoreItemAction("example.io/namespace-mapper", newNamespaceMapperPlugin).
        RegisterVolumeSnapshotter("example.io/ceph-snapshotter", newCephSnapshotterPlugin).
        Serve()
}

func newObjectStorePlugin(logger logrus.FieldLogger) (interface{}, error) {
    return objectstore.NewPlugin(logger), nil
}

func newSecretEncryptorPlugin(logger logrus.FieldLogger) (interface{}, error) {
    return backupaction.NewSecretEncryptorPlugin(logger), nil
}

func newNamespaceMapperPlugin(logger logrus.FieldLogger) (interface{}, error) {
    return restoreaction.NewNamespaceMapperPlugin(logger), nil
}

func newCephSnapshotterPlugin(logger logrus.FieldLogger) (interface{}, error) {
    return volumesnapshotter.NewCephSnapshotterPlugin(logger), nil
}
```

## Object Store Plugin

The Object Store plugin replaces S3/GCS/Azure as the backup storage backend. Implement this when backing up to an internal MinIO cluster, a NetApp StorageGRID, or a proprietary object storage API.

```go
// pkg/objectstore/plugin.go
package objectstore

import (
    "context"
    "io"
    "strings"
    "time"

    "github.com/minio/minio-go/v7"
    "github.com/minio/minio-go/v7/pkg/credentials"
    "github.com/sirupsen/logrus"
    veleroplugin "github.com/vmware-tanzu/velero/pkg/plugin/framework"
)

// Plugin implements velero's ObjectStore interface backed by MinIO.
type Plugin struct {
    log    logrus.FieldLogger
    client *minio.Client
    bucket string
    prefix string
}

func NewPlugin(logger logrus.FieldLogger) *Plugin {
    return &Plugin{log: logger}
}

// Init is called once when the plugin is first used. The config map comes
// from the BackupStorageLocation spec.config field.
func (p *Plugin) Init(config map[string]string) error {
    endpoint := config["endpoint"]
    accessKey := config["accessKey"]
    secretKey := config["secretKey"]
    p.bucket = config["bucket"]
    p.prefix = config["prefix"]
    useSSL := config["useSSL"] != "false"

    p.log.WithFields(logrus.Fields{
        "endpoint": endpoint,
        "bucket":   p.bucket,
        "prefix":   p.prefix,
    }).Info("initializing MinIO object store plugin")

    client, err := minio.New(endpoint, &minio.Options{
        Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
        Secure: useSSL,
    })
    if err != nil {
        return fmt.Errorf("creating MinIO client: %w", err)
    }
    p.client = client
    return nil
}

// PutObject writes an object to the store.
func (p *Plugin) PutObject(bucket, key string, body io.Reader) error {
    ctx := context.Background()
    objectKey := p.objectKey(key)

    _, err := p.client.PutObject(ctx, bucket, objectKey, body, -1,
        minio.PutObjectOptions{
            ContentType: "application/octet-stream",
        })
    if err != nil {
        return fmt.Errorf("PutObject %s/%s: %w", bucket, objectKey, err)
    }
    p.log.WithFields(logrus.Fields{
        "bucket": bucket,
        "key":    objectKey,
    }).Debug("object stored")
    return nil
}

// GetObject retrieves an object.
func (p *Plugin) GetObject(bucket, key string) (io.ReadCloser, error) {
    ctx := context.Background()
    objectKey := p.objectKey(key)

    obj, err := p.client.GetObject(ctx, bucket, objectKey, minio.GetObjectOptions{})
    if err != nil {
        return nil, fmt.Errorf("GetObject %s/%s: %w", bucket, objectKey, err)
    }
    return obj, nil
}

// ListCommonPrefixes returns directory-like prefixes at the given prefix.
func (p *Plugin) ListCommonPrefixes(bucket, prefix, delimiter string) ([]string, error) {
    ctx := context.Background()
    fullPrefix := p.objectKey(prefix)

    var prefixes []string
    opts := minio.ListObjectsOptions{
        Prefix:    fullPrefix,
        Recursive: false,
    }
    for obj := range p.client.ListObjects(ctx, bucket, opts) {
        if obj.Err != nil {
            return nil, obj.Err
        }
        if strings.HasSuffix(obj.Key, delimiter) {
            // Strip the plugin's internal prefix before returning
            stripped := strings.TrimPrefix(obj.Key, p.prefix)
            prefixes = append(prefixes, stripped)
        }
    }
    return prefixes, nil
}

// ListObjects returns objects at the given prefix (non-recursive).
func (p *Plugin) ListObjects(bucket, prefix string) ([]string, error) {
    ctx := context.Background()
    fullPrefix := p.objectKey(prefix)

    var keys []string
    opts := minio.ListObjectsOptions{
        Prefix:    fullPrefix,
        Recursive: false,
    }
    for obj := range p.client.ListObjects(ctx, bucket, opts) {
        if obj.Err != nil {
            return nil, obj.Err
        }
        stripped := strings.TrimPrefix(obj.Key, p.prefix)
        keys = append(keys, stripped)
    }
    return keys, nil
}

// DeleteObject removes an object.
func (p *Plugin) DeleteObject(bucket, key string) error {
    ctx := context.Background()
    objectKey := p.objectKey(key)
    return p.client.RemoveObject(ctx, bucket, objectKey, minio.RemoveObjectOptions{})
}

// CreateSignedURL generates a pre-signed download URL.
func (p *Plugin) CreateSignedURL(bucket, key string, ttl time.Duration) (string, error) {
    ctx := context.Background()
    objectKey := p.objectKey(key)
    url, err := p.client.PresignedGetObject(ctx, bucket, objectKey, ttl, nil)
    if err != nil {
        return "", fmt.Errorf("presign %s/%s: %w", bucket, objectKey, err)
    }
    return url.String(), nil
}

// ObjectExists checks whether an object exists.
func (p *Plugin) ObjectExists(bucket, key string) (bool, error) {
    ctx := context.Background()
    objectKey := p.objectKey(key)
    _, err := p.client.StatObject(ctx, bucket, objectKey, minio.StatObjectOptions{})
    if err != nil {
        if minio.ToErrorResponse(err).Code == "NoSuchKey" {
            return false, nil
        }
        return false, fmt.Errorf("StatObject %s/%s: %w", bucket, objectKey, err)
    }
    return true, nil
}

func (p *Plugin) objectKey(key string) string {
    if p.prefix == "" {
        return key
    }
    return strings.TrimSuffix(p.prefix, "/") + "/" + strings.TrimPrefix(key, "/")
}
```

## Backup Item Action Plugin

A Backup Item Action intercepts each Kubernetes resource as it is being backed up. Use this to:

- Encrypt Secrets before writing them to the backup.
- Strip PII fields from ConfigMaps.
- Add annotations recording the backup timestamp.
- Skip backing up ephemeral resources.

```go
// pkg/backupaction/secret_encryptor.go
package backupaction

import (
    "encoding/base64"
    "encoding/json"
    "fmt"

    "github.com/sirupsen/logrus"
    velerov1 "github.com/vmware-tanzu/velero/pkg/apis/velero/v1"
    "github.com/vmware-tanzu/velero/pkg/plugin/velero"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/meta"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/schema"
)

// SecretEncryptorPlugin encrypts Secret data values with AES-GCM
// before they are written to the backup archive.
type SecretEncryptorPlugin struct {
    log logrus.FieldLogger
    key []byte
}

func NewSecretEncryptorPlugin(log logrus.FieldLogger) *SecretEncryptorPlugin {
    return &SecretEncryptorPlugin{log: log}
}

// Init receives plugin-specific configuration from the Backup spec.
func (p *SecretEncryptorPlugin) Init(config map[string]string) error {
    keyB64 := config["encryptionKey"]
    if keyB64 == "" {
        return fmt.Errorf("encryptionKey is required in plugin config")
    }
    key, err := base64.StdEncoding.DecodeString(keyB64)
    if err != nil {
        return fmt.Errorf("decoding encryptionKey: %w", err)
    }
    if len(key) != 32 {
        return fmt.Errorf("encryptionKey must be 32 bytes, got %d", len(key))
    }
    p.key = key
    return nil
}

// AppliesTo declares which resources this plugin processes.
func (p *SecretEncryptorPlugin) AppliesTo() (velero.ResourceSelector, error) {
    return velero.ResourceSelector{
        IncludedResources: []string{"secrets"},
    }, nil
}

// Execute is called for each Secret during backup.
// It returns the modified object and any additional items to include.
func (p *SecretEncryptorPlugin) Execute(
    item runtime.Unstructured,
    backup *velerov1.Backup,
) (runtime.Unstructured, []velero.ResourceIdentifier, error) {
    p.log.WithField("item", item.GetName()).Debug("encrypting secret")

    // Convert to a typed Secret
    secret := &corev1.Secret{}
    raw, err := json.Marshal(item.UnstructuredContent())
    if err != nil {
        return nil, nil, fmt.Errorf("marshaling secret: %w", err)
    }
    if err := json.Unmarshal(raw, secret); err != nil {
        return nil, nil, fmt.Errorf("unmarshaling secret: %w", err)
    }

    // Encrypt each data value
    encryptedData := make(map[string][]byte, len(secret.Data))
    for k, v := range secret.Data {
        encrypted, err := encryptAESGCM(p.key, v)
        if err != nil {
            return nil, nil, fmt.Errorf("encrypting key %q: %w", k, err)
        }
        encryptedData[k] = encrypted
    }
    secret.Data = encryptedData

    // Add an annotation so the restore plugin knows to decrypt
    if secret.Annotations == nil {
        secret.Annotations = make(map[string]string)
    }
    secret.Annotations["backup.example.io/encrypted"] = "aes-gcm-v1"

    // Convert back to Unstructured
    newContent, err := runtime.DefaultUnstructuredConverter.ToUnstructured(secret)
    if err != nil {
        return nil, nil, fmt.Errorf("converting to unstructured: %w", err)
    }
    item.SetUnstructuredContent(newContent)

    return item, nil, nil
}

// encryptAESGCM encrypts plaintext with AES-256-GCM.
func encryptAESGCM(key, plaintext []byte) ([]byte, error) {
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, err
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }
    nonce := make([]byte, gcm.NonceSize())
    if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }
    return gcm.Seal(nonce, nonce, plaintext, nil), nil
}
```

## Restore Item Action Plugin

The Restore Item Action runs during restore. The following example remaps namespaces during cross-environment restores (e.g., production backup restored to staging with different namespace names).

```go
// pkg/restoreaction/namespace_mapper.go
package restoreaction

import (
    "encoding/json"
    "fmt"
    "strings"

    "github.com/sirupsen/logrus"
    velerov1 "github.com/vmware-tanzu/velero/pkg/apis/velero/v1"
    "github.com/vmware-tanzu/velero/pkg/plugin/velero"
    "k8s.io/apimachinery/pkg/runtime"
)

// NamespaceMapperPlugin transforms namespace references in resources
// according to a configurable mapping during restore.
type NamespaceMapperPlugin struct {
    log     logrus.FieldLogger
    mapping map[string]string
}

func NewNamespaceMapperPlugin(log logrus.FieldLogger) *NamespaceMapperPlugin {
    return &NamespaceMapperPlugin{log: log}
}

// Init parses the namespace mapping from config.
// Config format: "prod-ns1:staging-ns1,prod-ns2:staging-ns2"
func (p *NamespaceMapperPlugin) Init(config map[string]string) error {
    p.mapping = make(map[string]string)
    raw := config["namespaceMapping"]
    if raw == "" {
        return nil
    }
    pairs := strings.Split(raw, ",")
    for _, pair := range pairs {
        parts := strings.SplitN(strings.TrimSpace(pair), ":", 2)
        if len(parts) != 2 {
            return fmt.Errorf("invalid namespace mapping pair: %q", pair)
        }
        p.mapping[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
    }
    p.log.WithField("mapping", p.mapping).Info("namespace mapper initialized")
    return nil
}

func (p *NamespaceMapperPlugin) AppliesTo() (velero.ResourceSelector, error) {
    // Apply to all resources; we will check namespace membership at runtime
    return velero.ResourceSelector{}, nil
}

func (p *NamespaceMapperPlugin) Execute(
    input *velero.RestoreItemActionExecuteInput,
) (*velero.RestoreItemActionExecuteOutput, error) {
    metadata, err := meta.Accessor(input.Item)
    if err != nil {
        return nil, fmt.Errorf("accessing item metadata: %w", err)
    }

    ns := metadata.GetNamespace()
    if ns == "" {
        // Cluster-scoped resource, nothing to remap
        return velero.NewRestoreItemActionExecuteOutput(input.Item), nil
    }

    targetNS, ok := p.mapping[ns]
    if !ok {
        return velero.NewRestoreItemActionExecuteOutput(input.Item), nil
    }

    p.log.WithFields(logrus.Fields{
        "resource":    metadata.GetName(),
        "from_ns":     ns,
        "to_ns":       targetNS,
    }).Info("remapping namespace")

    // Mutate the namespace
    content := input.Item.UnstructuredContent()
    if metaContent, ok := content["metadata"].(map[string]interface{}); ok {
        metaContent["namespace"] = targetNS
    }
    input.Item.SetUnstructuredContent(content)

    return velero.NewRestoreItemActionExecuteOutput(input.Item), nil
}
```

## Volume Snapshotter Plugin

The Volume Snapshotter plugin handles persistent volume snapshots for storage backends not supported by Velero's built-in CSI integration. This example targets Ceph RBD.

```go
// pkg/volumesnapshotter/plugin.go
package volumesnapshotter

import (
    "context"
    "fmt"
    "time"

    "github.com/ceph/go-ceph/rbd"
    "github.com/sirupsen/logrus"
    "github.com/vmware-tanzu/velero/pkg/plugin/velero"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
)

type CephSnapshotterPlugin struct {
    log  logrus.FieldLogger
    pool string
    conn *rbd.Conn
}

func NewCephSnapshotterPlugin(log logrus.FieldLogger) *CephSnapshotterPlugin {
    return &CephSnapshotterPlugin{log: log}
}

func (p *CephSnapshotterPlugin) Init(config map[string]string) error {
    p.pool = config["pool"]
    if p.pool == "" {
        p.pool = "rbd"
    }

    conn, err := rbd.NewConnWithUser(config["cephUser"])
    if err != nil {
        return fmt.Errorf("creating Ceph connection: %w", err)
    }
    conn.ReadConfigFile("/etc/ceph/ceph.conf")
    if err := conn.Connect(); err != nil {
        return fmt.Errorf("connecting to Ceph: %w", err)
    }
    p.conn = conn
    return nil
}

// CreateVolumeFromSnapshot creates a new PV from a Ceph RBD snapshot.
func (p *CephSnapshotterPlugin) CreateVolumeFromSnapshot(
    snapshotID string,
    volumeType string,
    volumeAZ string,
    iops *int64,
) (string, error) {
    ioctx, err := p.conn.OpenIOContext(p.pool)
    if err != nil {
        return "", fmt.Errorf("opening IO context: %w", err)
    }
    defer ioctx.Destroy()

    // Parse snapshotID: "imageName@snapshotName"
    parts := splitSnapshotID(snapshotID)
    if len(parts) != 2 {
        return "", fmt.Errorf("invalid snapshot ID format: %s", snapshotID)
    }
    imageName, snapName := parts[0], parts[1]

    img, err := rbd.OpenImageReadOnly(ioctx, imageName, rbd.NoSnapshot)
    if err != nil {
        return "", fmt.Errorf("opening image %s: %w", imageName, err)
    }
    defer img.Close()

    newImageName := fmt.Sprintf("restore-%s-%d", imageName, time.Now().Unix())
    if err := img.Clone(snapName, ioctx, newImageName, rbd.RbdFeatureLayering, 22); err != nil {
        return "", fmt.Errorf("cloning snapshot: %w", err)
    }

    p.log.WithFields(logrus.Fields{
        "source_snapshot": snapshotID,
        "new_image":       newImageName,
    }).Info("created volume from Ceph snapshot")

    return newImageName, nil
}

// GetVolumeInfo returns the volume type and AZ for the given PV.
func (p *CephSnapshotterPlugin) GetVolumeInfo(volumeID, volumeAZ string) (string, *int64, error) {
    return "ceph-rbd", nil, nil
}

// IsVolumeReady checks whether the volume is available.
func (p *CephSnapshotterPlugin) IsVolumeReady(volumeID, volumeAZ string) (bool, string, error) {
    ioctx, err := p.conn.OpenIOContext(p.pool)
    if err != nil {
        return false, "", err
    }
    defer ioctx.Destroy()

    _, err = rbd.OpenImageReadOnly(ioctx, volumeID, rbd.NoSnapshot)
    if err != nil {
        return false, err.Error(), nil
    }
    return true, "", nil
}

// CreateSnapshot takes a point-in-time snapshot of a PV.
func (p *CephSnapshotterPlugin) CreateSnapshot(
    volumeID, volumeAZ string,
    tags map[string]string,
) (string, error) {
    ioctx, err := p.conn.OpenIOContext(p.pool)
    if err != nil {
        return "", err
    }
    defer ioctx.Destroy()

    img, err := rbd.OpenImage(ioctx, volumeID, rbd.NoSnapshot)
    if err != nil {
        return "", fmt.Errorf("opening image %s: %w", volumeID, err)
    }
    defer img.Close()

    snapName := fmt.Sprintf("velero-%d", time.Now().UnixNano())
    snap, err := img.CreateSnapshot(snapName)
    if err != nil {
        return "", fmt.Errorf("creating snapshot: %w", err)
    }
    if err := snap.Protect(); err != nil {
        return "", fmt.Errorf("protecting snapshot: %w", err)
    }

    snapshotID := volumeID + "@" + snapName
    p.log.WithField("snapshot_id", snapshotID).Info("Ceph snapshot created")
    return snapshotID, nil
}

// DeleteSnapshot removes a Ceph RBD snapshot.
func (p *CephSnapshotterPlugin) DeleteSnapshot(snapshotID string) error {
    ioctx, err := p.conn.OpenIOContext(p.pool)
    if err != nil {
        return err
    }
    defer ioctx.Destroy()

    parts := splitSnapshotID(snapshotID)
    if len(parts) != 2 {
        return fmt.Errorf("invalid snapshot ID: %s", snapshotID)
    }
    imageName, snapName := parts[0], parts[1]

    img, err := rbd.OpenImage(ioctx, imageName, rbd.NoSnapshot)
    if err != nil {
        return err
    }
    defer img.Close()

    snap := img.GetSnapshot(snapName)
    if err := snap.Unprotect(); err != nil {
        return fmt.Errorf("unprotecting snapshot: %w", err)
    }
    return snap.Remove()
}

// GetVolumeID extracts the volume ID from a PersistentVolume.
func (p *CephSnapshotterPlugin) GetVolumeID(pv *unstructured.Unstructured) (string, error) {
    rbdSpec, found, err := unstructured.NestedMap(
        pv.Object, "spec", "rbd",
    )
    if err != nil || !found {
        return "", nil // Not an RBD volume; plugin doesn't apply
    }
    image, _, _ := unstructured.NestedString(rbdSpec, "image")
    if image == "" {
        return "", fmt.Errorf("spec.rbd.image is empty in PV %s", pv.GetName())
    }
    return image, nil
}

// SetVolumeID updates the PV with the new volume ID after restore.
func (p *CephSnapshotterPlugin) SetVolumeID(
    pv *unstructured.Unstructured,
    volumeID string,
) (*unstructured.Unstructured, error) {
    err := unstructured.SetNestedField(pv.Object, volumeID, "spec", "rbd", "image")
    return pv, err
}
```

## Containerizing the Plugin

Velero requires plugins to be delivered as Docker images. The plugin binary is run as an `initContainer` that copies the binary into a shared volume, which the Velero server pod then executes.

```dockerfile
# Dockerfile
FROM golang:1.23-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.version=$(git describe --tags --always)" \
    -o /velero-plugin-example \
    ./cmd/velero-plugin-example

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /velero-plugin-example /velero-plugin-example
USER 65534:65534
ENTRYPOINT ["/velero-plugin-example"]
```

## Installing the Plugin

```bash
# Install the plugin into an existing Velero deployment
velero plugin add ghcr.io/yourorg/velero-plugin-example:v1.0.0

# Verify the plugin is registered
velero plugin get
```

The install command adds the plugin image as an `initContainer` to the Velero deployment and creates the necessary volume mounts.

## BackupStorageLocation for the Custom Object Store

```yaml
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: internal-minio
  namespace: velero
spec:
  provider: example.io/internal-s3
  objectStorage:
    bucket: velero-backups
    prefix: cluster-prod
  config:
    endpoint: minio.internal.example.com:9000
    accessKey: <your-access-key>
    secretKey: <your-secret-key>
    useSSL: "true"
    prefix: production/
  accessMode: ReadWrite
```

## Backup with Custom Plugin Actions

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: nightly-encrypted
  namespace: velero
spec:
  storageLocation: internal-minio
  includedNamespaces:
    - production
    - staging
  includedResources:
    - "*"
  hooks:
    resources:
      - name: pre-backup-db-freeze
        includedNamespaces:
          - production
        labelSelector:
          matchLabels:
            app: postgresql
        pre:
          - exec:
              container: postgresql
              command:
                - /bin/bash
                - -c
                - "pg_dump -Fc mydb > /tmp/backup.dump"
              onError: Fail
              timeout: 300s
  labelSelector:
    matchLabels:
      backup: "true"
```

## Testing Plugins

### Unit Testing an Object Store Plugin

```go
package objectstore_test

import (
    "bytes"
    "io"
    "testing"

    "github.com/sirupsen/logrus"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/yourorg/velero-plugin-example/pkg/objectstore"
)

func TestPlugin_PutAndGetObject(t *testing.T) {
    // Use a test MinIO server (e.g., via testcontainers-go)
    minioEndpoint := startTestMinIO(t)

    log := logrus.New()
    plugin := objectstore.NewPlugin(log)

    err := plugin.Init(map[string]string{
        "endpoint":  minioEndpoint,
        "accessKey": "minioadmin",
        "secretKey": "minioadmin",
        "bucket":    "test-bucket",
        "prefix":    "test-prefix",
        "useSSL":    "false",
    })
    require.NoError(t, err)

    content := []byte("backup content")
    err = plugin.PutObject("test-bucket", "backup/my-backup.tar.gz",
        bytes.NewReader(content))
    require.NoError(t, err)

    rc, err := plugin.GetObject("test-bucket", "backup/my-backup.tar.gz")
    require.NoError(t, err)
    defer rc.Close()

    got, err := io.ReadAll(rc)
    require.NoError(t, err)
    assert.Equal(t, content, got)
}

func TestPlugin_ObjectExists(t *testing.T) {
    minioEndpoint := startTestMinIO(t)
    log := logrus.New()
    plugin := objectstore.NewPlugin(log)

    err := plugin.Init(map[string]string{
        "endpoint":  minioEndpoint,
        "accessKey": "minioadmin",
        "secretKey": "minioadmin",
        "bucket":    "test-bucket",
        "useSSL":    "false",
    })
    require.NoError(t, err)

    exists, err := plugin.ObjectExists("test-bucket", "nonexistent-key")
    require.NoError(t, err)
    assert.False(t, exists)

    err = plugin.PutObject("test-bucket", "my-key", bytes.NewReader([]byte("data")))
    require.NoError(t, err)

    exists, err = plugin.ObjectExists("test-bucket", "my-key")
    require.NoError(t, err)
    assert.True(t, exists)
}
```

### Unit Testing a Backup Item Action

```go
package backupaction_test

import (
    "encoding/base64"
    "testing"

    "github.com/sirupsen/logrus"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"

    "github.com/yourorg/velero-plugin-example/pkg/backupaction"
)

func TestSecretEncryptorPlugin_Execute(t *testing.T) {
    // Generate a test 32-byte key
    key := make([]byte, 32)
    for i := range key {
        key[i] = byte(i)
    }
    keyB64 := base64.StdEncoding.EncodeToString(key)

    log := logrus.New()
    plugin := backupaction.NewSecretEncryptorPlugin(log)
    err := plugin.Init(map[string]string{"encryptionKey": keyB64})
    require.NoError(t, err)

    secret := &corev1.Secret{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "db-creds",
            Namespace: "production",
        },
        Data: map[string][]byte{
            "password": []byte("supersecret"),
            "username": []byte("admin"),
        },
    }

    unstr, err := runtime.DefaultUnstructuredConverter.ToUnstructured(secret)
    require.NoError(t, err)
    item := &unstructured.Unstructured{Object: unstr}

    resultItem, extras, err := plugin.Execute(item, nil)
    require.NoError(t, err)
    assert.Empty(t, extras)

    // Verify data was encrypted (should not equal original)
    resultSecret := &corev1.Secret{}
    err = runtime.DefaultUnstructuredConverter.FromUnstructured(
        resultItem.UnstructuredContent(), resultSecret)
    require.NoError(t, err)

    assert.NotEqual(t, []byte("supersecret"), resultSecret.Data["password"])
    assert.NotEqual(t, []byte("admin"), resultSecret.Data["username"])
    assert.Equal(t, "aes-gcm-v1", resultSecret.Annotations["backup.example.io/encrypted"])
}
```

## Debugging Tips

**Enable plugin debug logging:**
```bash
velero plugin get
kubectl set env -n velero deployment/velero VELERO_PLUGIN_DEBUG=true
```

**Watch plugin socket connections:**
```bash
kubectl exec -n velero deployment/velero -- ls -la /tmp/plugins/
```

**Plugin startup failures** typically manifest as the Velero pod's `initContainer` exiting non-zero. Check initContainer logs:
```bash
kubectl logs -n velero deployment/velero -c velero-plugin-example
```

**gRPC errors** in the Velero log usually indicate the plugin binary panicked or returned an error from `Init`. Check that the plugin is compiled for the correct architecture (the Velero container is linux/amd64 or linux/arm64).

## Summary

Velero's plugin system provides a clean extension model for every stage of backup and restore. The key patterns are:

- Register all plugin types from a single binary entry point.
- `AppliesTo` restricts which resources a Backup/Restore Item Action processes.
- Object Store plugins replace the I/O layer completely.
- Volume Snapshotter plugins handle storage-specific snapshot lifecycle.
- Test each plugin type in isolation using `httptest`-style test servers for dependencies.

Once deployed, the plugin binary runs in the same process namespace as Velero through a well-defined gRPC protocol, making it straightforward to debug with standard Go tooling.
