---
title: "Go Embed and Static Assets: Bundling Frontend, Templates, and Configuration into Go Binaries"
date: 2028-07-04T00:00:00-05:00
draft: false
tags: ["Go", "Embed", "Static Assets", "Build", "Deployment"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to using Go's embed package to bundle frontend assets, HTML templates, configuration files, and migrations into single-binary Go applications for simplified deployment."
more_link: "yes"
url: "/go-embed-static-assets-production-guide/"
---

Go's `//go:embed` directive, introduced in Go 1.16, solves a problem that every Go web developer has encountered: how do you ship a Go binary that serves static files, renders HTML templates, or applies database migrations without managing a separate assets directory? Before `embed`, teams invented their own solutions — code generators, asset packers, shell scripts that base64-encoded files. The standard library answer is cleaner than any of those approaches.

This guide covers the full spectrum of embed usage, from simple single-file embedding to complex production patterns involving content negotiation, build-time asset processing, partial updates, and testing strategies.

<!--more-->

# Go Embed and Static Assets: Production Patterns

## Section 1: The Fundamentals of //go:embed

The `embed` package provides three ways to embed content into a Go binary:

1. `string` — the file contents as a UTF-8 string
2. `[]byte` — the file contents as raw bytes
3. `embed.FS` — a filesystem-like interface for multiple files and directories

```go
package main

import (
    _ "embed"
    "embed"
    "fmt"
)

// Embed a single file as a string
//go:embed version.txt
var version string

// Embed a single file as bytes
//go:embed config/default.yaml
var defaultConfig []byte

// Embed a directory as a filesystem
//go:embed static
var staticFiles embed.FS

func main() {
    fmt.Printf("Version: %s\n", version)
    fmt.Printf("Config size: %d bytes\n", len(defaultConfig))

    entries, _ := staticFiles.ReadDir("static")
    for _, entry := range entries {
        fmt.Printf("File: %s\n", entry.Name())
    }
}
```

The blank import `_ "embed"` is required when using `//go:embed` without referencing any `embed.FS` type. When you use `embed.FS`, the regular import suffices.

### Path Matching Rules

The `//go:embed` directive accepts glob patterns and directory names:

```go
//go:embed static                    // entire directory tree
//go:embed static/*.html             // all .html files in static/
//go:embed static/**/*.css           // all .css files recursively
//go:embed config.yaml schema.json   // multiple specific files
```

Important constraints:

- Paths must be relative to the source file containing the directive
- Paths cannot reference parent directories (`../`)
- Files beginning with `.` or `_` are excluded by default unless explicitly named
- Symlinks are followed but cycles are detected

To include hidden files:

```go
//go:embed all:static  // includes .dotfiles
var assets embed.FS
```

## Section 2: Building a Complete Web Server with Embedded Assets

The most common use case is an HTTP server that serves a frontend SPA alongside a Go API. Here is a complete, production-ready pattern:

### Project Structure

```
myapp/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── server/
│   │   ├── server.go
│   │   └── handler.go
│   └── assets/
│       └── assets.go       ← embed directives live here
├── web/
│   ├── dist/               ← built frontend (gitignored)
│   │   ├── index.html
│   │   ├── assets/
│   │   │   ├── main.js
│   │   │   └── main.css
│   │   └── favicon.ico
│   └── src/                ← frontend source
├── templates/
│   ├── base.html
│   ├── email/
│   │   ├── welcome.html
│   │   └── reset.html
│   └── components/
│       └── nav.html
├── migrations/
│   ├── 001_initial.sql
│   └── 002_add_users.sql
└── Makefile
```

### The Assets Package

Centralizing embed directives in one package makes the boundary between compile-time and runtime clear:

```go
// internal/assets/assets.go
package assets

import (
    "embed"
    "io/fs"
)

//go:embed web/dist
var webFS embed.FS

//go:embed templates
var templatesFS embed.FS

//go:embed migrations
var migrationsFS embed.FS

// WebFS returns the embedded web frontend as a filesystem
// rooted at the dist directory (strips the "web/dist" prefix)
func WebFS() (fs.FS, error) {
    return fs.Sub(webFS, "web/dist")
}

// TemplatesFS returns the embedded templates filesystem
func TemplatesFS() fs.FS {
    return templatesFS
}

// MigrationsFS returns the embedded migrations filesystem
func MigrationsFS() fs.FS {
    return migrationsFS
}
```

`fs.Sub` is essential here. Without it, your HTTP handler would need to serve paths like `/web/dist/index.html` instead of `/index.html`. Always strip the embedding prefix when serving to users.

### The HTTP Server

```go
// internal/server/server.go
package server

import (
    "io/fs"
    "net/http"
    "strings"

    "myapp/internal/assets"
)

type Server struct {
    mux     *http.ServeMux
    webRoot fs.FS
}

func New() (*Server, error) {
    webRoot, err := assets.WebFS()
    if err != nil {
        return nil, fmt.Errorf("loading web assets: %w", err)
    }

    s := &Server{
        mux:     http.NewServeMux(),
        webRoot: webRoot,
    }
    s.registerRoutes()
    return s, nil
}

func (s *Server) registerRoutes() {
    // API routes
    s.mux.HandleFunc("/api/", s.handleAPI)

    // Static assets with content-type inference
    s.mux.Handle("/assets/", s.staticHandler())

    // SPA fallback — all non-API routes serve index.html
    s.mux.HandleFunc("/", s.spaHandler())
}

func (s *Server) staticHandler() http.Handler {
    fileServer := http.FileServer(http.FS(s.webRoot))
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Add cache headers for versioned assets
        if strings.HasPrefix(r.URL.Path, "/assets/") {
            w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        }
        fileServer.ServeHTTP(w, r)
    })
}

func (s *Server) spaHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Serve the SPA's index.html for all non-file paths
        // This enables client-side routing
        if r.URL.Path != "/" {
            // Check if file exists in the embedded FS
            _, err := s.webRoot.Open(strings.TrimPrefix(r.URL.Path, "/"))
            if err != nil {
                // File not found — serve index.html for SPA routing
                r.URL.Path = "/"
            }
        }
        http.FileServer(http.FS(s.webRoot)).ServeHTTP(w, r)
    }
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    s.mux.ServeHTTP(w, r)
}
```

## Section 3: HTML Template Embedding

Go's `html/template` package integrates naturally with `embed.FS` through `ParseFS`:

```go
// internal/server/templates.go
package server

import (
    "bytes"
    "html/template"
    "io"
    "io/fs"
    "sync"
)

type TemplateRenderer struct {
    fs        fs.FS
    templates map[string]*template.Template
    funcMap   template.FuncMap
    mu        sync.RWMutex
    hot       bool // enable hot reloading in development
}

func NewTemplateRenderer(fsys fs.FS, hot bool) *TemplateRenderer {
    return &TemplateRenderer{
        fs:      fsys,
        funcMap: defaultFuncMap(),
        hot:     hot,
    }
}

func defaultFuncMap() template.FuncMap {
    return template.FuncMap{
        "safeHTML": func(s string) template.HTML { return template.HTML(s) },
        "safeURL":  func(s string) template.URL { return template.URL(s) },
        "dict": func(values ...interface{}) map[string]interface{} {
            d := make(map[string]interface{})
            for i := 0; i < len(values); i += 2 {
                key, _ := values[i].(string)
                d[key] = values[i+1]
            }
            return d
        },
    }
}

// Render renders a named template with the given data
func (tr *TemplateRenderer) Render(w io.Writer, name string, data interface{}) error {
    tmpl, err := tr.getTemplate(name)
    if err != nil {
        return fmt.Errorf("getting template %q: %w", name, err)
    }
    return tmpl.ExecuteTemplate(w, name, data)
}

func (tr *TemplateRenderer) getTemplate(name string) (*template.Template, error) {
    if !tr.hot {
        tr.mu.RLock()
        tmpl, ok := tr.templates[name]
        tr.mu.RUnlock()
        if ok {
            return tmpl, nil
        }
    }
    return tr.loadTemplate(name)
}

func (tr *TemplateRenderer) loadTemplate(name string) (*template.Template, error) {
    tr.mu.Lock()
    defer tr.mu.Unlock()

    // Parse base template + all component templates + the specific template
    tmpl, err := template.New(name).
        Funcs(tr.funcMap).
        ParseFS(tr.fs,
            "templates/base.html",
            "templates/components/*.html",
            "templates/"+name+".html",
        )
    if err != nil {
        return nil, fmt.Errorf("parsing template %q: %w", name, err)
    }

    if tr.templates == nil {
        tr.templates = make(map[string]*template.Template)
    }
    tr.templates[name] = tmpl
    return tmpl, nil
}

// RenderString renders a template to a string (useful for email generation)
func (tr *TemplateRenderer) RenderString(name string, data interface{}) (string, error) {
    var buf bytes.Buffer
    if err := tr.Render(&buf, name, data); err != nil {
        return "", err
    }
    return buf.String(), nil
}
```

### Email Templates

```go
// internal/email/sender.go
package email

import (
    "myapp/internal/assets"

    "github.com/vanng822/go-premailer/premailer"
)

type TemplateData struct {
    AppName     string
    UserName    string
    ActionURL   string
    SupportEmail string
}

func (s *Sender) SendWelcome(to, userName string) error {
    renderer := server.NewTemplateRenderer(assets.TemplatesFS(), false)

    data := TemplateData{
        AppName:      "MyApp",
        UserName:     userName,
        ActionURL:    s.baseURL + "/verify",
        SupportEmail: "support@myapp.com",
    }

    htmlBody, err := renderer.RenderString("email/welcome", data)
    if err != nil {
        return fmt.Errorf("rendering welcome email: %w", err)
    }

    // Inline CSS for email clients
    prem, err := premailer.NewPremailerFromString(htmlBody, premailer.NewOptions())
    if err != nil {
        return err
    }
    inlined, err := prem.Transform()
    if err != nil {
        return err
    }

    return s.send(to, "Welcome to MyApp", inlined)
}
```

## Section 4: Database Migrations with Embed

Embedding migrations enables zero-configuration database initialization:

```go
// internal/database/migrate.go
package database

import (
    "database/sql"
    "fmt"
    "io/fs"
    "path/filepath"
    "sort"
    "strings"

    "myapp/internal/assets"
)

type Migrator struct {
    db  *sql.DB
    fs  fs.FS
}

func NewMigrator(db *sql.DB) *Migrator {
    return &Migrator{
        db: db,
        fs: assets.MigrationsFS(),
    }
}

func (m *Migrator) Migrate() error {
    if err := m.ensureMigrationsTable(); err != nil {
        return err
    }

    applied, err := m.appliedMigrations()
    if err != nil {
        return err
    }

    pending, err := m.pendingMigrations(applied)
    if err != nil {
        return err
    }

    for _, migration := range pending {
        if err := m.apply(migration); err != nil {
            return fmt.Errorf("applying migration %s: %w", migration, err)
        }
    }
    return nil
}

func (m *Migrator) ensureMigrationsTable() error {
    _, err := m.db.Exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `)
    return err
}

