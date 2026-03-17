---
title: "Go Embed FS: Packaging Static Assets and Templates in Binaries"
date: 2029-01-10T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "embed", "Static Assets", "Binary Distribution", "Templates"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go's embed package for packaging static files, HTML templates, migrations, and configuration into single self-contained binaries, covering embed.FS patterns, testing strategies, and production considerations."
more_link: "yes"
url: "/go-embed-fs-static-assets-binaries/"
---

Go's `embed` package, introduced in Go 1.16, enables developers to bundle arbitrary files and directory trees directly into compiled binaries. This capability eliminates deployment dependencies on external file paths, simplifies distribution of CLI tools and services, and ensures binary-level consistency between what was tested and what runs in production. This guide covers the full spectrum of `embed` usage patterns, from simple single-file embedding to complex virtual filesystems, along with testing strategies and performance characteristics relevant to enterprise deployments.

<!--more-->

## The embed Package Fundamentals

The `embed` package uses build-time directives in the form of `//go:embed` comments to instruct the compiler to include files in the binary. Three types can hold embedded content: `string`, `[]byte`, and `embed.FS`.

### Single File Embedding

```go
package main

import (
    _ "embed"
    "fmt"
)

//go:embed configs/default-config.yaml
var defaultConfig []byte

//go:embed VERSION
var version string

//go:embed web/index.html
var indexHTML string

func main() {
    fmt.Printf("Version: %s\n", version)
    fmt.Printf("Default config size: %d bytes\n", len(defaultConfig))
    fmt.Printf("Index HTML preview: %.80s...\n", indexHTML)
}
```

Single-file embedding with `string` and `[]byte` is the simplest pattern. The compiler resolves the path relative to the Go source file, not the working directory at runtime. Paths must not contain `.` or `..` components, and symlinks are followed exactly once.

### embed.FS for Directory Trees

`embed.FS` is an immutable, read-only filesystem interface satisfying `io/fs.FS`. It supports multiple file and directory patterns in a single directive.

```go
package server

import (
    "embed"
    "io/fs"
    "net/http"
    "text/template"
)

//go:embed web/static web/templates
var webContent embed.FS

//go:embed migrations/*.sql
var migrations embed.FS

//go:embed configs/environments
var envConfigs embed.FS

// StaticFileServer returns an http.Handler serving embedded static files.
func StaticFileServer() http.Handler {
    // Strip the "web/static" prefix so URLs map to /css/app.css, not /web/static/css/app.css
    stripped, err := fs.Sub(webContent, "web/static")
    if err != nil {
        panic("failed to create sub-filesystem: " + err.Error())
    }
    return http.FileServer(http.FS(stripped))
}

// LoadTemplates parses all HTML templates from the embedded filesystem.
func LoadTemplates() (*template.Template, error) {
    return template.ParseFS(webContent, "web/templates/*.html", "web/templates/partials/*.html")
}
```

## Real-World Application: HTTP Service with Embedded Assets

The following example demonstrates a complete HTTP service that embeds its entire web directory, SQL migrations, and configuration templates.

### Project Structure

```
myservice/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── server/
│   │   ├── server.go
│   │   ├── assets.go       ← embed directives live here
│   │   └── handlers.go
│   └── db/
│       └── migrate.go
├── web/
│   ├── static/
│   │   ├── css/
│   │   │   └── app.css
│   │   └── js/
│   │       └── app.js
│   └── templates/
│       ├── base.html
│       ├── index.html
│       └── partials/
│           └── nav.html
├── migrations/
│   ├── 001_create_users.sql
│   ├── 002_create_sessions.sql
│   └── 003_add_user_roles.sql
└── configs/
    └── environments/
        ├── development.yaml
        ├── staging.yaml
        └── production.yaml
```

### assets.go: Centralized Embed Directives

