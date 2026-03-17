---
title: "Go embed Package Deep Dive: Static Assets, Template Embedding, Database Migrations, and Testing with Embedded FS"
date: 2032-01-15T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "embed", "Static Assets", "Database Migrations", "Testing"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go's embed package covering static asset serving, HTML template embedding, automated database migration management, and writing effective tests using embedded file systems in production Go applications."
more_link: "yes"
url: "/go-embed-package-static-assets-templates-migrations-testing/"
---

The `embed` package, introduced in Go 1.16, solves a long-standing pain point in Go deployments: bundling external files into the binary. Before `embed`, applications required runtime file system access, complicating deployments, Docker images, and reproducibility. This guide explores every production-relevant use case from basic asset embedding to sophisticated migration runners.

<!--more-->

# Go embed Package: Production Guide

## Section 1: Understanding embed Fundamentals

The `embed` package works through compile-time directives. The Go compiler reads `//go:embed` comments and injects the specified files directly into the binary as read-only data.

### Core Types

```go
package main

import (
    "embed"
    "io/fs"
    "strings"
)

// Single file as []byte
//go:embed static/logo.png
var logoBytes []byte

// Single file as string
//go:embed config/default.yaml
var defaultConfig string

// Directory tree as FS
//go:embed static
var staticFiles embed.FS

// Multiple patterns
//go:embed templates/*.html templates/**/*.html
var templates embed.FS

// Multiple directives accumulate
//go:embed migrations/postgres
//go:embed migrations/sqlite
var migrations embed.FS
```

The `embed.FS` type implements `fs.FS`, `fs.ReadFileFS`, and `fs.ReadDirFS`. This means any function that accepts `fs.FS` works with embedded file systems.

### embed.FS vs os.DirFS Comparison

```go
package main

import (
    "embed"
    "io/fs"
    "os"
    "testing"
)

//go:embed testdata
var testFS embed.FS

func BenchmarkEmbedRead(b *testing.B) {
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        data, err := testFS.ReadFile("testdata/sample.json")
        if err != nil {
            b.Fatal(err)
        }
        _ = data
    }
}

func BenchmarkOSDirRead(b *testing.B) {
    dirFS := os.DirFS(".")
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        data, err := fs.ReadFile(dirFS, "testdata/sample.json")
        if err != nil {
            b.Fatal(err)
        }
        _ = data
    }
}
```

Results on a typical Linux system show embed.FS reads are 3-5x faster for small files because there is no syscall overhead - the data is in memory.

### Glob Pattern Rules

```go
// Valid patterns
//go:embed *.json                    // all JSON in current dir
//go:embed config/**                 // recursive config directory
//go:embed "path with spaces/file"   // quoted paths for spaces
//go:embed web/dist                  // entire directory tree

// Invalid patterns (compile error)
// //go:embed ../parent              // no parent traversal
// //go:embed /absolute/path         // no absolute paths
// //go:embed *.{json,yaml}          // no brace expansion (Go uses its own glob)

// Hidden files require explicit inclusion
//go:embed all:config                // "all:" prefix includes hidden files/dirs
```

The `all:` prefix is critical for configuration directories that contain dotfiles:

```go
// Without all: prefix, .env, .gitignore etc are excluded
//go:embed all:config
var configFS embed.FS
```

## Section 2: Static Asset Serving

### HTTP File Server with embed.FS