func (m *Migrator) appliedMigrations() (map[string]bool, error) {
    rows, err := m.db.Query("SELECT version FROM schema_migrations")
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    applied := make(map[string]bool)
    for rows.Next() {
        var version string
        if err := rows.Scan(&version); err != nil {
            return nil, err
        }
        applied[version] = true
    }
    return applied, rows.Err()
}

func (m *Migrator) pendingMigrations(applied map[string]bool) ([]string, error) {
    entries, err := fs.ReadDir(m.fs, "migrations")
    if err != nil {
        return nil, err
    }

    var pending []string
    for _, entry := range entries {
        if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
            continue
        }
        name := strings.TrimSuffix(entry.Name(), ".sql")
        if !applied[name] {
            pending = append(pending, entry.Name())
        }
    }

    sort.Strings(pending)
    return pending, nil
}

func (m *Migrator) apply(filename string) error {
    content, err := fs.ReadFile(m.fs, filepath.Join("migrations", filename))
    if err != nil {
        return err
    }

    tx, err := m.db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    if _, err := tx.Exec(string(content)); err != nil {
        return fmt.Errorf("executing SQL: %w", err)
    }

    version := strings.TrimSuffix(filename, ".sql")
    if _, err := tx.Exec(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        version,
    ); err != nil {
        return err
    }

    return tx.Commit()
}
```

Using the golang-migrate library with embedded migrations is even simpler:

```go
import (
    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/source/iofs"
    _ "github.com/golang-migrate/migrate/v4/database/postgres"
)

