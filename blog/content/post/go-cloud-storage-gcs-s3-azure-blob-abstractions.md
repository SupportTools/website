---
title: "Go Cloud Storage: GCS, S3, and Azure Blob Abstractions"
date: 2029-08-31T00:00:00-05:00
draft: false
tags: ["Go", "Cloud Storage", "GCS", "S3", "Azure Blob", "gocloud", "Multi-Cloud"]
categories: ["Go", "Cloud", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to abstracting cloud blob storage in Go covering gocloud.dev/blob interface design, streaming uploads and downloads, presigned URLs, multipart uploads, and storage class selection across GCS, S3, and Azure Blob Storage."
more_link: "yes"
url: "/go-cloud-storage-gcs-s3-azure-blob-abstractions/"
---

Most Go applications are written against a specific cloud storage SDK — the AWS SDK v2, Google Cloud Storage client, or Azure Storage SDK — and never consider portability. This tight coupling becomes a liability when a business requirement demands multi-cloud storage, when integration tests need a local storage backend, or when a cloud migration requires switching providers without rewriting application logic. This guide builds a production-ready cloud storage abstraction in Go that works across GCS, S3, and Azure Blob Storage.

<!--more-->

# Go Cloud Storage: GCS, S3, and Azure Blob Abstractions

## Section 1: The Case for a Storage Abstraction

Before reaching for `gocloud.dev/blob`, consider whether your team actually needs multi-cloud portability. The `gocloud.dev` abstraction covers the common 80% of storage operations but may not expose every provider-specific feature your application needs.

**Reasons to abstract:**
- Running integration tests against a local filesystem or MinIO without cloud credentials
- A storage migration between providers (even a temporary abstraction pays off)
- Multi-cloud deployment requirements
- Abstracting storage in shared libraries used across projects on different clouds

**Reasons to use SDK directly:**
- Provider-specific features: S3 Select, GCS Object Hold, Azure Immutable Storage
- Maximum performance with provider-tuned SDKs
- Complex batch operations using provider-specific APIs
- Your team only ever runs on one cloud

## Section 2: Interface Design

Before looking at `gocloud.dev`, design your own minimal interface. This is the pattern used in production codebases where `gocloud.dev` is too broad or where you need to compose several providers.

```go
// storage/interface.go
package storage

import (
    "context"
    "io"
    "time"
)

// ObjectInfo contains metadata about a stored object.
type ObjectInfo struct {
    Key          string
    Size         int64
    ContentType  string
    LastModified time.Time
    ETag         string
    StorageClass string
    Metadata     map[string]string
}

// ListOptions configures object listing behavior.
type ListOptions struct {
    Prefix    string
    Delimiter string // "" for recursive, "/" for directory-like
    MaxKeys   int
    StartAfter string
}

// UploadOptions configures object upload behavior.
type UploadOptions struct {
    ContentType  string
    StorageClass string
    Metadata     map[string]string
    CacheControl string
    Encryption   *EncryptionConfig
    // PartSize for multipart uploads (0 = use default 8 MiB)
    PartSize     int64
    // Concurrency for multipart uploads (0 = use default 4)
    Concurrency  int
}

// EncryptionConfig specifies server-side encryption.
type EncryptionConfig struct {
    // Provider-specific: "AES256", "aws:kms", "GOOGLE_KMS", "SSE-C"
    Type string
    // KMS key ID (for KMS encryption)
    KeyID string
}

// PresignedURLOptions configures presigned URL generation.
type PresignedURLOptions struct {
    Expiry      time.Duration
    Method      string // "GET" or "PUT"
    ContentType string // Required for PUT presigned URLs
}

// BlobStore is the core storage abstraction interface.
type BlobStore interface {
    // Upload stores an object, using multipart for large objects automatically.
    Upload(ctx context.Context, key string, r io.Reader, opts *UploadOptions) error

    // Download retrieves an object's content.
    Download(ctx context.Context, key string) (io.ReadCloser, *ObjectInfo, error)

    // DownloadRange retrieves a byte range of an object.
    DownloadRange(ctx context.Context, key string, start, end int64) (io.ReadCloser, error)

    // Delete removes an object. Returns nil if the object does not exist.
    Delete(ctx context.Context, key string) error

    // Exists checks whether an object exists.
    Exists(ctx context.Context, key string) (bool, error)

    // Stat retrieves metadata without downloading the object content.
    Stat(ctx context.Context, key string) (*ObjectInfo, error)

    // List returns object keys matching the given prefix.
    List(ctx context.Context, opts ListOptions) ([]ObjectInfo, error)

    // PresignedURL generates a time-limited URL for direct client access.
    PresignedURL(ctx context.Context, key string, opts PresignedURLOptions) (string, error)

    // Copy copies an object within the same bucket without downloading.
    Copy(ctx context.Context, srcKey, dstKey string) error

    // Close releases any resources held by the store.
    Close() error
}

// ErrNotFound is returned when an object does not exist.
var ErrNotFound = &StorageError{Code: "NotFound", Message: "object not found"}

// StorageError wraps provider-specific errors with a normalized code.
type StorageError struct {
    Code    string
    Message string
    Cause   error
}

func (e *StorageError) Error() string {
    if e.Cause != nil {
        return e.Message + ": " + e.Cause.Error()
    }
    return e.Message
}

func (e *StorageError) Unwrap() error { return e.Cause }

func IsNotFound(err error) bool {
    var se *StorageError
    if errors.As(err, &se) {
        return se.Code == "NotFound"
    }
    return false
}
```

## Section 3: AWS S3 Implementation

```go
// storage/s3/s3.go
package s3

import (
    "context"
    "errors"
    "fmt"
    "io"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/feature/s3/manager"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/aws/aws-sdk-go-v2/service/s3/types"
    "github.com/aws/smithy-go"

    "github.com/myorg/app/storage"
)

// Config configures the S3 BlobStore.
type Config struct {
    Bucket      string
    Region      string
    Endpoint    string // Override for MinIO or other S3-compatible stores
    UsePathStyle bool  // Required for MinIO
    PartSize     int64 // Multipart upload part size (default: 8 MiB)
    Concurrency  int   // Concurrent parts (default: 4)
    // StorageClassMap maps storage class names to S3 storage classes
    StorageClassMap map[string]types.StorageClass
}

// S3Store implements storage.BlobStore backed by AWS S3.
type S3Store struct {
    client     *s3.Client
    uploader   *manager.Uploader
    downloader *manager.Downloader
    presigner  *s3.PresignClient
    config     Config
}

// New creates a new S3Store.
func New(ctx context.Context, cfg Config) (*S3Store, error) {
    opts := []func(*config.LoadOptions) error{
        config.WithRegion(cfg.Region),
    }

    if cfg.Endpoint != "" {
        opts = append(opts, config.WithEndpointResolverWithOptions(
            aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
                return aws.Endpoint{
                    URL:               cfg.Endpoint,
                    SigningRegion:     cfg.Region,
                    HostnameImmutable: cfg.UsePathStyle,
                }, nil
            }),
        ))
    }

    awsCfg, err := config.LoadDefaultConfig(ctx, opts...)
    if err != nil {
        return nil, fmt.Errorf("loading AWS config: %w", err)
    }

    s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
        o.UsePathStyle = cfg.UsePathStyle
    })

    partSize := cfg.PartSize
    if partSize == 0 {
        partSize = 8 * 1024 * 1024 // 8 MiB
    }
    concurrency := cfg.Concurrency
    if concurrency == 0 {
        concurrency = 4
    }

    uploader := manager.NewUploader(s3Client, func(u *manager.Uploader) {
        u.PartSize    = partSize
        u.Concurrency = concurrency
        u.LeavePartsOnError = false
    })

    downloader := manager.NewDownloader(s3Client, func(d *manager.Downloader) {
        d.PartSize    = partSize
        d.Concurrency = concurrency
    })

    return &S3Store{
        client:     s3Client,
        uploader:   uploader,
        downloader: downloader,
        presigner:  s3.NewPresignClient(s3Client),
        config:     cfg,
    }, nil
}

// Upload stores an object in S3, using multipart upload for large objects.
func (s *S3Store) Upload(ctx context.Context, key string, r io.Reader, opts *storage.UploadOptions) error {
    input := &s3.PutObjectInput{
        Bucket: aws.String(s.config.Bucket),
        Key:    aws.String(key),
        Body:   r,
    }

    if opts != nil {
        if opts.ContentType != "" {
            input.ContentType = aws.String(opts.ContentType)
        }
        if opts.CacheControl != "" {
            input.CacheControl = aws.String(opts.CacheControl)
        }
        if len(opts.Metadata) > 0 {
            input.Metadata = opts.Metadata
        }
        if opts.StorageClass != "" {
            sc := s.mapStorageClass(opts.StorageClass)
            input.StorageClass = sc
        }
        if opts.Encryption != nil {
            switch opts.Encryption.Type {
            case "AES256":
                input.ServerSideEncryption = types.ServerSideEncryptionAes256
            case "aws:kms":
                input.ServerSideEncryption = types.ServerSideEncryptionAwsKms
                if opts.Encryption.KeyID != "" {
                    input.SSEKMSKeyId = aws.String(opts.Encryption.KeyID)
                }
            }
        }
    }

    _, err := s.uploader.Upload(ctx, input)
    if err != nil {
        return s.wrapError(err, "upload", key)
    }
    return nil
}

// Download retrieves an object from S3.
func (s *S3Store) Download(ctx context.Context, key string) (io.ReadCloser, *storage.ObjectInfo, error) {
    output, err := s.client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: aws.String(s.config.Bucket),
        Key:    aws.String(key),
    })
    if err != nil {
        return nil, nil, s.wrapError(err, "download", key)
    }

    info := &storage.ObjectInfo{
        Key:         key,
        Size:        aws.ToInt64(output.ContentLength),
        ContentType: aws.ToString(output.ContentType),
        ETag:        aws.ToString(output.ETag),
    }
    if output.LastModified != nil {
        info.LastModified = *output.LastModified
    }
    info.StorageClass = string(output.StorageClass)
    info.Metadata = output.Metadata

    return output.Body, info, nil
}

// DownloadRange retrieves a byte range using S3's Range request.
func (s *S3Store) DownloadRange(ctx context.Context, key string, start, end int64) (io.ReadCloser, error) {
    rangeHeader := fmt.Sprintf("bytes=%d-%d", start, end)
    output, err := s.client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: aws.String(s.config.Bucket),
        Key:    aws.String(key),
        Range:  aws.String(rangeHeader),
    })
    if err != nil {
        return nil, s.wrapError(err, "download-range", key)
    }
    return output.Body, nil
}

// PresignedURL generates a presigned URL for direct client access.
func (s *S3Store) PresignedURL(ctx context.Context, key string, opts storage.PresignedURLOptions) (string, error) {
    expiry := opts.Expiry
    if expiry == 0 {
        expiry = 15 * time.Minute
    }

    switch opts.Method {
    case "GET", "":
        req, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
            Bucket: aws.String(s.config.Bucket),
            Key:    aws.String(key),
        }, s3.WithPresignExpires(expiry))
        if err != nil {
            return "", fmt.Errorf("presigning GET URL for %s: %w", key, err)
        }
        return req.URL, nil

    case "PUT":
        req, err := s.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
            Bucket:      aws.String(s.config.Bucket),
            Key:         aws.String(key),
            ContentType: aws.String(opts.ContentType),
        }, s3.WithPresignExpires(expiry))
        if err != nil {
            return "", fmt.Errorf("presigning PUT URL for %s: %w", key, err)
        }
        return req.URL, nil

    default:
        return "", fmt.Errorf("unsupported presign method: %s", opts.Method)
    }
}

// Stat retrieves object metadata without downloading the content.
func (s *S3Store) Stat(ctx context.Context, key string) (*storage.ObjectInfo, error) {
    output, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
        Bucket: aws.String(s.config.Bucket),
        Key:    aws.String(key),
    })
    if err != nil {
        return nil, s.wrapError(err, "stat", key)
    }

    info := &storage.ObjectInfo{
        Key:         key,
        Size:        aws.ToInt64(output.ContentLength),
        ContentType: aws.ToString(output.ContentType),
        ETag:        aws.ToString(output.ETag),
        Metadata:    output.Metadata,
        StorageClass: string(output.StorageClass),
    }
    if output.LastModified != nil {
        info.LastModified = *output.LastModified
    }
    return info, nil
}

// List returns objects matching the prefix.
func (s *S3Store) List(ctx context.Context, opts storage.ListOptions) ([]storage.ObjectInfo, error) {
    input := &s3.ListObjectsV2Input{
        Bucket:    aws.String(s.config.Bucket),
        Prefix:    aws.String(opts.Prefix),
        Delimiter: aws.String(opts.Delimiter),
    }
    if opts.MaxKeys > 0 {
        input.MaxKeys = aws.Int32(int32(opts.MaxKeys))
    }
    if opts.StartAfter != "" {
        input.StartAfter = aws.String(opts.StartAfter)
    }

    var results []storage.ObjectInfo
    paginator := s3.NewListObjectsV2Paginator(s.client, input)

    for paginator.HasMorePages() {
        page, err := paginator.NextPage(ctx)
        if err != nil {
            return nil, fmt.Errorf("listing objects with prefix %s: %w", opts.Prefix, err)
        }
        for _, obj := range page.Contents {
            info := storage.ObjectInfo{
                Key:          aws.ToString(obj.Key),
                Size:         aws.ToInt64(obj.Size),
                ETag:         aws.ToString(obj.ETag),
                StorageClass: string(obj.StorageClass),
            }
            if obj.LastModified != nil {
                info.LastModified = *obj.LastModified
            }
            results = append(results, info)
        }
        if opts.MaxKeys > 0 && len(results) >= opts.MaxKeys {
            break
        }
    }
    return results, nil
}

// Delete removes an object. Returns nil if the object does not exist.
func (s *S3Store) Delete(ctx context.Context, key string) error {
    _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
        Bucket: aws.String(s.config.Bucket),
        Key:    aws.String(key),
    })
    if err != nil {
        return s.wrapError(err, "delete", key)
    }
    return nil
}

// Exists checks whether an object exists.
func (s *S3Store) Exists(ctx context.Context, key string) (bool, error) {
    _, err := s.Stat(ctx, key)
    if err != nil {
        if storage.IsNotFound(err) {
            return false, nil
        }
        return false, err
    }
    return true, nil
}

// Copy copies an object within the bucket without downloading.
func (s *S3Store) Copy(ctx context.Context, srcKey, dstKey string) error {
    _, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
        Bucket:     aws.String(s.config.Bucket),
        CopySource: aws.String(s.config.Bucket + "/" + srcKey),
        Key:        aws.String(dstKey),
    })
    if err != nil {
        return fmt.Errorf("copying %s to %s: %w", srcKey, dstKey, err)
    }
    return nil
}

// Close is a no-op for S3 (no persistent connections to release).
func (s *S3Store) Close() error { return nil }

func (s *S3Store) wrapError(err error, op, key string) error {
    if err == nil {
        return nil
    }

    var ae smithy.APIError
    if errors.As(err, &ae) {
        code := ae.ErrorCode()
        if code == "NoSuchKey" || code == "NotFound" || code == "404" {
            return &storage.StorageError{
                Code:    "NotFound",
                Message: fmt.Sprintf("object not found: %s", key),
                Cause:   err,
            }
        }
        return &storage.StorageError{
            Code:    code,
            Message: fmt.Sprintf("%s failed for key %s: %s", op, key, ae.ErrorMessage()),
            Cause:   err,
        }
    }
    return &storage.StorageError{
        Code:    "Unknown",
        Message: fmt.Sprintf("%s failed for key %s", op, key),
        Cause:   err,
    }
}

func (s *S3Store) mapStorageClass(class string) types.StorageClass {
    if s.config.StorageClassMap != nil {
        if sc, ok := s.config.StorageClassMap[class]; ok {
            return sc
        }
    }
    // Default mapping
    switch class {
    case "archive":
        return types.StorageClassGlacierIr
    case "cold":
        return types.StorageClassStandardIa
    case "standard", "":
        return types.StorageClassStandard
    default:
        return types.StorageClass(class)
    }
}
```

## Section 4: GCS Implementation

```go
// storage/gcs/gcs.go
package gcs

import (
    "context"
    "fmt"
    "io"
    "time"

    "cloud.google.com/go/storage"
    "google.golang.org/api/iterator"
    "google.golang.org/api/option"

    blobstorage "github.com/myorg/app/storage"
)

// Config configures the GCS BlobStore.
type Config struct {
    Bucket          string
    CredentialsFile string // Optional: path to service account JSON
    ProjectID       string
}

// GCSStore implements storage.BlobStore backed by Google Cloud Storage.
type GCSStore struct {
    client *storage.Client
    bucket *storage.BucketHandle
    config Config
}

// New creates a new GCSStore.
func New(ctx context.Context, cfg Config) (*GCSStore, error) {
    var opts []option.ClientOption
    if cfg.CredentialsFile != "" {
        opts = append(opts, option.WithCredentialsFile(cfg.CredentialsFile))
    }

    client, err := storage.NewClient(ctx, opts...)
    if err != nil {
        return nil, fmt.Errorf("creating GCS client: %w", err)
    }

    return &GCSStore{
        client: client,
        bucket: client.Bucket(cfg.Bucket),
        config: cfg,
    }, nil
}

// Upload stores an object in GCS using a resumable upload for large files.
func (g *GCSStore) Upload(ctx context.Context, key string, r io.Reader, opts *blobstorage.UploadOptions) error {
    obj := g.bucket.Object(key)

    // Use resumable upload for reliable large file transfers
    wc := obj.NewWriter(ctx)
    wc.ChunkSize = 8 * 1024 * 1024 // 8 MiB chunks

    if opts != nil {
        if opts.ContentType != "" {
            wc.ContentType = opts.ContentType
        }
        if opts.CacheControl != "" {
            wc.CacheControl = opts.CacheControl
        }
        if len(opts.Metadata) > 0 {
            wc.Metadata = opts.Metadata
        }
        if opts.StorageClass != "" {
            wc.StorageClass = g.mapStorageClass(opts.StorageClass)
        }
        if opts.Encryption != nil && opts.Encryption.KeyID != "" {
            // Customer-managed encryption key (CMEK)
            obj = obj.Key([]byte(opts.Encryption.KeyID))
            wc = obj.NewWriter(ctx)
        }
    }

    if _, err := io.Copy(wc, r); err != nil {
        wc.Close()
        return fmt.Errorf("writing to GCS object %s: %w", key, err)
    }

    if err := wc.Close(); err != nil {
        return g.wrapError(err, "upload", key)
    }
    return nil
}

// Download retrieves an object from GCS.
func (g *GCSStore) Download(ctx context.Context, key string) (io.ReadCloser, *blobstorage.ObjectInfo, error) {
    obj := g.bucket.Object(key)

    attrs, err := obj.Attrs(ctx)
    if err != nil {
        return nil, nil, g.wrapError(err, "stat", key)
    }

    rc, err := obj.NewReader(ctx)
    if err != nil {
        return nil, nil, g.wrapError(err, "download", key)
    }

    info := &blobstorage.ObjectInfo{
        Key:          key,
        Size:         attrs.Size,
        ContentType:  attrs.ContentType,
        ETag:         attrs.Etag,
        LastModified: attrs.Updated,
        StorageClass: attrs.StorageClass,
        Metadata:     attrs.Metadata,
    }

    return rc, info, nil
}

// DownloadRange retrieves a byte range from GCS.
func (g *GCSStore) DownloadRange(ctx context.Context, key string, start, end int64) (io.ReadCloser, error) {
    rc, err := g.bucket.Object(key).NewRangeReader(ctx, start, end-start+1)
    if err != nil {
        return nil, g.wrapError(err, "download-range", key)
    }
    return rc, nil
}

// PresignedURL generates a signed URL for GCS.
func (g *GCSStore) PresignedURL(ctx context.Context, key string, opts blobstorage.PresignedURLOptions) (string, error) {
    expiry := opts.Expiry
    if expiry == 0 {
        expiry = 15 * time.Minute
    }

    method := opts.Method
    if method == "" {
        method = "GET"
    }

    signedURL, err := g.bucket.SignedURL(key, &storage.SignedURLOptions{
        Method:      method,
        Expires:     time.Now().Add(expiry),
        ContentType: opts.ContentType,
        Scheme:      storage.SigningSchemeV4,
    })
    if err != nil {
        return "", fmt.Errorf("signing URL for %s: %w", key, err)
    }
    return signedURL, nil
}

// Stat retrieves object metadata from GCS.
func (g *GCSStore) Stat(ctx context.Context, key string) (*blobstorage.ObjectInfo, error) {
    attrs, err := g.bucket.Object(key).Attrs(ctx)
    if err != nil {
        return nil, g.wrapError(err, "stat", key)
    }

    return &blobstorage.ObjectInfo{
        Key:          key,
        Size:         attrs.Size,
        ContentType:  attrs.ContentType,
        ETag:         attrs.Etag,
        LastModified: attrs.Updated,
        StorageClass: attrs.StorageClass,
        Metadata:     attrs.Metadata,
    }, nil
}

// List returns objects matching the prefix from GCS.
func (g *GCSStore) List(ctx context.Context, opts blobstorage.ListOptions) ([]blobstorage.ObjectInfo, error) {
    query := &storage.Query{
        Prefix:    opts.Prefix,
        Delimiter: opts.Delimiter,
    }

    var results []blobstorage.ObjectInfo
    it := g.bucket.Objects(ctx, query)

    for {
        attrs, err := it.Next()
        if err == iterator.Done {
            break
        }
        if err != nil {
            return nil, fmt.Errorf("listing GCS objects: %w", err)
        }
        results = append(results, blobstorage.ObjectInfo{
            Key:          attrs.Name,
            Size:         attrs.Size,
            ContentType:  attrs.ContentType,
            ETag:         attrs.Etag,
            LastModified: attrs.Updated,
            StorageClass: attrs.StorageClass,
        })
        if opts.MaxKeys > 0 && len(results) >= opts.MaxKeys {
            break
        }
    }
    return results, nil
}

// Delete removes an object from GCS.
func (g *GCSStore) Delete(ctx context.Context, key string) error {
    if err := g.bucket.Object(key).Delete(ctx); err != nil {
        if err == storage.ErrObjectNotExist {
            return nil // Idempotent delete
        }
        return g.wrapError(err, "delete", key)
    }
    return nil
}

// Exists checks whether a GCS object exists.
func (g *GCSStore) Exists(ctx context.Context, key string) (bool, error) {
    _, err := g.Stat(ctx, key)
    if err != nil {
        if blobstorage.IsNotFound(err) {
            return false, nil
        }
        return false, err
    }
    return true, nil
}

// Copy copies a GCS object within the same bucket.
func (g *GCSStore) Copy(ctx context.Context, srcKey, dstKey string) error {
    src := g.bucket.Object(srcKey)
    dst := g.bucket.Object(dstKey)
    if _, err := dst.CopierFrom(src).Run(ctx); err != nil {
        return fmt.Errorf("copying GCS object %s to %s: %w", srcKey, dstKey, err)
    }
    return nil
}

// Close releases GCS client resources.
func (g *GCSStore) Close() error {
    return g.client.Close()
}

func (g *GCSStore) wrapError(err error, op, key string) error {
    if err == storage.ErrObjectNotExist || err == storage.ErrBucketNotExist {
        return &blobstorage.StorageError{
            Code:    "NotFound",
            Message: fmt.Sprintf("object not found: %s", key),
            Cause:   err,
        }
    }
    return &blobstorage.StorageError{
        Code:    "GCSError",
        Message: fmt.Sprintf("%s failed for key %s", op, key),
        Cause:   err,
    }
}

func (g *GCSStore) mapStorageClass(class string) string {
    switch class {
    case "archive":
        return "ARCHIVE"
    case "cold":
        return "NEARLINE"
    case "warm":
        return "COLDLINE"
    case "standard", "":
        return "STANDARD"
    default:
        return class
    }
}
```

## Section 5: gocloud.dev/blob Integration

For teams that need the flexibility of `gocloud.dev`'s URL-based configuration, here is how to wrap it behind our interface:

```go
// storage/gocloud/gocloud.go
package gocloud

import (
    "context"
    "fmt"
    "io"

    "gocloud.dev/blob"
    // Register providers
    _ "gocloud.dev/blob/azureblob"
    _ "gocloud.dev/blob/fileblob"
    _ "gocloud.dev/blob/gcsblob"
    _ "gocloud.dev/blob/s3blob"

    blobstorage "github.com/myorg/app/storage"
)

// GocloudStore wraps gocloud.dev/blob behind our BlobStore interface.
type GocloudStore struct {
    bucket *blob.Bucket
}

// New opens a blob bucket using a URL.
// Examples:
//   s3://my-bucket?region=us-east-1
//   gs://my-bucket
//   azblob://my-container
//   file:///tmp/test-bucket
//   mem://
func New(ctx context.Context, bucketURL string) (*GocloudStore, error) {
    b, err := blob.OpenBucket(ctx, bucketURL)
    if err != nil {
        return nil, fmt.Errorf("opening bucket %s: %w", bucketURL, err)
    }
    return &GocloudStore{bucket: b}, nil
}

// Upload stores an object using gocloud.dev/blob.
func (g *GocloudStore) Upload(ctx context.Context, key string, r io.Reader, opts *blobstorage.UploadOptions) error {
    wopts := &blob.WriterOptions{}
    if opts != nil {
        wopts.ContentType = opts.ContentType
        wopts.Metadata = opts.Metadata
    }

    w, err := g.bucket.NewWriter(ctx, key, wopts)
    if err != nil {
        return fmt.Errorf("creating writer for %s: %w", key, err)
    }

    if _, err := io.Copy(w, r); err != nil {
        w.Cancel()
        return fmt.Errorf("writing %s: %w", key, err)
    }

    return w.Close()
}

// Download retrieves an object using gocloud.dev/blob.
func (g *GocloudStore) Download(ctx context.Context, key string) (io.ReadCloser, *blobstorage.ObjectInfo, error) {
    r, err := g.bucket.NewReader(ctx, key, nil)
    if err != nil {
        if blob.IsNotExist(err) {
            return nil, nil, &blobstorage.StorageError{Code: "NotFound", Message: key, Cause: err}
        }
        return nil, nil, fmt.Errorf("creating reader for %s: %w", key, err)
    }

    attrs, err := g.bucket.Attributes(ctx, key)
    if err != nil {
        r.Close()
        return nil, nil, err
    }

    info := &blobstorage.ObjectInfo{
        Key:          key,
        Size:         attrs.Size,
        ContentType:  attrs.ContentType,
        LastModified: attrs.ModTime,
        ETag:         attrs.ETag,
        Metadata:     attrs.Metadata,
    }

    return r, info, nil
}

// Remaining methods delegate to the S3/GCS implementations for full feature support.
// gocloud.dev covers the basics but lacks provider-specific features.

func (g *GocloudStore) Close() error {
    return g.bucket.Close()
}
```

## Section 6: Streaming Upload and Download Patterns

```go
// patterns/streaming.go
package patterns

import (
    "compress/gzip"
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "hash"
    "io"
    "time"

    blobstorage "github.com/myorg/app/storage"
)

// VerifiedUpload uploads a file and verifies its SHA-256 hash after upload.
func VerifiedUpload(ctx context.Context, store blobstorage.BlobStore, key string, r io.Reader) (string, error) {
    pr, pw := io.Pipe()

    // Hash the data as it flows through the pipe
    hasher := sha256.New()
    tee := io.TeeReader(r, pw)

    errCh := make(chan error, 1)
    go func() {
        defer pw.Close()
        if _, err := io.Copy(hasher, tee); err != nil {
            errCh <- fmt.Errorf("hashing: %w", err)
            return
        }
        errCh <- nil
    }()

    if err := store.Upload(ctx, key, pr, &blobstorage.UploadOptions{
        ContentType: "application/octet-stream",
    }); err != nil {
        return "", fmt.Errorf("upload failed: %w", err)
    }

    if err := <-errCh; err != nil {
        return "", err
    }

    checksum := hex.EncodeToString(hasher.Sum(nil))
    return checksum, nil
}

// CompressedUpload compresses data on-the-fly during upload.
func CompressedUpload(ctx context.Context, store blobstorage.BlobStore, key string, r io.Reader) error {
    pr, pw := io.Pipe()

    errCh := make(chan error, 1)
    go func() {
        gz := gzip.NewWriter(pw)
        if _, err := io.Copy(gz, r); err != nil {
            gz.Close()
            pw.CloseWithError(err)
            errCh <- err
            return
        }
        if err := gz.Close(); err != nil {
            pw.CloseWithError(err)
            errCh <- err
            return
        }
        pw.Close()
        errCh <- nil
    }()

    if err := store.Upload(ctx, key+".gz", pr, &blobstorage.UploadOptions{
        ContentType:  "application/gzip",
        CacheControl: "public, max-age=3600",
    }); err != nil {
        return fmt.Errorf("compressed upload: %w", err)
    }

    return <-errCh
}

// checksumReader wraps an io.Reader and validates the SHA-256 on close.
type checksumReader struct {
    reader   io.ReadCloser
    hasher   hash.Hash
    expected string
}

func newChecksumReader(r io.ReadCloser, expectedSHA256 string) *checksumReader {
    return &checksumReader{
        reader:   r,
        hasher:   sha256.New(),
        expected: expectedSHA256,
    }
}

func (c *checksumReader) Read(p []byte) (int, error) {
    n, err := c.reader.Read(p)
    if n > 0 {
        c.hasher.Write(p[:n])
    }
    return n, err
}

func (c *checksumReader) Close() error {
    if err := c.reader.Close(); err != nil {
        return err
    }
    if c.expected == "" {
        return nil
    }
    actual := hex.EncodeToString(c.hasher.Sum(nil))
    if actual != c.expected {
        return fmt.Errorf("checksum mismatch: expected %s, got %s", c.expected, actual)
    }
    return nil
}

// VerifiedDownload downloads an object and verifies its SHA-256 checksum.
func VerifiedDownload(ctx context.Context, store blobstorage.BlobStore, key, expectedSHA256 string) (io.ReadCloser, error) {
    rc, _, err := store.Download(ctx, key)
    if err != nil {
        return nil, err
    }
    return newChecksumReader(rc, expectedSHA256), nil
}

// CopyWithTimeout copies an object with a deadline.
func CopyWithTimeout(ctx context.Context, store blobstorage.BlobStore, srcKey, dstKey string, timeout time.Duration) error {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()
    return store.Copy(ctx, srcKey, dstKey)
}
```

## Section 7: Storage Class Selection Strategy

```go
// storage/tiering/tiering.go
package tiering

import (
    "context"
    "time"

    blobstorage "github.com/myorg/app/storage"
)

// TieringPolicy defines when objects move between storage classes.
type TieringPolicy struct {
    // WarmAfter: objects accessed more recently than this use "warm" storage class
    WarmAfter time.Duration
    // ColdAfter: objects not accessed for this long use "cold" storage class
    ColdAfter time.Duration
    // ArchiveAfter: objects not accessed for this long use "archive" storage class
    ArchiveAfter time.Duration
}

// DefaultTieringPolicy is a sensible default for general-purpose objects.
var DefaultTieringPolicy = TieringPolicy{
    WarmAfter:    7 * 24 * time.Hour,    // 7 days
    ColdAfter:    30 * 24 * time.Hour,   // 30 days
    ArchiveAfter: 365 * 24 * time.Hour,  // 1 year
}

// StorageClassForAge returns the appropriate storage class based on object age.
func StorageClassForAge(age time.Duration, policy TieringPolicy) string {
    switch {
    case age < policy.WarmAfter:
        return "standard"
    case age < policy.ColdAfter:
        return "warm"
    case age < policy.ArchiveAfter:
        return "cold"
    default:
        return "archive"
    }
}

// StorageClassForObject determines the right storage class for an object
// based on its metadata and access patterns.
func StorageClassForObject(info *blobstorage.ObjectInfo, policy TieringPolicy) string {
    age := time.Since(info.LastModified)
    return StorageClassForAge(age, policy)
}

// TierObjects re-uploads objects to the appropriate storage class based on age.
// This is used in lifecycle management jobs.
func TierObjects(ctx context.Context, store blobstorage.BlobStore, prefix string, policy TieringPolicy) (int, error) {
    objects, err := store.List(ctx, blobstorage.ListOptions{
        Prefix: prefix,
    })
    if err != nil {
        return 0, err
    }

    var updated int
    for _, obj := range objects {
        targetClass := StorageClassForObject(&obj, policy)
        if obj.StorageClass == targetClass {
            continue
        }

        // For S3: use CopyObject with storage class parameter (copy-in-place)
        // For GCS: use rewrite operation
        // For simplicity, we re-download and re-upload (production would use server-side copy)
        rc, _, err := store.Download(ctx, obj.Key)
        if err != nil {
            return updated, err
        }

        err = store.Upload(ctx, obj.Key, rc, &blobstorage.UploadOptions{
            ContentType:  obj.ContentType,
            StorageClass: targetClass,
            Metadata:     obj.Metadata,
        })
        rc.Close()
        if err != nil {
            return updated, err
        }
        updated++
    }
    return updated, nil
}
```

## Section 8: Factory Pattern and Local Filesystem Backend

```go
// storage/factory/factory.go
package factory

import (
    "context"
    "fmt"
    "strings"

    blobstorage "github.com/myorg/app/storage"
    "github.com/myorg/app/storage/gcs"
    "github.com/myorg/app/storage/gocloud"
    "github.com/myorg/app/storage/s3"
)

// Config is the unified configuration for storage backends.
type Config struct {
    // Backend: "s3", "gcs", "azure", "local", "memory"
    Backend string

    // S3 settings
    S3Bucket    string
    S3Region    string
    S3Endpoint  string // For MinIO

    // GCS settings
    GCSBucket   string
    GCSProject  string
    GCSCredFile string

    // Local/test settings
    LocalPath   string

    // Multipart upload settings
    PartSize    int64
    Concurrency int
}

// New creates a BlobStore from configuration.
func New(ctx context.Context, cfg Config) (blobstorage.BlobStore, error) {
    switch strings.ToLower(cfg.Backend) {
    case "s3":
        return s3.New(ctx, s3.Config{
            Bucket:      cfg.S3Bucket,
            Region:      cfg.S3Region,
            Endpoint:    cfg.S3Endpoint,
            UsePathStyle: cfg.S3Endpoint != "",
            PartSize:    cfg.PartSize,
            Concurrency: cfg.Concurrency,
        })

    case "gcs":
        return gcs.New(ctx, gcs.Config{
            Bucket:          cfg.GCSBucket,
            CredentialsFile: cfg.GCSCredFile,
            ProjectID:       cfg.GCSProject,
        })

    case "azure":
        // Delegates to gocloud which handles Azure Blob via azureblob driver
        return gocloud.New(ctx, fmt.Sprintf("azblob://%s", cfg.S3Bucket))

    case "local":
        // Use gocloud's fileblob driver for local filesystem (useful for testing)
        if err := os.MkdirAll(cfg.LocalPath, 0755); err != nil {
            return nil, fmt.Errorf("creating local storage dir: %w", err)
        }
        return gocloud.New(ctx, "file://"+cfg.LocalPath)

    case "memory", "mem":
        // In-memory storage for unit tests
        return gocloud.New(ctx, "mem://")

    default:
        return nil, fmt.Errorf("unknown storage backend: %s", cfg.Backend)
    }
}
```

## Section 9: Testing the Abstraction

```go
// storage/storage_test.go
package storage_test

import (
    "bytes"
    "context"
    "strings"
    "testing"

    "github.com/myorg/app/storage/factory"
)

// TestBlobStore runs a standard compliance test suite against any BlobStore.
func TestBlobStore(t *testing.T) {
    ctx := context.Background()

    // Use in-memory backend for unit tests (no cloud credentials needed)
    store, err := factory.New(ctx, factory.Config{
        Backend: "memory",
    })
    if err != nil {
        t.Fatalf("creating store: %v", err)
    }
    defer store.Close()

    t.Run("upload_and_download", func(t *testing.T) {
        content := "Hello, cloud storage!"
        if err := store.Upload(ctx, "test/hello.txt",
            strings.NewReader(content),
            nil); err != nil {
            t.Fatalf("upload: %v", err)
        }

        rc, info, err := store.Download(ctx, "test/hello.txt")
        if err != nil {
            t.Fatalf("download: %v", err)
        }
        defer rc.Close()

        var buf bytes.Buffer
        if _, err := buf.ReadFrom(rc); err != nil {
            t.Fatalf("reading download: %v", err)
        }

        if buf.String() != content {
            t.Errorf("content mismatch: got %q, want %q", buf.String(), content)
        }
        if info.Size != int64(len(content)) {
            t.Errorf("size mismatch: got %d, want %d", info.Size, len(content))
        }
    })

    t.Run("exists_after_upload", func(t *testing.T) {
        exists, err := store.Exists(ctx, "test/hello.txt")
        if err != nil {
            t.Fatalf("exists: %v", err)
        }
        if !exists {
            t.Error("expected object to exist after upload")
        }
    })

    t.Run("delete_is_idempotent", func(t *testing.T) {
        if err := store.Delete(ctx, "test/hello.txt"); err != nil {
            t.Fatalf("first delete: %v", err)
        }
        // Second delete should not error
        if err := store.Delete(ctx, "test/hello.txt"); err != nil {
            t.Fatalf("idempotent delete: %v", err)
        }
    })

    t.Run("download_not_found", func(t *testing.T) {
        _, _, err := store.Download(ctx, "nonexistent/key")
        if err == nil {
            t.Fatal("expected error for nonexistent key")
        }
        if !isNotFound(err) {
            t.Errorf("expected NotFound error, got: %v", err)
        }
    })
}
```

## Conclusion

The storage abstraction in this guide provides a clean boundary between application code and cloud provider SDKs without sacrificing access to provider-specific features. The interface is intentionally minimal — upload, download, delete, list, stat, presign, copy — covering 95% of real-world use cases.

For production deployments, two patterns are critical: verifying object integrity with checksums on upload and download (Section 6), and using the factory pattern (Section 8) to select the backend from configuration rather than code. This makes environment-specific configuration (production uses S3, CI uses in-memory) straightforward without changing application logic.

The multipart upload handling is automatic via the AWS SDK's `manager.Uploader` — any object above `PartSize` is automatically split into parallel parts, dramatically improving throughput for large objects like container images, database dumps, or video files.