```go
package main

import (
    "embed"
    "io/fs"
    "log"
    "net/http"
    "time"
)

//go:embed web/dist
var webDist embed.FS

func NewStaticHandler() http.Handler {
    // Strip the "web/dist" prefix so "/" maps to the dist root
    distFS, err := fs.Sub(webDist, "web/dist")
    if err != nil {
        log.Fatalf("failed to create sub FS: %v", err)
    }

    fileServer := http.FileServer(http.FS(distFS))

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Add cache headers for static assets
        if isStaticAsset(r.URL.Path) {
            w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        } else {
            w.Header().Set("Cache-Control", "no-cache, must-revalidate")
        }

        // Security headers
        w.Header().Set("X-Content-Type-Options", "nosniff")
        w.Header().Set("X-Frame-Options", "DENY")

        fileServer.ServeHTTP(w, r)
    })
}

func isStaticAsset(path string) bool {
    staticExtensions := []string{
        ".js", ".css", ".woff2", ".woff", ".ttf",
        ".png", ".jpg", ".svg", ".ico",
    }
    for _, ext := range staticExtensions {
        if strings.HasSuffix(path, ext) {
            return true
        }
    }
    return false
}

func main() {
    mux := http.NewServeMux()
    mux.Handle("/", NewStaticHandler())
    mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(`{"status":"ok"}`))
    })

    server := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    log.Println("Starting server on :8080")
    log.Fatal(server.ListenAndServe())
}
```

### SPA (Single Page Application) Handler

For React/Vue/Angular applications, all unmatched routes must serve `index.html`:

```go
package static

import (
    "embed"
    "io"
    "io/fs"
    "net/http"
    "path"
    "strings"
)

//go:embed dist
var distFS embed.FS

type SPAHandler struct {
    staticFS fs.FS
    index    []byte
}

func NewSPAHandler() (*SPAHandler, error) {
    sub, err := fs.Sub(distFS, "dist")
    if err != nil {
        return nil, err
    }

    index, err := fs.ReadFile(sub, "index.html")
    if err != nil {
        return nil, err
    }

    return &SPAHandler{
        staticFS: sub,
        index:    index,
    }, nil
}

func (h *SPAHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Normalize path
    urlPath := path.Clean(r.URL.Path)
    if urlPath == "" {
        urlPath = "/"
    }

    // Try to open the exact file
    f, err := h.staticFS.Open(strings.TrimPrefix(urlPath, "/"))
    if err == nil {
        defer f.Close()

        // Verify it's a regular file, not a directory
        stat, err := f.Stat()
        if err == nil && !stat.IsDir() {
            http.ServeContent(w, r, stat.Name(), stat.ModTime(), f.(io.ReadSeeker))
            return
        }
    }

    // Fallback: serve index.html for SPA routing
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    w.Header().Set("Cache-Control", "no-cache, must-revalidate")
    w.Write(h.index)
}
```

### Versioned Asset Manifest

Bundle manifests generated by build tools map logical names to content-hashed filenames:

```go
package assets

import (
    "embed"
    "encoding/json"
    "fmt"
    "sync"
)

//go:embed dist/manifest.json
var manifestJSON []byte

//go:embed dist
var distFS embed.FS

type AssetManifest struct {
    mu      sync.RWMutex
    entries map[string]string
}

func NewAssetManifest() (*AssetManifest, error) {
    var entries map[string]string
    if err := json.Unmarshal(manifestJSON, &entries); err != nil {
        return nil, fmt.Errorf("parsing asset manifest: %w", err)
    }
    return &AssetManifest{entries: entries}, nil
}

// Asset returns the content-hashed path for a logical asset name
func (m *AssetManifest) Asset(name string) (string, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()
    hashed, ok := m.entries[name]
    if !ok {
        return "", fmt.Errorf("asset %q not found in manifest", name)
    }
    return "/static/" + hashed, nil
}

// AssetOrDefault returns the asset path or a fallback
func (m *AssetManifest) AssetOrDefault(name, fallback string) string {
    path, err := m.Asset(name)
    if err != nil {
        return fallback
    }
    return path
}
```

## Section 3: Template Embedding

### HTML Template System