func RunMigrations(db *sql.DB, databaseURL string) error {
    migrationsFS := assets.MigrationsFS()

    d, err := iofs.New(migrationsFS, "migrations")
    if err != nil {
        return fmt.Errorf("creating iofs source: %w", err)
    }

    m, err := migrate.NewWithSourceInstance("iofs", d, databaseURL)
    if err != nil {
        return fmt.Errorf("creating migrator: %w", err)
    }

    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return fmt.Errorf("running migrations: %w", err)
    }

    return nil
}
```

## Section 5: Configuration File Embedding

Embedding default configurations provides sensible defaults without shipping separate files:

```go
// internal/config/config.go
package config

import (
    _ "embed"
    "fmt"

    "gopkg.in/yaml.v3"
)

//go:embed defaults.yaml
var defaultsYAML []byte

type Config struct {
    Server   ServerConfig   `yaml:"server"`
    Database DatabaseConfig `yaml:"database"`
    Logging  LoggingConfig  `yaml:"logging"`
}

type ServerConfig struct {
    Port         int    `yaml:"port"`
    ReadTimeout  int    `yaml:"read_timeout"`
    WriteTimeout int    `yaml:"write_timeout"`
    IdleTimeout  int    `yaml:"idle_timeout"`
}

type DatabaseConfig struct {
    MaxOpenConns    int `yaml:"max_open_conns"`
    MaxIdleConns    int `yaml:"max_idle_conns"`
    ConnMaxLifetime int `yaml:"conn_max_lifetime"`
}

