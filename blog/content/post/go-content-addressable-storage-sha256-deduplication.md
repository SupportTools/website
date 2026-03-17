---
title: "Go: Implementing Content-Addressable Storage (CAS) with SHA-256 Deduplication for File Systems"
date: 2031-09-27T00:00:00-05:00
draft: false
tags: ["Go", "Storage", "SHA-256", "Deduplication", "Content-Addressable Storage", "File Systems"]
categories: ["Go", "Storage"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building a production-grade content-addressable storage engine in Go, covering SHA-256 keyed objects, deduplication, chunking strategies, and garbage collection."
more_link: "yes"
url: "/go-content-addressable-storage-sha256-deduplication/"
---

Content-addressable storage is one of those ideas that looks deceptively simple until you implement it at scale. The premise: every object is identified by the cryptographic hash of its content. Store a file once, reference it by hash everywhere. Change the file—get a new hash and a new object. The consequences are profound: deduplication is automatic, data integrity verification is intrinsic, caching is trivially correct, and distributed systems can reconcile state by comparing hash trees rather than timestamps.

Git uses CAS for every blob and tree. Docker uses it for layers. Bazel uses it for build artifacts. This guide shows how to build a production-quality CAS engine in Go, covering the core store, chunked object deduplication, a reference-counted garbage collector, and the HTTP API you need to make it usable.

<!--more-->

# Go Content-Addressable Storage with SHA-256 Deduplication

## Design Principles

Before writing a line of code, the design constraints need to be explicit:

**Immutability**: Once written, an object never changes. Its identity is its content hash. This eliminates an entire class of consistency problems.

**Deduplication at ingestion**: Two clients uploading identical content produce one stored object. The savings compound: a 10 GB dataset uploaded 1000 times by 1000 different users might consume only 10 GB of storage rather than 10 TB.

**Verifiable integrity**: Any read can be checked by rehashing. Bit-rot is detectable immediately.

**Reference counting for GC**: Objects are retained as long as at least one reference points to them. When references drop to zero, the object is eligible for deletion.

## Project Layout

```
cas/
├── cmd/
│   └── casserver/
│       └── main.go
├── internal/
│   ├── store/
│   │   ├── store.go          # Core CAS interface and implementation
│   │   ├── chunk.go          # Content-defined chunking (CDC)
│   │   ├── manifest.go       # Multi-chunk object manifests
│   │   └── gc.go             # Reference counting and garbage collection
│   ├── api/
│   │   ├── handler.go        # HTTP handlers
│   │   └── middleware.go     # Auth, logging, metrics
│   └── metrics/
│       └── metrics.go        # Prometheus metrics
├── go.mod
└── go.sum
```

## Core Store Interface

```go
// internal/store/store.go
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
)

// Digest is the hex-encoded SHA-256 hash of an object's content.
// It serves as the canonical identifier for any object in the store.
type Digest string

// ErrNotFound is returned when an object does not exist in the store.
var ErrNotFound = errors.New("object not found")

// ErrDigestMismatch is returned when the written content hash differs from
// the expected digest supplied by the caller.
var ErrDigestMismatch = errors.New("content digest mismatch")

// Store is the primary interface for content-addressable storage operations.
type Store interface {
	// Put writes data from r into the store. If the content already exists
	// the operation is a no-op. Returns the digest and byte size.
	Put(ctx context.Context, r io.Reader) (Digest, int64, error)

	// PutVerified writes data that the caller asserts has the given digest.
	// Returns ErrDigestMismatch if the actual hash differs.
	PutVerified(ctx context.Context, expected Digest, r io.Reader) (int64, error)

	// Get opens an object for reading. The caller must close the returned
	// ReadCloser. Returns ErrNotFound if the object does not exist.
	Get(ctx context.Context, d Digest) (io.ReadCloser, error)

	// Stat returns metadata for an object without reading its content.
	Stat(ctx context.Context, d Digest) (ObjectInfo, error)

	// Delete removes an object. Used only by the garbage collector.
	Delete(ctx context.Context, d Digest) error

	// Walk calls fn for every object in the store.
	Walk(ctx context.Context, fn func(ObjectInfo) error) error
}

// ObjectInfo holds metadata about a stored object.
type ObjectInfo struct {
	Digest    Digest
	Size      int64
	CreatedAt int64 // Unix nanoseconds
}

// FileStore is a filesystem-backed CAS implementation.
// Objects are stored under <root>/<prefix2>/<digest> where prefix2 is
// the first two hex characters of the digest — the same layout used by Git.
type FileStore struct {
	root    string
	mu      sync.RWMutex
	stats   storeStats
}

type storeStats struct {
	puts      atomic.Int64
	gets      atomic.Int64
	hitBytes  atomic.Int64
	missBytes atomic.Int64
}

// NewFileStore creates a FileStore rooted at the given directory.
func NewFileStore(root string) (*FileStore, error) {
	if err := os.MkdirAll(root, 0750); err != nil {
		return nil, fmt.Errorf("creating store root %s: %w", root, err)
	}
	return &FileStore{root: root}, nil
}

// objectPath returns the filesystem path for a given digest.
func (s *FileStore) objectPath(d Digest) string {
	ds := string(d)
	if len(ds) < 2 {
		return filepath.Join(s.root, "invalid", ds)
	}
	return filepath.Join(s.root, "objects", ds[:2], ds[2:])
}

// Put writes the content of r to the store, returning the digest.
// Writing is atomic: content goes to a temp file first, then is renamed
// into the final location. Concurrent duplicate writes are safe.
func (s *FileStore) Put(ctx context.Context, r io.Reader) (Digest, int64, error) {
	// Write to a temp file while computing the hash simultaneously.
	tmpDir := filepath.Join(s.root, "tmp")
	if err := os.MkdirAll(tmpDir, 0750); err != nil {
		return "", 0, fmt.Errorf("creating tmp dir: %w", err)
	}

	tmpFile, err := os.CreateTemp(tmpDir, "upload-*")
	if err != nil {
		return "", 0, fmt.Errorf("creating temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		tmpFile.Close()
		os.Remove(tmpPath) // clean up on any error path
	}()

	h := sha256.New()
	written, err := io.Copy(io.MultiWriter(tmpFile, h), r)
	if err != nil {
		return "", 0, fmt.Errorf("writing content: %w", err)
	}
	if err := tmpFile.Sync(); err != nil {
		return "", 0, fmt.Errorf("syncing temp file: %w", err)
	}
	tmpFile.Close()

	digest := Digest(hex.EncodeToString(h.Sum(nil)))
	finalPath := s.objectPath(digest)

	// If the object already exists, deduplication is complete.
	if _, err := os.Stat(finalPath); err == nil {
		s.stats.puts.Add(1)
		return digest, written, nil
	}

	// Ensure the sharding directory exists.
	if err := os.MkdirAll(filepath.Dir(finalPath), 0750); err != nil {
		return "", 0, fmt.Errorf("creating object dir: %w", err)
	}

	// Rename is atomic on the same filesystem. On success, the temp file
	// is gone; on failure, the deferred Remove cleans up.
	if err := os.Rename(tmpPath, finalPath); err != nil {
		// Another writer may have raced us and already placed the object.
		if _, statErr := os.Stat(finalPath); statErr == nil {
			return digest, written, nil
		}
		return "", 0, fmt.Errorf("installing object: %w", err)
	}

	// Protect the object from accidental modification.
	if err := os.Chmod(finalPath, 0440); err != nil {
		return "", 0, fmt.Errorf("chmod object: %w", err)
	}

	s.stats.puts.Add(1)
	return digest, written, nil
}

// PutVerified writes content and verifies the resulting digest matches expected.
func (s *FileStore) PutVerified(ctx context.Context, expected Digest, r io.Reader) (int64, error) {
	actual, n, err := s.Put(ctx, r)
	if err != nil {
		return 0, err
	}
	if actual != expected {
		// Remove the incorrectly labelled object.
		_ = s.Delete(ctx, actual)
		return 0, fmt.Errorf("%w: expected %s, got %s", ErrDigestMismatch, expected, actual)
	}
	return n, nil
}

// Get opens an object for reading.
func (s *FileStore) Get(ctx context.Context, d Digest) (io.ReadCloser, error) {
	path := s.objectPath(d)
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("opening object %s: %w", d, err)
	}
	s.stats.gets.Add(1)
	return f, nil
}

// Stat returns metadata for an object without reading its content.
func (s *FileStore) Stat(ctx context.Context, d Digest) (ObjectInfo, error) {
	path := s.objectPath(d)
	fi, err := os.Stat(path)
	if os.IsNotExist(err) {
		return ObjectInfo{}, ErrNotFound
	}
	if err != nil {
		return ObjectInfo{}, fmt.Errorf("stat object %s: %w", d, err)
	}
	return ObjectInfo{
		Digest:    d,
		Size:      fi.Size(),
		CreatedAt: fi.ModTime().UnixNano(),
	}, nil
}

// Delete removes an object from the store. Only the garbage collector
// should call this directly.
func (s *FileStore) Delete(ctx context.Context, d Digest) error {
	path := s.objectPath(d)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("deleting object %s: %w", d, err)
	}
	return nil
}

// Walk iterates over all objects in the store.
func (s *FileStore) Walk(ctx context.Context, fn func(ObjectInfo) error) error {
	objectsDir := filepath.Join(s.root, "objects")
	return filepath.WalkDir(objectsDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		// Reconstruct digest from path: .../objects/ab/cdef...
		rel, _ := filepath.Rel(objectsDir, path)
		parts := filepath.SplitList(filepath.ToSlash(rel))
		// filepath.SplitList uses OS path list separator; use Dir/Base instead:
		dir := filepath.Dir(rel)
		base := filepath.Base(rel)
		digest := Digest(filepath.Base(dir) + base)
		return fn(ObjectInfo{
			Digest:    digest,
			Size:      fi.Size(),
			CreatedAt: fi.ModTime().UnixNano(),
		})
	})
}

// VerifyObject rehashes an object and returns an error if the stored
// content does not match its digest. Useful for scrub jobs.
func VerifyObject(ctx context.Context, s Store, d Digest) error {
	rc, err := s.Get(ctx, d)
	if err != nil {
		return err
	}
	defer rc.Close()

	h := sha256.New()
	if _, err := io.Copy(h, rc); err != nil {
		return fmt.Errorf("reading object for verification: %w", err)
	}
	actual := Digest(hex.EncodeToString(h.Sum(nil)))
	if actual != d {
		return fmt.Errorf("object %s is corrupt: actual hash is %s", d, actual)
	}
	return nil
}

// computeDigest is a helper that returns the SHA-256 digest of data without storing it.
func computeDigest(r io.Reader) (Digest, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return Digest(hex.EncodeToString(h.Sum(nil))), nil
}
```

## Content-Defined Chunking

For large files, whole-file storage means even a single-byte change produces an entirely different object. Content-defined chunking (CDC) splits files at content-determined boundaries so that unchanged regions produce the same chunk digests across versions.

The Rabin fingerprint algorithm is the classic approach. This implementation uses a simpler but effective rolling hash suitable for most use cases.

```go
// internal/store/chunk.go
package store

import (
	"bufio"
	"context"
	"fmt"
	"io"
)

const (
	// ChunkMinSize is the minimum chunk size: 256 KiB.
	ChunkMinSize = 256 * 1024
	// ChunkMaxSize is the maximum chunk size: 4 MiB.
	ChunkMaxSize = 4 * 1024 * 1024
	// ChunkTargetSize is the target average chunk size: 1 MiB.
	ChunkTargetSize = 1024 * 1024

	// rollingWindow is the width of the rolling hash window.
	rollingWindow = 64
	// splitMask triggers a chunk boundary when rollingHash & splitMask == 0.
	// 0x1FFF = 8191 gives an average chunk size of ~8 KiB per bit.
	// For 1 MiB average: 1048576 / 64 = mask 0xFFFFF >> 4 = 0x3FFF...
	// Use 0x3FFF for ~16 KiB average (adjust upward for larger targets).
	splitMask = 0x3FFF
)

// Chunker splits a reader into variable-size chunks using a rolling hash.
type Chunker struct {
	r      *bufio.Reader
	window [rollingWindow]byte
	pos    int
	hash   uint32
	eof    bool
}

// NewChunker creates a Chunker that reads from r.
func NewChunker(r io.Reader) *Chunker {
	return &Chunker{r: bufio.NewReaderSize(r, ChunkMaxSize*2)}
}

// Next returns the next chunk as a byte slice.
// Returns io.EOF when no more data is available.
func (c *Chunker) Next() ([]byte, error) {
	if c.eof {
		return nil, io.EOF
	}

	buf := make([]byte, 0, ChunkTargetSize)

	for {
		b, err := c.r.ReadByte()
		if err == io.EOF {
			c.eof = true
			if len(buf) == 0 {
				return nil, io.EOF
			}
			return buf, nil
		}
		if err != nil {
			return nil, err
		}

		// Evict oldest byte from window, add new byte.
		oldest := c.window[c.pos%rollingWindow]
		c.window[c.pos%rollingWindow] = b
		c.pos++

		// Rolling hash: subtract outgoing, add incoming.
		c.hash = (c.hash - uint32(oldest)*0x08104225) * 1664525
		c.hash += uint32(b)

		buf = append(buf, b)

		n := len(buf)
		if n < ChunkMinSize {
			continue
		}
		if n >= ChunkMaxSize {
			return buf, nil
		}
		if c.hash&splitMask == 0 {
			return buf, nil
		}
	}
}

// ChunkEntry records a chunk's digest and size within a large object.
type ChunkEntry struct {
	Index  int    `json:"index"`
	Digest Digest `json:"digest"`
	Size   int64  `json:"size"`
	Offset int64  `json:"offset"`
}

// ChunkedPut splits a large object into chunks, stores each chunk individually,
// and returns an ordered list of ChunkEntry records that form the manifest.
func ChunkedPut(ctx context.Context, s Store, r io.Reader) ([]ChunkEntry, int64, error) {
	chunker := NewChunker(r)
	var entries []ChunkEntry
	var totalSize int64
	var offset int64
	idx := 0

	for {
		chunk, err := chunker.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, 0, fmt.Errorf("chunking input at offset %d: %w", offset, err)
		}

		digest, n, err := s.Put(ctx, bytesReader(chunk))
		if err != nil {
			return nil, 0, fmt.Errorf("storing chunk %d: %w", idx, err)
		}

		entries = append(entries, ChunkEntry{
			Index:  idx,
			Digest: digest,
			Size:   n,
			Offset: offset,
		})

		offset += n
		totalSize += n
		idx++
	}

	return entries, totalSize, nil
}

// bytesReader wraps a byte slice as an io.Reader for use with Store.Put.
type bytesReader []byte

func (b bytesReader) Read(p []byte) (int, error) {
	if len(b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b)
	b = b[n:]
	return n, nil
}
```

## Manifests for Multi-Chunk Objects

A manifest is itself a CAS object. It is a JSON document listing the chunks that together constitute a large logical object.

```go
// internal/store/manifest.go
package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// Manifest describes a logical object composed of one or more chunks.
type Manifest struct {
	Version   int          `json:"version"`
	MediaType string       `json:"mediaType"`
	Size      int64        `json:"size"`
	CreatedAt time.Time    `json:"createdAt"`
	Chunks    []ChunkEntry `json:"chunks"`
}

// PutLargeObject stores a large object using chunking and returns the manifest digest.
// The manifest digest is the canonical identifier for the logical object.
func PutLargeObject(ctx context.Context, s Store, mediaType string, r io.Reader) (Digest, *Manifest, error) {
	chunks, totalSize, err := ChunkedPut(ctx, s, r)
	if err != nil {
		return "", nil, fmt.Errorf("chunking object: %w", err)
	}

	manifest := &Manifest{
		Version:   1,
		MediaType: mediaType,
		Size:      totalSize,
		CreatedAt: time.Now().UTC(),
		Chunks:    chunks,
	}

	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", nil, fmt.Errorf("serialising manifest: %w", err)
	}

	manifestDigest, _, err := s.Put(ctx, bytes.NewReader(manifestJSON))
	if err != nil {
		return "", nil, fmt.Errorf("storing manifest: %w", err)
	}

	return manifestDigest, manifest, nil
}

// GetLargeObject retrieves the logical object described by a manifest,
// streaming chunk data in order.
func GetLargeObject(ctx context.Context, s Store, manifestDigest Digest) (io.Reader, *Manifest, error) {
	manifestRC, err := s.Get(ctx, manifestDigest)
	if err != nil {
		return nil, nil, fmt.Errorf("fetching manifest: %w", err)
	}
	defer manifestRC.Close()

	var manifest Manifest
	if err := json.NewDecoder(manifestRC).Decode(&manifest); err != nil {
		return nil, nil, fmt.Errorf("decoding manifest: %w", err)
	}

	// Build a multi-reader that streams chunks in order.
	readers := make([]io.Reader, 0, len(manifest.Chunks))
	closers := make([]io.Closer, 0, len(manifest.Chunks))

	for _, chunk := range manifest.Chunks {
		rc, err := s.Get(ctx, chunk.Digest)
		if err != nil {
			for _, c := range closers {
				c.Close()
			}
			return nil, nil, fmt.Errorf("fetching chunk %d (%s): %w", chunk.Index, chunk.Digest, err)
		}
		readers = append(readers, rc)
		closers = append(closers, rc)
	}

	combined := io.MultiReader(readers...)
	return combined, &manifest, nil
}
```

## Reference Counting and Garbage Collection

Without garbage collection, the store grows forever. The reference counter tracks which digests are currently referenced by live manifests or external pointers, and the GC deletes any unreferenced objects older than a grace period.

```go
// internal/store/gc.go
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// RefCounter maintains reference counts for objects in the store.
// All state is persisted to a JSON file on disk so it survives restarts.
type RefCounter struct {
	path  string
	mu    sync.Mutex
	refs  map[Digest]int64
	dirty bool
}

// NewRefCounter loads or creates a reference counter backed by a file.
func NewRefCounter(path string) (*RefCounter, error) {
	rc := &RefCounter{
		path: path,
		refs: make(map[Digest]int64),
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return rc, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading ref counter: %w", err)
	}
	if err := json.Unmarshal(data, &rc.refs); err != nil {
		return nil, fmt.Errorf("parsing ref counter: %w", err)
	}
	return rc, nil
}

// Increment adds delta references to digest d (use +1 to add, -1 to remove).
func (r *RefCounter) Increment(d Digest, delta int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refs[d] += delta
	if r.refs[d] <= 0 {
		delete(r.refs, d)
	}
	r.dirty = true
}

// Count returns the current reference count for digest d.
func (r *RefCounter) Count(d Digest) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.refs[d]
}

// Flush persists the reference map to disk.
func (r *RefCounter) Flush() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.dirty {
		return nil
	}
	data, err := json.MarshalIndent(r.refs, "", "  ")
	if err != nil {
		return err
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0640); err != nil {
		return err
	}
	if err := os.Rename(tmp, r.path); err != nil {
		return err
	}
	r.dirty = false
	return nil
}

// GCOptions controls garbage collection behaviour.
type GCOptions struct {
	// GracePeriod is the minimum age of an unreferenced object before deletion.
	// Prevents deleting objects that were just uploaded but not yet referenced.
	GracePeriod time.Duration
	// DryRun logs what would be deleted without actually deleting.
	DryRun bool
}

// GCResult summarises what the garbage collector did.
type GCResult struct {
	Examined int64
	Deleted  int64
	Bytes    int64
	Errors   []error
}

// RunGC walks the store and deletes unreferenced objects older than the grace period.
func RunGC(ctx context.Context, s Store, rc *RefCounter, opts GCOptions) (GCResult, error) {
	if opts.GracePeriod == 0 {
		opts.GracePeriod = 24 * time.Hour
	}

	var result GCResult
	cutoff := time.Now().Add(-opts.GracePeriod).UnixNano()

	err := s.Walk(ctx, func(info ObjectInfo) error {
		result.Examined++

		if rc.Count(info.Digest) > 0 {
			return nil // referenced, keep
		}
		if info.CreatedAt > cutoff {
			return nil // too new, keep
		}

		if opts.DryRun {
			slog.Info("gc: would delete",
				"digest", info.Digest,
				"size", info.Size,
				"age", time.Since(time.Unix(0, info.CreatedAt)).Round(time.Minute))
			result.Deleted++
			result.Bytes += info.Size
			return nil
		}

		if err := s.Delete(ctx, info.Digest); err != nil {
			result.Errors = append(result.Errors, fmt.Errorf("deleting %s: %w", info.Digest, err))
			return nil // continue walking despite error
		}

		slog.Info("gc: deleted",
			"digest", info.Digest,
			"size", info.Size)
		result.Deleted++
		result.Bytes += info.Size
		return nil
	})

	return result, err
}
```

## HTTP API Layer

```go
// internal/api/handler.go
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/example/cas/internal/store"
)

// Handler exposes the CAS store over HTTP using a RESTful API.
type Handler struct {
	store store.Store
	refs  *store.RefCounter
}

// NewHandler returns a new Handler.
func NewHandler(s store.Store, rc *store.RefCounter) *Handler {
	return &Handler{store: s, refs: rc}
}

// Routes registers all API routes on mux.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /v1/objects", h.handlePut)
	mux.HandleFunc("GET /v1/objects/{digest}", h.handleGet)
	mux.HandleFunc("HEAD /v1/objects/{digest}", h.handleHead)
	mux.HandleFunc("GET /v1/objects/{digest}/verify", h.handleVerify)
	mux.HandleFunc("POST /v1/large-objects", h.handlePutLargeObject)
	mux.HandleFunc("GET /v1/large-objects/{digest}", h.handleGetLargeObject)
}

// handlePut stores a new object.
// Content-Digest header (if present) triggers verified upload.
func (h *Handler) handlePut(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	expectedDigest := store.Digest(r.Header.Get("Content-Digest"))

	var (
		digest store.Digest
		n      int64
		err    error
	)

	if expectedDigest != "" {
		n, err = h.store.PutVerified(ctx, expectedDigest, r.Body)
		digest = expectedDigest
	} else {
		digest, n, err = h.store.Put(ctx, r.Body)
	}

	if errors.Is(err, store.ErrDigestMismatch) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err != nil {
		slog.Error("put object", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Increment reference count for this object.
	h.refs.Increment(digest, 1)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Location", "/v1/objects/"+string(digest))
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"digest": digest,
		"size":   n,
	})
}

// handleGet retrieves an object by digest.
func (h *Handler) handleGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	digest := store.Digest(r.PathValue("digest"))

	info, err := h.store.Stat(ctx, digest)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	rc, err := h.store.Get(ctx, digest)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	w.Header().Set("Content-Digest", "sha-256=:"+string(digest)+":")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	io.Copy(w, rc)
}

// handleHead returns metadata for an object without its content.
func (h *Handler) handleHead(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	digest := store.Digest(r.PathValue("digest"))

	info, err := h.store.Stat(ctx, digest)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	w.Header().Set("Content-Digest", "sha-256=:"+string(digest)+":")
	w.WriteHeader(http.StatusOK)
}

// handleVerify rehashes the object and returns its integrity status.
func (h *Handler) handleVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	digest := store.Digest(r.PathValue("digest"))

	if err := store.VerifyObject(ctx, h.store, digest); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusUnprocessableEntity)
		json.NewEncoder(w).Encode(map[string]any{
			"digest": digest,
			"valid":  false,
			"error":  err.Error(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"digest": digest,
		"valid":  true,
	})
}

// handlePutLargeObject stores a large object as chunks and returns the manifest digest.
func (h *Handler) handlePutLargeObject(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	mediaType := r.Header.Get("Content-Type")
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}

	manifestDigest, manifest, err := store.PutLargeObject(ctx, h.store, mediaType, r.Body)
	if err != nil {
		slog.Error("put large object", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Reference all chunks.
	for _, chunk := range manifest.Chunks {
		h.refs.Increment(chunk.Digest, 1)
	}
	// Reference the manifest itself.
	h.refs.Increment(manifestDigest, 1)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Location", "/v1/large-objects/"+string(manifestDigest))
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"manifestDigest": manifestDigest,
		"size":           manifest.Size,
		"chunks":         len(manifest.Chunks),
	})
}

// handleGetLargeObject reassembles a large object from its manifest.
func (h *Handler) handleGetLargeObject(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	manifestDigest := store.Digest(r.PathValue("digest"))

	reader, manifest, err := store.GetLargeObject(ctx, h.store, manifestDigest)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", manifest.MediaType)
	w.Header().Set("Content-Length", strconv.FormatInt(manifest.Size, 10))
	w.Header().Set("Content-Digest", "sha-256=:"+string(manifestDigest)+":")
	w.WriteHeader(http.StatusOK)
	io.Copy(w, reader)
}
```

## Testing the Store

```go
// internal/store/store_test.go
package store_test

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/example/cas/internal/store"
)

func TestPutAndGet(t *testing.T) {
	dir := t.TempDir()
	s, err := store.NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	content := "hello, content-addressable world"

	digest, n, err := s.Put(ctx, strings.NewReader(content))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if n != int64(len(content)) {
		t.Errorf("Put: wrote %d bytes, expected %d", n, len(content))
	}

	// Second put of identical content should be idempotent.
	digest2, _, err := s.Put(ctx, strings.NewReader(content))
	if err != nil {
		t.Fatalf("Put (duplicate): %v", err)
	}
	if digest != digest2 {
		t.Errorf("duplicate put returned different digest: %s vs %s", digest, digest2)
	}

	rc, err := s.Get(ctx, digest)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer rc.Close()

	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got) != content {
		t.Errorf("content mismatch: got %q, want %q", got, content)
	}
}

func TestVerifiedPutMismatch(t *testing.T) {
	dir := t.TempDir()
	s, _ := store.NewFileStore(dir)

	ctx := context.Background()
	// Claim the content has a certain digest, but provide different content.
	wrongDigest := store.Digest("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	_, err := s.PutVerified(ctx, wrongDigest, strings.NewReader("actual content"))
	if err == nil {
		t.Error("expected ErrDigestMismatch, got nil")
	}
}

func TestChunkingIsReproducible(t *testing.T) {
	data := make([]byte, 5*1024*1024) // 5 MiB
	for i := range data {
		data[i] = byte(i * 31 % 256)
	}

	chunker1 := store.NewChunker(bytes.NewReader(data))
	chunker2 := store.NewChunker(bytes.NewReader(data))

	var digests1, digests2 []string
	for {
		chunk, err := chunker1.Next()
		if err != nil {
			break
		}
		d, _ := computeDigestFromBytes(chunk)
		digests1 = append(digests1, d)
	}
	for {
		chunk, err := chunker2.Next()
		if err != nil {
			break
		}
		d, _ := computeDigestFromBytes(chunk)
		digests2 = append(digests2, d)
	}

	if len(digests1) != len(digests2) {
		t.Fatalf("chunk count mismatch: %d vs %d", len(digests1), len(digests2))
	}
	for i := range digests1 {
		if digests1[i] != digests2[i] {
			t.Errorf("chunk %d digest mismatch", i)
		}
	}
}
```

## Production Deployment Notes

### Sharding Across Multiple Nodes

For large installations, objects can be sharded across multiple FileStore instances by routing on the first N bits of the digest:

```go
type ShardedStore struct {
	shards []*FileStore
}

func (s *ShardedStore) shardFor(d Digest) *FileStore {
	// Use first byte of digest as shard index.
	var v int
	fmt.Sscanf(string(d)[:2], "%x", &v)
	return s.shards[v%len(s.shards)]
}
```

### Periodic Integrity Scrubs

Schedule a nightly job that walks the store and verifies every object:

```bash
#!/usr/bin/env bash
# scrub.sh — verify all objects and log corruption

curl -s http://cas-server/v1/admin/scrub \
  -X POST \
  -H "Authorization: Bearer <admin-token>" \
  | jq '.corruptObjects'
```

### Prometheus Metrics

```go
var (
	putTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "cas_puts_total",
		Help: "Total number of Put operations.",
	})
	getTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "cas_gets_total",
		Help: "Total number of Get operations.",
	})
	storageBytes = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "cas_storage_bytes",
		Help: "Total bytes stored.",
	})
	deduplicationRatio = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "cas_deduplication_ratio",
		Help: "Ratio of logical size to physical size (>1 means deduplication savings).",
	})
)
```

## Summary

The core insight of content-addressable storage is that identity and content are one and the same. This guide has shown:

- **FileStore**: atomic writes via temp-file-then-rename, sharded directory layout for filesystem performance
- **Content-defined chunking**: variable-size chunks using a rolling hash, enabling sub-file deduplication
- **Manifests**: CAS objects that describe multi-chunk logical objects, themselves identified by hash
- **Reference counting + GC**: safe deletion of unreferenced objects with a configurable grace period
- **HTTP API**: RESTful interface with Content-Digest headers following draft-ietf-httpbis-digest-headers

The design is intentionally layered: each component is independently testable and replaceable. Swap the FileStore for an S3-backed store, or add a tiered cache in front of it, without changing the Store interface contract.