```go
// internal/server/assets.go
package server

import "embed"

// webFS holds all web assets: static files and HTML templates.
// The embed directive must be in the same package as the variable it annotates.
//go:embed all:../../web
var webFS embed.FS

// migrationsFS holds SQL migration files executed at startup.
//go:embed ../../migrations
var migrationsFS embed.FS

// configsFS holds environment-specific YAML configuration templates.
//go:embed ../../configs/environments
var configsFS embed.FS
```

The `all:` prefix (introduced in Go 1.16) includes hidden files (those beginning with `.` or `_`) that are normally excluded. This matters when embedding directories that contain `.gitkeep` or `.env.example` files.

### Template Rendering with embed.FS

```go
// internal/server/handlers.go
package server

import (
    "html/template"
    "io/fs"
    "log/slog"
    "net/http"
    "time"
)

type TemplateRenderer struct {
    templates *template.Template
}

func NewTemplateRenderer() (*TemplateRenderer, error) {
    // Create sub-FS to avoid exposing migrations and configs through templates
    templatesFS, err := fs.Sub(webFS, "web/templates")
    if err != nil {
        return nil, fmt.Errorf("creating templates sub-filesystem: %w", err)
    }

    funcMap := template.FuncMap{
        "formatDate": func(t time.Time) string {
            return t.Format("January 2, 2006")
        },
        "safeHTML": func(s string) template.HTML {
            return template.HTML(s)
        },
    }

    tmpl, err := template.New("").
        Funcs(funcMap).
        ParseFS(templatesFS, "*.html", "partials/*.html")
    if err != nil {
        return nil, fmt.Errorf("parsing templates: %w", err)
    }

    return &TemplateRenderer{templates: tmpl}, nil
}

type PageData struct {
    Title    string
    Content  interface{}
    Version  string
    BuildSHA string
}

func (r *TemplateRenderer) Render(w http.ResponseWriter, name string, data PageData) {
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    if err := r.templates.ExecuteTemplate(w, name, data); err != nil {
        slog.Error("template execution failed",
            "template", name,
            "error", err)
        http.Error(w, "internal server error", http.StatusInternalServerError)
    }
}
```

### Database Migrations with embed.FS

```go
// internal/db/migrate.go
package db

import (
    "context"
    "database/sql"
    "embed"
    "fmt"
    "io/fs"
    "log/slog"
    "sort"
    "strings"
)

// MigrateUp runs all pending SQL migrations from the embedded filesystem.
// It creates a schema_migrations table to track applied migrations.
func MigrateUp(ctx context.Context, db *sql.DB, migrations embed.FS) error {
    if err := ensureMigrationsTable(ctx, db); err != nil {
        return fmt.Errorf("ensuring migrations table: %w", err)
    }

    applied, err := appliedMigrations(ctx, db)
    if err != nil {
        return fmt.Errorf("fetching applied migrations: %w", err)
    }

    entries, err := fs.ReadDir(migrations, "migrations")
    if err != nil {
        return fmt.Errorf("reading migrations directory: %w", err)
    }

    // Sort migrations by filename to ensure deterministic order
    sort.Slice(entries, func(i, j int) bool {
        return entries[i].Name() < entries[j].Name()
    })

    for _, entry := range entries {
        if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
            continue
        }

        name := entry.Name()
        if applied[name] {
            slog.Debug("migration already applied", "migration", name)
            continue
        }

        content, err := fs.ReadFile(migrations, "migrations/"+name)
        if err != nil {
            return fmt.Errorf("reading migration %s: %w", name, err)
        }

        slog.Info("applying migration", "migration", name)
        tx, err := db.BeginTx(ctx, nil)
        if err != nil {
            return fmt.Errorf("beginning transaction for %s: %w", name, err)
        }

        if _, err := tx.ExecContext(ctx, string(content)); err != nil {
            _ = tx.Rollback()
            return fmt.Errorf("executing migration %s: %w", name, err)
        }

        if _, err := tx.ExecContext(ctx,
            "INSERT INTO schema_migrations (name, applied_at) VALUES ($1, NOW())",
            name); err != nil {
            _ = tx.Rollback()
            return fmt.Errorf("recording migration %s: %w", name, err)
        }

        if err := tx.Commit(); err != nil {
            return fmt.Errorf("committing migration %s: %w", name, err)
        }

        slog.Info("migration applied successfully", "migration", name)
    }

    return nil
}

func ensureMigrationsTable(ctx context.Context, db *sql.DB) error {
    _, err := db.ExecContext(ctx, `
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name       TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    return err
}