```go
package templates

import (
    "embed"
    "fmt"
    "html/template"
    "io"
    "io/fs"
    "sync"
)

//go:embed html
var htmlFiles embed.FS

type TemplateRenderer struct {
    mu        sync.RWMutex
    templates map[string]*template.Template
    funcs     template.FuncMap
}

func NewTemplateRenderer() (*TemplateRenderer, error) {
    r := &TemplateRenderer{
        templates: make(map[string]*template.Template),
        funcs: template.FuncMap{
            "safeHTML": func(s string) template.HTML { return template.HTML(s) },
            "safeURL":  func(s string) template.URL { return template.URL(s) },
            "dict": func(values ...interface{}) (map[string]interface{}, error) {
                if len(values)%2 != 0 {
                    return nil, fmt.Errorf("dict requires even number of args")
                }
                dict := make(map[string]interface{})
                for i := 0; i < len(values); i += 2 {
                    key, ok := values[i].(string)
                    if !ok {
                        return nil, fmt.Errorf("dict keys must be strings")
                    }
                    dict[key] = values[i+1]
                }
                return dict, nil
            },
        },
    }

    if err := r.loadTemplates(); err != nil {
        return nil, err
    }
    return r, nil
}

func (r *TemplateRenderer) loadTemplates() error {
    // Find all page templates
    entries, err := fs.ReadDir(htmlFiles, "html/pages")
    if err != nil {
        return fmt.Errorf("reading pages directory: %w", err)
    }

    for _, entry := range entries {
        if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".html") {
            continue
        }

        name := strings.TrimSuffix(entry.Name(), ".html")
        tmpl, err := r.buildTemplate(name)
        if err != nil {
            return fmt.Errorf("building template %q: %w", name, err)
        }
        r.templates[name] = tmpl
    }
    return nil
}

func (r *TemplateRenderer) buildTemplate(page string) (*template.Template, error) {
    // Parse base layout + partials + page template
    patterns := []string{
        "html/layouts/base.html",
        "html/layouts/nav.html",
        "html/partials/*.html",
        "html/pages/" + page + ".html",
    }

    tmpl := template.New("base").Funcs(r.funcs)
    for _, pattern := range patterns {
        // Glob returns files matching pattern within the embedded FS
        matches, err := fs.Glob(htmlFiles, pattern)
        if err != nil {
            return nil, err
        }
        if len(matches) == 0 {
            continue
        }

        tmpl, err = tmpl.ParseFS(htmlFiles, matches...)
        if err != nil {
            return nil, fmt.Errorf("parsing pattern %q: %w", pattern, err)
        }
    }
    return tmpl, nil
}

// Render executes a named template to w
func (r *TemplateRenderer) Render(w io.Writer, name string, data interface{}) error {
    r.mu.RLock()
    tmpl, ok := r.templates[name]
    r.mu.RUnlock()

    if !ok {
        return fmt.Errorf("template %q not found", name)
    }

    return tmpl.ExecuteTemplate(w, "base", data)
}
```

### Text Templates for Code Generation

```go
package codegen

import (
    "bytes"
    "embed"
    "text/template"
)

//go:embed tmpl
var templateFS embed.FS

type CodeGenerator struct {
    templates *template.Template
}

func NewCodeGenerator() (*CodeGenerator, error) {
    tmpl := template.New("").Funcs(template.FuncMap{
        "lower":      strings.ToLower,
        "upper":      strings.ToUpper,
        "camelCase":  toCamelCase,
        "snakeCase":  toSnakeCase,
        "pluralize":  pluralize,
    })

    tmpl, err := tmpl.ParseFS(templateFS, "tmpl/*.tmpl")
    if err != nil {
        return nil, fmt.Errorf("parsing templates: %w", err)
    }

    return &CodeGenerator{templates: tmpl}, nil
}

type ModelSpec struct {
    Package   string
    Name      string
    TableName string
    Fields    []FieldSpec
}

type FieldSpec struct {
    Name     string
    Type     string
    Column   string
    Nullable bool
    Index    bool
}

func (g *CodeGenerator) GenerateModel(spec ModelSpec) ([]byte, error) {
    var buf bytes.Buffer
    if err := g.templates.ExecuteTemplate(&buf, "model.tmpl", spec); err != nil {
        return nil, fmt.Errorf("generating model: %w", err)
    }
    return buf.Bytes(), nil
}

func (g *CodeGenerator) GenerateRepository(spec ModelSpec) ([]byte, error) {
    var buf bytes.Buffer
    if err := g.templates.ExecuteTemplate(&buf, "repository.tmpl", spec); err != nil {
        return nil, fmt.Errorf("generating repository: %w", err)
    }
    return buf.Bytes(), nil
}
```