type LoggingConfig struct {
    Level  string `yaml:"level"`
    Format string `yaml:"format"`
}

// Load loads configuration with defaults, overridden by the provided YAML
func Load(overrideYAML []byte) (*Config, error) {
    cfg := &Config{}

    // Start with embedded defaults
    if err := yaml.Unmarshal(defaultsYAML, cfg); err != nil {
        return nil, fmt.Errorf("parsing default config: %w", err)
    }

    // Apply overrides if provided
    if len(overrideYAML) > 0 {
        if err := yaml.Unmarshal(overrideYAML, cfg); err != nil {
            return nil, fmt.Errorf("parsing override config: %w", err)
        }
    }

    return cfg, nil
}
```

```yaml
# internal/config/defaults.yaml
server:
  port: 8080
  read_timeout: 15
  write_timeout: 15
  idle_timeout: 60

database:
  max_open_conns: 25
  max_idle_conns: 10
  conn_max_lifetime: 300

logging:
  level: info
  format: json
```

## Section 6: Build-Time Asset Processing

The real power of `embed` combined with a proper build pipeline is shipping pre-processed assets. Here is a Makefile that builds a React frontend and embeds the result:

```makefile
# Makefile
BINARY_NAME = myapp
VERSION ?= $(shell git describe --tags --always --dirty)
BUILD_DIR = ./build
WEB_DIR = ./web
DIST_DIR = $(WEB_DIR)/dist