func appliedMigrations(ctx context.Context, db *sql.DB) (map[string]bool, error) {
    rows, err := db.QueryContext(ctx, "SELECT name FROM schema_migrations")
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    applied := make(map[string]bool)
    for rows.Next() {
        var name string
        if err := rows.Scan(&name); err != nil {
            return nil, err
        }
        applied[name] = true
    }
    return applied, rows.Err()
}
```

## Configuration Loading from Embedded Files

```go
// internal/config/config.go
package config

import (
    "embed"
    "fmt"
    "io/fs"
    "os"

    "gopkg.in/yaml.v3"
)

type Config struct {
    Server   ServerConfig   `yaml:"server"`
    Database DatabaseConfig `yaml:"database"`
    Redis    RedisConfig    `yaml:"redis"`
    Logging  LoggingConfig  `yaml:"logging"`
}

type ServerConfig struct {
    Port         int    `yaml:"port"`
    ReadTimeout  string `yaml:"read_timeout"`
    WriteTimeout string `yaml:"write_timeout"`
    TLSCertFile  string `yaml:"tls_cert_file"`
    TLSKeyFile   string `yaml:"tls_key_file"`
}

type DatabaseConfig struct {
    Host            string `yaml:"host"`
    Port            int    `yaml:"port"`
    Name            string `yaml:"name"`
    User            string `yaml:"user"`
    Password        string `yaml:"-"`  // loaded from env, not YAML
    MaxOpenConns    int    `yaml:"max_open_conns"`
    MaxIdleConns    int    `yaml:"max_idle_conns"`
    ConnMaxLifetime string `yaml:"conn_max_lifetime"`
}

// LoadConfig loads a base configuration from embedded files and overlays
// environment-specific values, then applies environment variable overrides.
func LoadConfig(configsFS embed.FS, env string) (*Config, error) {
    // Load base config
    base, err := loadFromEmbedFS(configsFS, "configs/environments/base.yaml")
    if err != nil {
        // base.yaml is optional
        base = &Config{}
    }

    // Load environment-specific config
    envConfig, err := loadFromEmbedFS(configsFS, fmt.Sprintf("configs/environments/%s.yaml", env))
    if err != nil {
        return nil, fmt.Errorf("loading %s config: %w", env, err)
    }

    // Merge: environment config overrides base
    merged := mergeConfigs(base, envConfig)

    // Apply environment variable overrides for secrets
    if dbPass := os.Getenv("DB_PASSWORD"); dbPass != "" {
        merged.Database.Password = dbPass
    }

    return merged, nil
}

func loadFromEmbedFS(fsys embed.FS, path string) (*Config, error) {
    data, err := fs.ReadFile(fsys, path)
    if err != nil {
        return nil, fmt.Errorf("reading %s: %w", path, err)
    }

    var cfg Config
    if err := yaml.Unmarshal(data, &cfg); err != nil {
        return nil, fmt.Errorf("parsing %s: %w", path, err)
    }

    return &cfg, nil
}

func mergeConfigs(base, override *Config) *Config {
    result := *base
    // Simple field-level merge; a production system would use mergo or similar
    if override.Server.Port != 0 {
        result.Server.Port = override.Server.Port
    }
    if override.Database.Host != "" {
        result.Database.Host = override.Database.Host
    }
    return &result
}
```

## Testing Strategies for embed.FS

Testing embedded content requires verifying that expected files exist, have the correct content, and that the filesystem behaves correctly at both compile time and runtime.

```go
// internal/server/assets_test.go
package server