Template file `tmpl/model.tmpl`:

```
{{- define "model.tmpl" -}}
// Code generated by codegen. DO NOT EDIT.
package {{ .Package }}

import (
    "database/sql"
    "time"
)

// {{ .Name }} represents the {{ .TableName }} database table.
type {{ .Name }} struct {
{{- range .Fields }}
    {{ .Name | camelCase }} {{ if .Nullable }}*{{ end }}{{ .Type }} `db:"{{ .Column }}" json:"{{ .Column }}"`
{{- end }}
    CreatedAt time.Time `db:"created_at" json:"created_at"`
    UpdatedAt time.Time `db:"updated_at" json:"updated_at"`
}

// TableName returns the database table name.
func (m *{{ .Name }}) TableName() string {
    return "{{ .TableName }}"
}
{{ end }}
```

## Section 4: Database Migrations with embed

Managing database schema migrations as embedded files solves the deployment synchronization problem - the binary always contains exactly the migrations it was built with.

### Migration Runner Implementation

```go
package migrations

import (
    "context"
    "crypto/sha256"
    "database/sql"
    "embed"
    "fmt"
    "io/fs"
    "path/filepath"
    "sort"
    "strings"
    "time"
)

//go:embed sql
var migrationsFS embed.FS

// MigrationRecord tracks applied migrations in the database
type MigrationRecord struct {
    Version     int64
    Name        string
    Checksum    string
    AppliedAt   time.Time
    ExecutionMs int64
}

// Migrator manages database schema evolution
type Migrator struct {
    db        *sql.DB
    dialect   string
    tableName string
    fs        fs.FS
}

type MigratorOption func(*Migrator)

func WithTableName(name string) MigratorOption {
    return func(m *Migrator) { m.tableName = name }
}

func WithFS(filesystem fs.FS) MigratorOption {
    return func(m *Migrator) { m.fs = filesystem }
}

func NewMigrator(db *sql.DB, dialect string, opts ...MigratorOption) (*Migrator, error) {
    sub, err := fs.Sub(migrationsFS, "sql/"+dialect)
    if err != nil {
        return nil, fmt.Errorf("opening migrations for dialect %q: %w", dialect, err)
    }

    m := &Migrator{
        db:        db,
        dialect:   dialect,
        tableName: "schema_migrations",
        fs:        sub,
    }
    for _, opt := range opts {
        opt(m)
    }
    return m, nil
}

// Migrate runs all pending migrations in version order
func (m *Migrator) Migrate(ctx context.Context) error {
    if err := m.ensureMigrationTable(ctx); err != nil {
        return fmt.Errorf("ensuring migration table: %w", err)
    }

    available, err := m.loadAvailableMigrations()
    if err != nil {
        return fmt.Errorf("loading available migrations: %w", err)
    }

    applied, err := m.loadAppliedMigrations(ctx)
    if err != nil {
        return fmt.Errorf("loading applied migrations: %w", err)
    }

    // Verify applied migrations match (detect tampering)
    for _, record := range applied {
        avail, ok := available[record.Version]
        if !ok {
            return fmt.Errorf("applied migration %d not found in filesystem", record.Version)
        }
        if avail.Checksum != record.Checksum {
            return fmt.Errorf(
                "checksum mismatch for migration %d: expected %s, got %s",
                record.Version, avail.Checksum, record.Checksum,
            )
        }
    }

    // Run pending migrations
    for _, mig := range sortedMigrations(available) {
        if _, done := applied[mig.Version]; done {
            continue
        }

        if err := m.runMigration(ctx, mig); err != nil {
            return fmt.Errorf("running migration %d (%s): %w", mig.Version, mig.Name, err)
        }
    }

    return nil
}

type migration struct {
    Version  int64
    Name     string
    SQL      string
    Checksum string
}

func (m *Migrator) loadAvailableMigrations() (map[int64]*migration, error) {
    entries, err := fs.ReadDir(m.fs, ".")
    if err != nil {
        return nil, err
    }

    migrations := make(map[int64]*migration)
    for _, entry := range entries {
        if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
            continue
        }

        mig, err := m.parseMigrationFile(entry.Name())
        if err != nil {
            return nil, fmt.Errorf("parsing %s: %w", entry.Name(), err)
        }
        migrations[mig.Version] = mig
    }
    return migrations, nil
}

func (m *Migrator) parseMigrationFile(filename string) (*migration, error) {
    // Expected format: 000001_create_users.sql
    base := strings.TrimSuffix(filename, ".sql")
    parts := strings.SplitN(base, "_", 2)
    if len(parts) != 2 {
        return nil, fmt.Errorf("invalid filename format: %s", filename)
    }

    var version int64
    if _, err := fmt.Sscanf(parts[0], "%d", &version); err != nil {
        return nil, fmt.Errorf("parsing version from %s: %w", parts[0], err)
    }

    content, err := fs.ReadFile(m.fs, filename)
    if err != nil {
        return nil, err
    }

    sum := sha256.Sum256(content)
    return &migration{
        Version:  version,
        Name:     parts[1],
        SQL:      string(content),
        Checksum: fmt.Sprintf("%x", sum),
    }, nil
}

func (m *Migrator) runMigration(ctx context.Context, mig *migration) error {
    start := time.Now()

    tx, err := m.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback()

    if _, err := tx.ExecContext(ctx, mig.SQL); err != nil {
        return fmt.Errorf("executing SQL: %w", err)
    }

    elapsed := time.Since(start).Milliseconds()

    _, err = tx.ExecContext(ctx,
        `INSERT INTO `+m.tableName+`
         (version, name, checksum, applied_at, execution_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        mig.Version, mig.Name, mig.Checksum, time.Now(), elapsed,
    )
    if err != nil {
        return fmt.Errorf("recording migration: %w", err)
    }

    return tx.Commit()
}