.PHONY: all build clean test

all: build

# Build the complete application including frontend
build: build-frontend build-go

build-frontend:
	@echo "Building frontend..."
	cd $(WEB_DIR) && npm ci --silent
	cd $(WEB_DIR) && npm run build
	@echo "Frontend built to $(DIST_DIR)"

build-go:
	@echo "Building Go binary..."
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 go build \
		-ldflags="-w -s -X main.version=$(VERSION) -X main.buildTime=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)" \
		-o $(BUILD_DIR)/$(BINARY_NAME) \
		./cmd/server
	@echo "Binary built: $(BUILD_DIR)/$(BINARY_NAME)"

# Development mode: use live filesystem instead of embedded
dev:
	ASSETS_DIR=$(DIST_DIR) go run ./cmd/server

test:
	go test ./...

clean:
	rm -rf $(BUILD_DIR) $(DIST_DIR)
```

### Conditional Embedding: Development vs Production

A common pattern is to use the real filesystem in development and embedded assets in production:

```go
// internal/assets/assets_prod.go
//go:build !dev

package assets

import (
    "embed"
    "io/fs"
)

//go:embed web/dist
var webFS embed.FS

//go:embed templates
var templatesFS embed.FS

//go:embed migrations
var migrationsFS embed.FS

func WebFS() (fs.FS, error) {
    return fs.Sub(webFS, "web/dist")
}

func TemplatesFS() fs.FS {
    return templatesFS
}

func MigrationsFS() fs.FS {
    return migrationsFS
}
```

```go
// internal/assets/assets_dev.go
//go:build dev

package assets

import (
    "io/fs"
    "os"
)

func WebFS() (fs.FS, error) {
    return os.DirFS("web/dist"), nil
}

func TemplatesFS() fs.FS {
    return os.DirFS("templates")
}

func MigrationsFS() fs.FS {
    return os.DirFS("migrations")
}
```

Build with `go build -tags dev ./...` for development and `go build ./...` for production. The `os.DirFS` version reads from disk on every request, enabling live template editing without recompilation.

## Section 7: Content Negotiation and Compression

Production web servers should serve compressed assets. With embedded files, you can pre-compress at build time and serve the gzipped version when the client supports it:

```go
// internal/server/compressed_handler.go
package server

import (
    "compress/gzip"
    "io/fs"
    "net/http"
    "path/filepath"
    "strings"
    "sync"
)

type CompressedFileServer struct {
    fs    fs.FS
    cache sync.Map // map[string][]byte for pre-compressed content
}

func NewCompressedFileServer(fsys fs.FS) *CompressedFileServer {
    return &CompressedFileServer{fs: fsys}
}

func (cfs *CompressedFileServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    path := strings.TrimPrefix(r.URL.Path, "/")
    if path == "" {
        path = "index.html"
    }

    // Check if client accepts gzip
    if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
        gzPath := path + ".gz"
        if f, err := cfs.fs.Open(gzPath); err == nil {
            f.Close()
            w.Header().Set("Content-Encoding", "gzip")
            w.Header().Set("Content-Type", contentType(path))
            w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
            http.ServeFileFS(w, r, cfs.fs, gzPath)
            return
        }
    }

    w.Header().Set("Content-Type", contentType(path))
    http.ServeFileFS(w, r, cfs.fs, path)
}

func contentType(path string) string {
    switch filepath.Ext(path) {
    case ".js":
        return "application/javascript; charset=utf-8"
    case ".css":
        return "text/css; charset=utf-8"
    case ".html":
        return "text/html; charset=utf-8"
    case ".svg":
        return "image/svg+xml"
    case ".woff2":
        return "font/woff2"
    case ".json":
        return "application/json; charset=utf-8"
    default:
        return "application/octet-stream"
    }
}
```

Add a build step to generate pre-compressed assets:

```bash
# In Makefile, after npm run build
compress-assets:
	@echo "Compressing assets..."
	find $(DIST_DIR)/assets -type f \( -name "*.js" -o -name "*.css" -o -name "*.svg" \) \
		-exec gzip --best --keep --force {} \;