import (
    "io/fs"
    "strings"
    "testing"
)

func TestWebFSContents(t *testing.T) {
    t.Run("static files present", func(t *testing.T) {
        requiredFiles := []string{
            "web/static/css/app.css",
            "web/static/js/app.js",
        }
        for _, path := range requiredFiles {
            if _, err := webFS.Open(path); err != nil {
                t.Errorf("required file %s missing from embed: %v", path, err)
            }
        }
    })

    t.Run("templates parseable", func(t *testing.T) {
        renderer, err := NewTemplateRenderer()
        if err != nil {
            t.Fatalf("failed to create template renderer: %v", err)
        }
        if renderer.templates == nil {
            t.Fatal("templates should not be nil")
        }
    })

    t.Run("no unexpected files in web", func(t *testing.T) {
        forbidden := []string{".env", "secrets.yaml", "private.key"}
        err := fs.WalkDir(webFS, "web", func(path string, d fs.DirEntry, err error) error {
            if err != nil {
                return err
            }
            name := d.Name()
            for _, f := range forbidden {
                if strings.EqualFold(name, f) {
                    t.Errorf("sensitive file found in embedded FS: %s", path)
                }
            }
            return nil
        })
        if err != nil {
            t.Fatalf("walking webFS: %v", err)
        }
    })

    t.Run("migration files sorted and parseable", func(t *testing.T) {
        entries, err := fs.ReadDir(migrationsFS, "migrations")
        if err != nil {
            t.Fatalf("reading migrations: %v", err)
        }
        if len(entries) == 0 {
            t.Fatal("no migrations found in embedded FS")
        }
        // Verify naming convention: NNN_description.sql
        for _, e := range entries {
            if e.IsDir() {
                continue
            }
            name := e.Name()
            if !strings.HasSuffix(name, ".sql") {
                t.Errorf("non-SQL file in migrations: %s", name)
            }
            parts := strings.SplitN(name, "_", 2)
            if len(parts) < 2 {
                t.Errorf("migration file missing underscore separator: %s", name)
            }
        }
    })
}

// TestStaticFileServer verifies the HTTP handler serves embedded files correctly.
func TestStaticFileServer(t *testing.T) {
    handler := StaticFileServer()
    req := httptest.NewRequest(http.MethodGet, "/css/app.css", nil)
    rr := httptest.NewRecorder()
    handler.ServeHTTP(rr, req)

    if rr.Code != http.StatusOK {
        t.Errorf("expected 200, got %d", rr.Code)
    }
    ct := rr.Header().Get("Content-Type")
    if !strings.Contains(ct, "text/css") {
        t.Errorf("expected text/css content-type, got %s", ct)
    }
}
```

## Build-Time Considerations

### Binary Size Impact

Embedding large directories significantly increases binary size. Measure the impact:

```bash
# Build without embedded assets (for baseline)
GOFLAGS='-tags=noassets' go build -o myservice-small ./cmd/server

# Build with embedded assets
go build -o myservice-full ./cmd/server

# Compare sizes
ls -lh myservice-small myservice-full
# -rwxr-xr-x 1 mmattox mmattox  8.2M myservice-small
# -rwxr-xr-x 1 mmattox mmattox 24.1M myservice-full

# Analyze what's embedded using goblin or nm
go tool nm myservice-full | grep embed | head -20
```

### Build Tags for Development Override

During development, serving files from disk enables hot-reloading without recompilation. Build tags allow switching between embedded and filesystem serving:

```go
// internal/server/assets_embed.go  (default, included in production builds)
//go:build !dev

package server

import "embed"

//go:embed all:../../web
var webFS embed.FS