func (m *Migrator) ensureMigrationTable(ctx context.Context) error {
    _, err := m.db.ExecContext(ctx, `
        CREATE TABLE IF NOT EXISTS `+m.tableName+` (
            version       BIGINT      PRIMARY KEY,
            name          TEXT        NOT NULL,
            checksum      TEXT        NOT NULL,
            applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            execution_ms  BIGINT      NOT NULL DEFAULT 0
        )
    `)
    return err
}

func (m *Migrator) loadAppliedMigrations(ctx context.Context) (map[int64]*MigrationRecord, error) {
    rows, err := m.db.QueryContext(ctx,
        `SELECT version, name, checksum, applied_at, execution_ms FROM `+m.tableName+` ORDER BY version`,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    records := make(map[int64]*MigrationRecord)
    for rows.Next() {
        var r MigrationRecord
        if err := rows.Scan(&r.Version, &r.Name, &r.Checksum, &r.AppliedAt, &r.ExecutionMs); err != nil {
            return nil, err
        }
        records[r.Version] = &r
    }
    return records, rows.Err()
}

func sortedMigrations(m map[int64]*migration) []*migration {
    result := make([]*migration, 0, len(m))
    for _, v := range m {
        result = append(result, v)
    }
    sort.Slice(result, func(i, j int) bool {
        return result[i].Version < result[j].Version
    })
    return result
}
```

### Migration File Structure

```
migrations/
└── sql/
    ├── postgres/
    │   ├── 000001_create_users.sql
    │   ├── 000002_create_sessions.sql
    │   ├── 000003_add_user_roles.sql
    │   └── 000004_create_audit_log.sql
    └── sqlite/
        ├── 000001_create_users.sql
        ├── 000002_create_sessions.sql
        └── 000003_add_user_roles.sql
```

Sample migration `000001_create_users.sql`:

```sql
-- Migration: create_users
-- Description: Initial user table creation

CREATE TABLE users (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email        TEXT        NOT NULL UNIQUE,
    display_name TEXT        NOT NULL,
    password_hash TEXT       NOT NULL,
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_is_active ON users (is_active) WHERE is_active = TRUE;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

## Section 5: Testing with Embedded FS

One of the most powerful applications of `embed` is deterministic testing. Tests no longer depend on file system state at test time.

### Testing File-Based Operations

```go
package storage_test

import (
    "embed"
    "io/fs"
    "testing"
    "testing/fstest"

    "github.com/example/app/storage"
)

// Embed real fixtures for integration tests
//go:embed testdata
var testdataFS embed.FS

func TestFileParser(t *testing.T) {
    t.Run("valid JSON file", func(t *testing.T) {
        data, err := testdataFS.ReadFile("testdata/valid.json")
        if err != nil {
            t.Fatalf("reading testdata: %v", err)
        }

        result, err := storage.ParseJSON(data)
        if err != nil {
            t.Fatalf("parsing JSON: %v", err)
        }

        if result.Count != 42 {
            t.Errorf("expected Count=42, got %d", result.Count)
        }
    })

    t.Run("malformed JSON file", func(t *testing.T) {
        data, err := testdataFS.ReadFile("testdata/malformed.json")
        if err != nil {
            t.Fatalf("reading testdata: %v", err)
        }

        _, err = storage.ParseJSON(data)
        if err == nil {
            t.Error("expected error for malformed JSON, got nil")
        }
    })
}
```

### Using fstest.MapFS for Unit Tests

`fstest.MapFS` lets you create in-memory file systems without touching disk:

```go
package migrations_test

import (
    "context"
    "database/sql"
    "testing"
    "testing/fstest"
    "time"

    _ "github.com/mattn/go-sqlite3"
    "github.com/example/app/migrations"
)

func TestMigrator_Migrate(t *testing.T) {
    // Create a fake migration FS in memory
    fakeMigrations := fstest.MapFS{
        "000001_create_users.sql": &fstest.MapFile{
            Data: []byte(`
                CREATE TABLE users (
                    id   INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL
                );
            `),
            ModTime: time.Now(),
        },
        "000002_add_email.sql": &fstest.MapFile{
            Data: []byte(`
                ALTER TABLE users ADD COLUMN email TEXT;
            `),
            ModTime: time.Now(),
        },
    }

    // Open in-memory SQLite for testing
    db, err := sql.Open("sqlite3", ":memory:")
    if err != nil {
        t.Fatalf("opening test DB: %v", err)
    }
    defer db.Close()

    migrator, err := migrations.NewMigrator(db, "sqlite",
        migrations.WithFS(fakeMigrations),
    )
    if err != nil {
        t.Fatalf("creating migrator: %v", err)
    }

    ctx := context.Background()

    // First migration run
    if err := migrator.Migrate(ctx); err != nil {
        t.Fatalf("first migration: %v", err)
    }

    // Verify tables exist
    var tableCount int
    err = db.QueryRowContext(ctx,
        `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'`,
    ).Scan(&tableCount)
    if err != nil {
        t.Fatalf("checking tables: %v", err)
    }
    if tableCount != 1 {
        t.Errorf("expected users table, got count=%d", tableCount)
    }

    // Second migration run should be idempotent
    if err := migrator.Migrate(ctx); err != nil {
        t.Fatalf("second migration (idempotency check): %v", err)
    }
}