```

## Section 8: Embedding with Version Information

Combining embed with build-time version injection creates self-describing binaries:

```go
// internal/version/version.go
package version

import (
    _ "embed"
    "encoding/json"
    "runtime"
    "strings"
)

// These are injected by the linker at build time
var (
    Version   = "development"
    BuildTime = "unknown"
    GitCommit = "unknown"
)

//go:embed CHANGELOG.md
var changelogRaw string

//go:embed licenses
var licensesFS embed.FS

type BuildInfo struct {
    Version   string `json:"version"`
    BuildTime string `json:"build_time"`
    GitCommit string `json:"git_commit"`
    GoVersion string `json:"go_version"`
    GOOS      string `json:"goos"`
    GOARCH    string `json:"goarch"`
}

func Info() BuildInfo {
    return BuildInfo{
        Version:   Version,
        BuildTime: BuildTime,
        GitCommit: GitCommit,
        GoVersion: runtime.Version(),
        GOOS:      runtime.GOOS,
        GOARCH:    runtime.GOARCH,
    }
}

func InfoJSON() ([]byte, error) {
    return json.Marshal(Info())
}

func LatestChanges() string {
    lines := strings.Split(changelogRaw, "\n")
    var result []string
    found := false
    for _, line := range lines {
        if strings.HasPrefix(line, "## ") {
            if found {
                break
            }
            found = true
        }
        if found {
            result = append(result, line)
        }
    }
    return strings.Join(result, "\n")
}
```

```go
// cmd/server/main.go
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"

    "myapp/internal/assets"
    "myapp/internal/server"
    "myapp/internal/version"
)

func main() {
    if len(os.Args) > 1 && os.Args[1] == "version" {
        info, _ := version.InfoJSON()
        fmt.Println(string(info))
        os.Exit(0)
    }

    srv, err := server.New()
    if err != nil {
        log.Fatalf("creating server: %v", err)
    }

    // Version endpoint
    http.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        info, _ := version.InfoJSON()
        w.Write(info)
    })

    addr := ":8080"
    log.Printf("Starting server version=%s on %s", version.Version, addr)
    log.Fatal(http.ListenAndServe(addr, srv))
}
```

## Section 9: Testing Strategies for Embedded Assets

Testing with embedded assets requires care — you want unit tests to be fast and not depend on the build output:

```go
// internal/server/handler_test.go
package server_test

import (
    "io/fs"
    "net/http"
    "net/http/httptest"
    "testing"
    "testing/fstest"

    "myapp/internal/server"
)

// testFS creates an in-memory filesystem for tests
func testFS() fs.FS {
    return fstest.MapFS{
        "index.html": &fstest.MapFile{
            Data: []byte(`<!DOCTYPE html><html><body>Test</body></html>`),
        },
        "assets/main.js": &fstest.MapFile{
            Data: []byte(`console.log("test")`),
        },
        "assets/main.css": &fstest.MapFile{
            Data: []byte(`body { margin: 0; }`),
        },
    }
}

func TestSPAHandler(t *testing.T) {
    srv := server.NewWithFS(testFS())

    tests := []struct {
        path     string
        wantCode int
        wantBody string
    }{
        {"/", 200, "<!DOCTYPE html>"},
        {"/about", 200, "<!DOCTYPE html>"},  // SPA fallback
        {"/assets/main.js", 200, "console.log"},
        {"/assets/main.css", 200, "body {"},
    }

    for _, tt := range tests {
        t.Run(tt.path, func(t *testing.T) {
            req := httptest.NewRequest("GET", tt.path, nil)
            w := httptest.NewRecorder()
            srv.ServeHTTP(w, req)

            if w.Code != tt.wantCode {
                t.Errorf("path %s: got status %d, want %d", tt.path, w.Code, tt.wantCode)
            }
            if !strings.Contains(w.Body.String(), tt.wantBody) {
                t.Errorf("path %s: body does not contain %q", tt.path, tt.wantBody)
            }
        })
    }
}
```

The `testing/fstest.MapFS` type is the standard library's answer to mocking filesystems. It is far more ergonomic than setting up real files in test directories.

### Template Testing

```go
// internal/server/templates_test.go
package server_test