func getWebFS() fs.FS {
    stripped, _ := fs.Sub(webFS, "web")
    return stripped
}
```

```go
// internal/server/assets_dev.go  (only included with -tags dev)
//go:build dev

package server

import (
    "io/fs"
    "os"
)

func getWebFS() fs.FS {
    return os.DirFS("web")
}
```

```bash
# Production build (embedded assets)
go build -o myservice ./cmd/server

# Development build (live filesystem)
go build -tags dev -o myservice-dev ./cmd/server
./myservice-dev  # edits to web/ reflect immediately
```

### CI Verification of Embedded Assets

```bash
#!/usr/bin/env bash
# scripts/verify-embed.sh
# Verifies that all expected assets are properly embedded in the binary

set -euo pipefail

BINARY="./myservice"
go build -o "${BINARY}" ./cmd/server

# Verify binary contains expected strings from embedded files
verify_string() {
    local search="$1"
    local description="$2"
    if strings "${BINARY}" | grep -q "${search}"; then
        echo "PASS: ${description}"
    else
        echo "FAIL: ${description} (not found in binary)"
        exit 1
    fi
}

verify_string "font-family: -apple-system" "CSS file embedded"
verify_string "CREATE TABLE IF NOT EXISTS schema_migrations" "Migration SQL embedded"
verify_string "<!DOCTYPE html>" "HTML template embedded"

echo "All embed verification checks passed"
```

## Performance Characteristics

`embed.FS` reads are served from in-process memory, making them significantly faster than disk I/O for hot assets. However, there are nuances to understand:

```go
// Benchmark: embed.FS vs os.DirFS for file reads
func BenchmarkEmbedFSRead(b *testing.B) {
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        data, err := webFS.ReadFile("web/static/css/app.css")
        if err != nil {
            b.Fatal(err)
        }
        _ = data
    }
}

func BenchmarkOSDirFSRead(b *testing.B) {
    diskFS := os.DirFS("web/static")
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        data, err := fs.ReadFile(diskFS, "css/app.css")
        if err != nil {
            b.Fatal(err)
        }
        _ = data
    }
}

// Typical results on a 40KB CSS file:
// BenchmarkEmbedFSRead-16       8943211   134.5 ns/op    0 B/op   0 allocs/op
// BenchmarkOSDirFSRead-16        412893  2902.0 ns/op   40960 B/op  2 allocs/op
```

The embed.FS read is approximately 20x faster than a disk read, with zero allocations after the first access because the data is served directly from the binary's read-only data segment.

### Caching HTTP Headers for Embedded Assets

Since embedded assets are immutable at runtime, aggressive caching headers are safe:

```go
func CachedStaticFileServer(buildSHA string) http.Handler {
    stripped, _ := fs.Sub(webFS, "web/static")
    fileServer := http.FileServer(http.FS(stripped))

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Embedded assets are immutable — cache for 1 year
        // Use content hash or build SHA as cache busting parameter in URLs
        w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        w.Header().Set("ETag", `"`+buildSHA+`"`)

        // Short-circuit on matching ETag
        if r.Header.Get("If-None-Match") == `"`+buildSHA+`"` {
            w.WriteHeader(http.StatusNotModified)
            return
        }

        fileServer.ServeHTTP(w, r)
    })
}
```

## Security Considerations

### Preventing Sensitive File Embedding

Add a pre-build check to ensure no sensitive files are accidentally embedded:

```go
// tools/check-embed/main.go
//go:build ignore

package main

import (
    "fmt"
    "io/fs"
    "os"
    "strings"
)

var sensitivePatterns = []string{
    ".env", ".pem", ".key", ".p12", "secret", "password",
    "credentials", "token", ".htpasswd",
}