func TestMigrator_ChecksumValidation(t *testing.T) {
    db, err := sql.Open("sqlite3", ":memory:")
    if err != nil {
        t.Fatalf("opening test DB: %v", err)
    }
    defer db.Close()

    original := []byte("CREATE TABLE t1 (id INTEGER PRIMARY KEY);")
    tampered := []byte("CREATE TABLE t1_tampered (id INTEGER PRIMARY KEY);")

    fs1 := fstest.MapFS{
        "000001_create_t1.sql": &fstest.MapFile{Data: original},
    }
    fs2 := fstest.MapFS{
        "000001_create_t1.sql": &fstest.MapFile{Data: tampered},
    }

    ctx := context.Background()

    // Apply original
    m1, _ := migrations.NewMigrator(db, "sqlite", migrations.WithFS(fs1))
    if err := m1.Migrate(ctx); err != nil {
        t.Fatalf("initial migration: %v", err)
    }

    // Attempt to run with tampered SQL - should fail
    m2, _ := migrations.NewMigrator(db, "sqlite", migrations.WithFS(fs2))
    err = m2.Migrate(ctx)
    if err == nil {
        t.Error("expected checksum error, got nil")
    }
    if !strings.Contains(err.Error(), "checksum mismatch") {
        t.Errorf("expected checksum error, got: %v", err)
    }
}
```

### Template Testing with fstest.MapFS

```go
package templates_test