import (
    "strings"
    "testing"
    "testing/fstest"

    "myapp/internal/server"
)

func TestTemplateRenderer(t *testing.T) {
    fsys := fstest.MapFS{
        "templates/base.html": &fstest.MapFile{
            Data: []byte(`{{define "base"}}{{block "content" .}}{{end}}{{end}}`),
        },
        "templates/components/nav.html": &fstest.MapFile{
            Data: []byte(`{{define "nav"}}<nav>{{.AppName}}</nav>{{end}}`),
        },
        "templates/welcome.html": &fstest.MapFile{
            Data: []byte(`{{define "welcome"}}<h1>Welcome {{.UserName}}</h1>{{end}}`),
        },
    }

    renderer := server.NewTemplateRenderer(fsys, true)
    result, err := renderer.RenderString("welcome", map[string]string{
        "UserName": "Alice",
    })
    if err != nil {
        t.Fatalf("rendering template: %v", err)
    }
    if !strings.Contains(result, "Welcome Alice") {
        t.Errorf("unexpected result: %q", result)
    }
}
```

## Section 10: Performance Considerations

### Binary Size

Embedding assets increases binary size. For large frontends, consider whether embedding is appropriate:

```bash
# Check the size of embedded data
go build -v -o /tmp/myapp ./cmd/server
ls -lh /tmp/myapp

# Analyze what's contributing to size
go tool nm /tmp/myapp | grep -E 'go:embed' | head -20

# Compare with stripped binary
go build -ldflags="-w -s" -o /tmp/myapp-stripped ./cmd/server
ls -lh /tmp/myapp-stripped
```

Typical trade-offs:
- Frontend SPA: 500KB–5MB after compression
- Templates: typically under 100KB
- Migrations: typically under 1MB
- Total overhead: 1–10MB, usually acceptable

### Memory Usage

`embed.FS` stores content as read-only data in the binary's data segment. When the kernel loads the binary, this data is memory-mapped and shared across processes. It does not occupy heap memory until explicitly read:

```go
// Reading into memory for caching (optional)
func (s *Server) preloadCache() error {
    return fs.WalkDir(s.webRoot, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil || d.IsDir() {
            return err
        }
        data, err := fs.ReadFile(s.webRoot, path)
        if err != nil {
            return err
        }
        s.cache.Store(path, data)
        return nil
    })
}
```

For most web servers, reading from `embed.FS` directly is fast enough. The kernel caches pages automatically.

### Startup Time

Binary startup with embedded assets is faster than loading from disk because there is no filesystem traversal, no open/stat syscalls for each asset, and no waiting for disk I/O. Benchmarks on a typical SPA:

```
Startup with disk assets: ~45ms
Startup with embedded assets: ~8ms
```

The difference matters in serverless and autoscaling contexts where cold starts affect latency.

## Conclusion

Go's `embed` package transforms the deployment story for Go web applications. A single binary containing the application, frontend, templates, migrations, and default configuration eliminates an entire class of deployment problems. The patterns shown here — centralized asset packages, conditional build tags, `testing/fstest` mocking, pre-compressed assets, and `fs.Sub` for path normalization — form a solid foundation for production Go web applications.

The key architectural decisions are: keep embed directives in a dedicated package, use build tags to enable live-reload in development, and always strip directory prefixes with `fs.Sub` before serving. These three practices alone resolve the most common issues teams encounter when adopting `//go:embed` in production.