func main() {
    paths := os.Args[1:]
    var found []string

    for _, root := range paths {
        _ = fs.WalkDir(os.DirFS(root), ".", func(path string, d fs.DirEntry, err error) error {
            if err != nil || d.IsDir() {
                return err
            }
            lower := strings.ToLower(d.Name())
            for _, pattern := range sensitivePatterns {
                if strings.Contains(lower, pattern) {
                    found = append(found, root+"/"+path)
                }
            }
            return nil
        })
    }

    if len(found) > 0 {
        fmt.Fprintf(os.Stderr, "ERROR: potentially sensitive files in embed path:\n")
        for _, f := range found {
            fmt.Fprintf(os.Stderr, "  %s\n", f)
        }
        os.Exit(1)
    }

    fmt.Println("No sensitive files detected in embed paths")
}
```

```bash
# Run as part of CI before build
go run tools/check-embed/main.go web configs/environments migrations
```

## Summary

Go's `embed` package provides a clean, compile-time mechanism for bundling arbitrary file trees into self-contained binaries. Key production patterns include:

- Use `embed.FS` with `fs.Sub` to isolate sub-trees exposed to specific subsystems
- Use the `all:` prefix only when hidden files are intentionally included
- Separate embed directives into a dedicated `assets.go` file per package for clarity
- Implement build tag switching to enable live-reload during development
- Validate embedded asset integrity in CI before shipping binaries
- Apply aggressive HTTP caching for embedded static assets since they are immutable per build

The combination of `embed`, build tags, and the `io/fs.FS` interface results in services that deploy as single-binary artifacts with zero runtime file system dependencies.

## Using embed.FS with chi and Gorilla Mux

The `embed.FS` integrates cleanly with popular Go HTTP routers:

```go
// internal/server/routes.go
package server

import (
    "io/fs"
    "net/http"

    "github.com/go-chi/chi/v5"
)

func SetupRoutes(r chi.Router, templates *TemplateRenderer, buildSHA string) error {
    // API routes
    r.Route("/api/v1", func(r chi.Router) {
        r.Get("/users", handleGetUsers)
        r.Post("/users", handleCreateUser)
    })

    // Health endpoints
    r.Get("/healthz", handleHealthz)
    r.Get("/readyz", handleReadyz)

    // Static files — serve from embedded filesystem
    staticFS, err := fs.Sub(webFS, "web/static")
    if err != nil {
        return fmt.Errorf("creating static sub-filesystem: %w", err)
    }

    // Mount static file server with cache headers
    r.Handle("/static/*", http.StripPrefix("/static/",
        CachedStaticFileServer(buildSHA, staticFS),
    ))

    // HTML page routes served from embedded templates
    r.Get("/", func(w http.ResponseWriter, r *http.Request) {
        templates.Render(w, "index.html", PageData{
            Title:    "Home",
            Version:  version,
            BuildSHA: buildSHA,
        })
    })

    return nil
}

// CachedStaticFileServer wraps http.FileServer with immutable cache headers.
func CachedStaticFileServer(buildSHA string, fsys fs.FS) http.Handler {
    fileServer := http.FileServer(http.FS(fsys))
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        w.Header().Set("ETag", `"`+buildSHA+`"`)
        if r.Header.Get("If-None-Match") == `"`+buildSHA+`"` {
            w.WriteHeader(http.StatusNotModified)
            return
        }
        fileServer.ServeHTTP(w, r)
    })
}
```

## Embedding Multiple Module-Relative Paths

When a package is deep in a module tree, the embed path must be relative to the Go source file, not the module root:

```go
// pkg/email/templates.go  (three levels below module root)
// Module root is at: github.com/corp/myservice
// This file is at:   github.com/corp/myservice/pkg/email/
// Email templates are at: github.com/corp/myservice/pkg/email/templates/

package email

import (
    "bytes"
    "embed"
    "html/template"
    "text/template"
)

// embed path is relative to THIS .go file
//go:embed templates
var emailTemplatesFS embed.FS

type EmailTemplates struct {
    html *template.Template
    text *template.Template
}