import (
    "bytes"
    "strings"
    "testing"
    "testing/fstest"

    "github.com/example/app/templates"
)

func TestTemplateRenderer(t *testing.T) {
    fakeFS := fstest.MapFS{
        "html/layouts/base.html": &fstest.MapFile{
            Data: []byte(`{{define "base"}}<!DOCTYPE html><html><body>{{template "content" .}}</body></html>{{end}}`),
        },
        "html/pages/index.html": &fstest.MapFile{
            Data: []byte(`{{define "content"}}<h1>{{.Title}}</h1><p>{{.Body}}</p>{{end}}`),
        },
        "html/pages/error.html": &fstest.MapFile{
            Data: []byte(`{{define "content"}}<h1>Error: {{.Code}}</h1>{{end}}`),
        },
    }

    renderer, err := templates.NewRendererFromFS(fakeFS)
    if err != nil {
        t.Fatalf("creating renderer: %v", err)
    }

    t.Run("index template", func(t *testing.T) {
        var buf bytes.Buffer
        err := renderer.Render(&buf, "index", map[string]interface{}{
            "Title": "Hello World",
            "Body":  "Test content",
        })
        if err != nil {
            t.Fatalf("rendering index: %v", err)
        }

        output := buf.String()
        if !strings.Contains(output, "Hello World") {
            t.Errorf("output missing title: %s", output)
        }
        if !strings.Contains(output, "Test content") {
            t.Errorf("output missing body: %s", output)
        }
    })

    t.Run("nonexistent template", func(t *testing.T) {
        var buf bytes.Buffer
        err := renderer.Render(&buf, "nonexistent", nil)
        if err == nil {
            t.Error("expected error for nonexistent template")
        }
    })
}
```

### Benchmark Comparing embed.FS vs os.DirFS

```go
package benchmark_test

import (
    "embed"
    "io/fs"
    "os"
    "testing"
)

//go:embed fixtures
var fixtureFS embed.FS

func BenchmarkEmbedFSSmallFile(b *testing.B) {
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _, err := fixtureFS.ReadFile("fixtures/small.json")
        if err != nil {
            b.Fatal(err)
        }
    }
}

func BenchmarkOSDirFSSmallFile(b *testing.B) {
    dirFS := os.DirFS(".")
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _, err := fs.ReadFile(dirFS, "fixtures/small.json")
        if err != nil {
            b.Fatal(err)
        }
    }
}

func BenchmarkEmbedFSLargeFile(b *testing.B) {
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _, err := fixtureFS.ReadFile("fixtures/large.bin")
        if err != nil {
            b.Fatal(err)
        }
    }
}

func BenchmarkEmbedFSWalkDir(b *testing.B) {
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        err := fs.WalkDir(fixtureFS, "fixtures", func(path string, d fs.DirEntry, err error) error {
            return err
        })
        if err != nil {
            b.Fatal(err)
        }
    }
}
```

## Section 6: Binary Size Considerations and Build Flags

### Measuring embed Impact

```bash
# Build without embedded assets
go build -o app-slim ./cmd/server

# Build with embedded assets
go build -o app-full ./cmd/server

# Compare sizes
du -sh app-slim app-full

# Analyze binary composition
go tool nm app-full | grep -i "embed" | head -20

# Check what symbols are embedded
go version -m app-full | head -30
```

### Conditional Embedding with Build Constraints

```go
// embed_prod.go
//go:build !dev

package main

import "embed"

//go:embed web/dist
var webDist embed.FS

func getWebFS() fs.FS {
    sub, _ := fs.Sub(webDist, "web/dist")
    return sub
}
```

```go
// embed_dev.go
//go:build dev

package main

import (
    "io/fs"
    "os"
)

// In dev mode, serve from disk for hot reloading
func getWebFS() fs.FS {
    return os.DirFS("web/dist")
}
```

Build for production:

```bash
go build -o app ./cmd/server
```

Build for development with live reload:

```bash
go build -tags dev -o app-dev ./cmd/server
```

### Trimming Binary Size

```bash
# Strip debug symbols and reduce binary size
go build \
  -ldflags="-s -w" \
  -trimpath \
  -o app \
  ./cmd/server

# UPX compression (use carefully - increases startup time)
upx --best app

# Compare results
ls -lah app*
```

## Section 7: Configuration Embedding Pattern

```go
package config

import (
    "embed"
    "fmt"
    "io/fs"
    "os"
    "strings"

    "gopkg.in/yaml.v3"
)

//go:embed defaults
var defaultsFS embed.FS

type Config struct {
    Server   ServerConfig   `yaml:"server"`
    Database DatabaseConfig `yaml:"database"`
    Cache    CacheConfig    `yaml:"cache"`
}

type Loader struct {
    env        string
    overrideFS fs.FS // nil means use defaults only
}

func NewLoader(env string) *Loader {
    return &Loader{env: env}
}

// Load merges: defaults.yaml -> env defaults -> environment variables
func (l *Loader) Load() (*Config, error) {
    // Start with compiled-in defaults
    base, err := l.loadEmbedded("defaults/base.yaml")
    if err != nil {
        return nil, fmt.Errorf("loading base defaults: %w", err)
    }

    // Layer environment-specific defaults
    envFile := fmt.Sprintf("defaults/%s.yaml", l.env)
    if envData, err := defaultsFS.ReadFile(envFile); err == nil {
        if err := yaml.Unmarshal(envData, base); err != nil {
            return nil, fmt.Errorf("parsing env defaults: %w", err)
        }
    }

    // Override from environment variables (highest priority)
    l.applyEnvOverrides(base)

    return base, nil
}

func (l *Loader) loadEmbedded(path string) (*Config, error) {
    data, err := defaultsFS.ReadFile(path)
    if err != nil {
        return nil, err
    }
    var cfg Config
    if err := yaml.Unmarshal(data, &cfg); err != nil {
        return nil, err
    }
    return &cfg, nil
}

func (l *Loader) applyEnvOverrides(cfg *Config) {
    if v := os.Getenv("SERVER_PORT"); v != "" {
        fmt.Sscanf(v, "%d", &cfg.Server.Port)
    }
    if v := os.Getenv("DATABASE_URL"); v != "" {
        cfg.Database.URL = v
    }
    if v := os.Getenv("CACHE_TTL"); v != "" {
        cfg.Cache.TTL = v
    }
}
```

The `embed` package fundamentally changes how Go applications are distributed. By embedding assets at compile time, you get single-binary deployments, reproducible builds, and elimination of runtime file system dependencies. The `fs.FS` interface ensures embedded file systems are interchangeable with real ones, enabling thorough testing without mocking complexity.