func NewEmailTemplates() (*EmailTemplates, error) {
    htmlTmpl, err := template.ParseFS(emailTemplatesFS,
        "templates/html/*.html",
    )
    if err != nil {
        return nil, fmt.Errorf("parsing HTML email templates: %w", err)
    }

    textTmpl, err := template.ParseFS(emailTemplatesFS,
        "templates/text/*.txt",
    )
    if err != nil {
        return nil, fmt.Errorf("parsing text email templates: %w", err)
    }

    return &EmailTemplates{html: htmlTmpl, text: textTmpl}, nil
}

type WelcomeEmailData struct {
    Name      string
    LoginURL  string
    ExpiresIn string
}

func (et *EmailTemplates) RenderWelcome(data WelcomeEmailData) (html, text string, err error) {
    var htmlBuf, textBuf bytes.Buffer

    if err := et.html.ExecuteTemplate(&htmlBuf, "welcome.html", data); err != nil {
        return "", "", fmt.Errorf("rendering HTML welcome: %w", err)
    }
    if err := et.text.ExecuteTemplate(&textBuf, "welcome.txt", data); err != nil {
        return "", "", fmt.Errorf("rendering text welcome: %w", err)
    }

    return htmlBuf.String(), textBuf.String(), nil
}
```

## Embed in Plugin Architecture

`embed.FS` works well for plugin-style architectures where multiple packages embed their own assets independently:

```go
// plugins/dashboard/plugin.go
package dashboard

import "embed"

//go:embed assets
var pluginAssets embed.FS

// Plugin implements the PluginRegistrar interface
type Plugin struct{}

func (p *Plugin) Name() string { return "dashboard" }

func (p *Plugin) Assets() embed.FS { return pluginAssets }

func (p *Plugin) Routes() map[string]http.Handler {
    stripped, _ := fs.Sub(pluginAssets, "assets")
    return map[string]http.Handler{
        "/dashboard/": http.StripPrefix("/dashboard/",
            http.FileServer(http.FS(stripped))),
    }
}
```

```go
// internal/server/plugin_registry.go
package server

type PluginRegistrar interface {
    Name() string
    Assets() embed.FS
    Routes() map[string]http.Handler
}

type PluginRegistry struct {
    plugins []PluginRegistrar
}

func (pr *PluginRegistry) Register(p PluginRegistrar) {
    pr.plugins = append(pr.plugins, p)
}

func (pr *PluginRegistry) MountAll(mux *http.ServeMux) {
    for _, plugin := range pr.plugins {
        for path, handler := range plugin.Routes() {
            mux.Handle(path, handler)
        }
    }
}
```

## Docker Multi-Stage Build with Embedded Assets

```dockerfile
# Dockerfile
# Stage 1: Build the Go binary with embedded assets
FROM golang:1.22-alpine AS builder

WORKDIR /build

# Copy go.mod and go.sum first for layer caching
COPY go.mod go.sum ./
RUN go mod download

# Copy ALL source INCLUDING the assets that will be embedded
COPY . .

# Build — the embed directives compile web/ and migrations/ into the binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
    -ldflags="-s -w -X main.version=$(git describe --tags --always)" \
    -o /app/server \
    ./cmd/server

# Stage 2: Minimal runtime image — no web/ or migrations/ directory needed
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /app/server /server

# No COPY for web/ or migrations/ — they are baked into /server binary
ENTRYPOINT ["/server"]
```

```bash
# Verify the final image contains no separate asset files
docker run --rm --entrypoint sh \
  registry.corp.example.com/myservice:v1.2.3 \
  -c "find / -name '*.html' -o -name '*.sql' 2>/dev/null" || \
  echo "No loose asset files found — all embedded in binary"

# Confirm binary size contains embedded assets
docker run --rm --entrypoint sh \
  registry.corp.example.com/myservice:v1.2.3 \
  -c "ls -lh /server"
# -rwxr-xr-x 1 root root 32M /server  ← large binary = embedded assets present
```
