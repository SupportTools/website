---
title: "Go Embed Directive: Bundling Static Assets into Binaries"
date: 2029-09-13T00:00:00-05:00
draft: false
tags: ["Go", "Embed", "Static Assets", "Binary Distribution", "fs.FS", "Templates"]
categories: ["Go", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go's //go:embed directive: embedding files and directories with embed.FS, serving static files over HTTP, embedding HTML templates, configuration file bundling, and production deployment patterns."
more_link: "yes"
url: "/go-embed-directive-bundling-static-assets-binaries/"
---

The `//go:embed` directive, introduced in Go 1.16, solves a distribution problem that previously required workarounds like go-bindata or rice: including static files in the compiled binary. A single binary that contains its web assets, templates, certificates, and configuration files is dramatically easier to deploy than a binary with a required directory structure. This post covers every aspect of `//go:embed`, from basic file embedding through the `fs.FS` interface to production patterns for serving web applications.

<!--more-->

# Go Embed Directive: Bundling Static Assets into Binaries

## The Embed Directive Syntax

The `//go:embed` directive must appear immediately before a variable declaration. No blank lines between the directive and the variable. The variable must be of type `string`, `[]byte`, or `embed.FS`.

```go
package main

import (
    _ "embed"  // Required blank import when using //go:embed with string or []byte
    "fmt"
)

// Embed a single file as string
//go:embed static/version.txt
var versionString string

// Embed a single file as bytes
//go:embed static/cert.pem
var certPEM []byte

// Embed multiple files or directories as embed.FS
//go:embed static templates
var assets embed.FS

func main() {
    fmt.Printf("Version: %s\n", versionString)
    fmt.Printf("Certificate bytes: %d\n", len(certPEM))
}
```

The `_ "embed"` import is only required when using `string` or `[]byte` targets. The `embed.FS` type is from the `embed` package, so it's already imported explicitly.

## Pattern Matching in //go:embed

The directive supports glob patterns:

```go
import "embed"

// Embed all HTML files
//go:embed *.html
var htmlFiles embed.FS

// Embed all files in the templates directory
//go:embed templates
var templates embed.FS

// Embed multiple patterns
//go:embed static templates config/*.yaml
var allAssets embed.FS

// Embed all files matching pattern recursively
//go:embed static/**
var staticFiles embed.FS
```

Important constraints:
- Patterns follow `path.Match` syntax, not shell glob syntax
- Patterns are relative to the package directory
- Patterns cannot include `..` path components
- Files beginning with `.` or `_` are excluded by default
- To include dotfiles, use the `all:` prefix: `//go:embed all:static`

```go
// Include hidden files (starting with .)
//go:embed all:.git-metadata
var gitMetadata embed.FS

// Include files starting with _
//go:embed all:_internal
var internalFiles embed.FS

// all: prefix includes all files including those starting with . or _
//go:embed all:static
var staticWithHidden embed.FS
```

## embed.FS: The File System Interface

`embed.FS` implements `fs.FS`, the standard Go file system interface introduced in Go 1.16. This makes it composable with any code that accepts `fs.FS`.

```go
package main

import (
    "embed"
    "fmt"
    "io/fs"
)

//go:embed static
var staticFS embed.FS

func walkEmbeddedFiles() error {
    return fs.WalkDir(staticFS, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        if d.IsDir() {
            fmt.Printf("[DIR]  %s\n", path)
        } else {
            info, _ := d.Info()
            fmt.Printf("[FILE] %s (%d bytes)\n", path, info.Size())
        }
        return nil
    })
}

func readEmbeddedFile(path string) ([]byte, error) {
    return staticFS.ReadFile(path)
}

func main() {
    // List all embedded files
    walkEmbeddedFiles()

    // Read a specific file
    content, err := readEmbeddedFile("static/index.html")
    if err != nil {
        panic(err)
    }
    fmt.Printf("index.html: %d bytes\n", len(content))
}
```

### Stripping the Root Directory from embed.FS

When embedding a directory like `//go:embed static`, the files are accessible as `static/index.html`. To serve them as `/index.html`, strip the prefix with `fs.Sub`:

```go
package main

import (
    "embed"
    "io/fs"
    "net/http"
)

//go:embed static
var staticFS embed.FS

func main() {
    // Strip the "static" prefix from all paths
    webFS, err := fs.Sub(staticFS, "static")
    if err != nil {
        panic(err)
    }

    // Serve as HTTP file server
    // Files in static/index.html are now accessible at /index.html
    http.Handle("/", http.FileServer(http.FS(webFS)))
    http.ListenAndServe(":8080", nil)
}
```

## Serving Static Files Over HTTP

A common pattern is embedding a web application's build output:

```go
package main

import (
    "embed"
    "io/fs"
    "log"
    "net/http"
)

//go:embed dist
var distFS embed.FS

func main() {
    mux := http.NewServeMux()

    // API routes
    mux.HandleFunc("/api/health", healthHandler)
    mux.HandleFunc("/api/data", dataHandler)

    // Static files from the dist/ directory
    // After fs.Sub, dist/index.html is accessible at /index.html
    webFS, err := fs.Sub(distFS, "dist")
    if err != nil {
        log.Fatalf("Failed to create sub filesystem: %v", err)
    }

    // Serve static files, but only if no API route matches
    mux.Handle("/", http.FileServer(http.FS(webFS)))

    log.Println("Serving on :8080")
    log.Fatal(http.ListenAndServe(":8080", mux))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ok"}`))
}

func dataHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.Write([]byte(`{"data":[]}`))
}
```

### SPA (Single Page Application) Serving

SPAs need all routes to fall back to `index.html`. The standard `http.FileServer` returns 404 for unknown routes. Wrap it:

```go
package main

import (
    "embed"
    "io/fs"
    "net/http"
    "strings"
)

//go:embed dist
var distFS embed.FS

type SPAHandler struct {
    staticFS http.Handler
    indexFS  fs.FS
}

func NewSPAHandler(root fs.FS) *SPAHandler {
    return &SPAHandler{
        staticFS: http.FileServer(http.FS(root)),
        indexFS:  root,
    }
}

func (h *SPAHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Try to serve the static file
    // Check if the file exists in the embedded FS
    path := strings.TrimPrefix(r.URL.Path, "/")
    if path == "" {
        path = "index.html"
    }

    _, err := fs.Stat(h.indexFS, path)
    if err != nil {
        // File not found; serve index.html for client-side routing
        r2 := r.Clone(r.Context())
        r2.URL.Path = "/index.html"
        h.staticFS.ServeHTTP(w, r2)
        return
    }

    h.staticFS.ServeHTTP(w, r)
}

func main() {
    webFS, _ := fs.Sub(distFS, "dist")

    mux := http.NewServeMux()
    mux.HandleFunc("/api/", apiRouter)
    mux.Handle("/", NewSPAHandler(webFS))

    http.ListenAndServe(":8080", mux)
}

func apiRouter(w http.ResponseWriter, r *http.Request) {}
```

## Template Embedding

Go's `html/template` and `text/template` packages accept `fs.FS` for template loading:

```go
package main

import (
    "embed"
    "html/template"
    "io/fs"
    "net/http"
)

//go:embed templates
var templatesFS embed.FS

type TemplateRenderer struct {
    templates *template.Template
}

func NewTemplateRenderer() (*TemplateRenderer, error) {
    // Create sub-FS to strip the "templates" prefix
    tmplFS, err := fs.Sub(templatesFS, "templates")
    if err != nil {
        return nil, err
    }

    // Parse all .html files in the templates directory
    tmpl, err := template.New("").
        Funcs(template.FuncMap{
            "upper": strings.ToUpper,
        }).
        ParseFS(tmplFS, "*.html", "layouts/*.html", "partials/*.html")
    if err != nil {
        return nil, err
    }

    return &TemplateRenderer{templates: tmpl}, nil
}

type PageData struct {
    Title   string
    User    string
    Items   []string
}

func (r *TemplateRenderer) Render(w http.ResponseWriter, name string, data interface{}) error {
    return r.templates.ExecuteTemplate(w, name, data)
}

var renderer *TemplateRenderer

func homeHandler(w http.ResponseWriter, r *http.Request) {
    data := PageData{
        Title: "Home Page",
        User:  "Matthew",
        Items: []string{"Item 1", "Item 2", "Item 3"},
    }

    if err := renderer.Render(w, "home.html", data); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
    }
}

func main() {
    var err error
    renderer, err = NewTemplateRenderer()
    if err != nil {
        panic(err)
    }

    http.HandleFunc("/", homeHandler)
    http.ListenAndServe(":8080", nil)
}
```

### Template Hot Reload in Development

During development, you want template changes to take effect without rebuilding. Use a build tag to switch between embedded and filesystem templates:

```go
// templates_embed.go
//go:build !dev

package main

import (
    "embed"
    "io/fs"
)

//go:embed templates
var rawTemplateFS embed.FS

func getTemplateFS() (fs.FS, error) {
    return fs.Sub(rawTemplateFS, "templates")
}
```

```go
// templates_dev.go
//go:build dev

package main

import (
    "io/fs"
    "os"
)

func getTemplateFS() (fs.FS, error) {
    // Use the real filesystem in dev mode for hot reload
    return os.DirFS("templates"), nil
}
```

```go
// templates.go
package main

import (
    "html/template"
)

func NewTemplateRenderer() (*TemplateRenderer, error) {
    tmplFS, err := getTemplateFS()  // Resolved at compile time by build tag
    if err != nil {
        return nil, err
    }
    // ... same loading code ...
}
```

```bash
# Development: use live filesystem
go run -tags dev .

# Production: use embedded filesystem
go run .
# or
go build -o server .
```

## Configuration File Bundling

Embedding default configuration files provides sensible defaults that users can override:

```go
package config

import (
    "embed"
    "fmt"
    "io/fs"
    "os"

    "gopkg.in/yaml.v3"
)

//go:embed defaults
var defaultsFS embed.FS

type Config struct {
    Server   ServerConfig   `yaml:"server"`
    Database DatabaseConfig `yaml:"database"`
    Cache    CacheConfig    `yaml:"cache"`
}

type ServerConfig struct {
    Port         int    `yaml:"port"`
    ReadTimeout  int    `yaml:"readTimeout"`
    WriteTimeout int    `yaml:"writeTimeout"`
}

type DatabaseConfig struct {
    MaxOpenConns int    `yaml:"maxOpenConns"`
    MaxIdleConns int    `yaml:"maxIdleConns"`
    SSLMode      string `yaml:"sslMode"`
}

type CacheConfig struct {
    TTLSeconds int `yaml:"ttlSeconds"`
    MaxEntries int `yaml:"maxEntries"`
}

func Load(overridePath string) (*Config, error) {
    // Start with embedded defaults
    defaultData, err := defaultsFS.ReadFile("defaults/config.yaml")
    if err != nil {
        return nil, fmt.Errorf("reading embedded defaults: %w", err)
    }

    cfg := &Config{}
    if err := yaml.Unmarshal(defaultData, cfg); err != nil {
        return nil, fmt.Errorf("parsing embedded defaults: %w", err)
    }

    // Override with user config if provided
    if overridePath != "" {
        overrideData, err := os.ReadFile(overridePath)
        if err != nil {
            return nil, fmt.Errorf("reading config file %s: %w", overridePath, err)
        }
        // Unmarshal into the same struct; only present fields are overridden
        if err := yaml.Unmarshal(overrideData, cfg); err != nil {
            return nil, fmt.Errorf("parsing config file: %w", err)
        }
    }

    return cfg, nil
}

// PrintDefaults writes the embedded default config to stdout for user reference
func PrintDefaults() error {
    return fs.WalkDir(defaultsFS, "defaults", func(path string, d fs.DirEntry, err error) error {
        if err != nil || d.IsDir() {
            return err
        }
        data, err := defaultsFS.ReadFile(path)
        if err != nil {
            return err
        }
        fmt.Printf("# %s\n%s\n", path, data)
        return nil
    })
}
```

The `defaults/config.yaml`:

```yaml
# defaults/config.yaml
server:
  port: 8080
  readTimeout: 30
  writeTimeout: 30

database:
  maxOpenConns: 25
  maxIdleConns: 5
  sslMode: require

cache:
  ttlSeconds: 300
  maxEntries: 10000
```

## Embedding TLS Certificates and Keys

Embedding certificates for internal service authentication:

```go
package tls

import (
    "crypto/tls"
    "crypto/x509"
    _ "embed"
    "fmt"
)

// Embed internal CA certificate for mTLS
//go:embed certs/internal-ca.crt
var internalCACert []byte

// Embed service certificate and key
//go:embed certs/service.crt
var serviceCert []byte

//go:embed certs/service.key
var serviceKey []byte

func NewInternalTLSConfig() (*tls.Config, error) {
    // Load the certificate pair
    cert, err := tls.X509KeyPair(serviceCert, serviceKey)
    if err != nil {
        return nil, fmt.Errorf("loading certificate pair: %w", err)
    }

    // Create CA pool from embedded certificate
    caPool := x509.NewCertPool()
    if !caPool.AppendCertsFromPEM(internalCACert) {
        return nil, fmt.Errorf("failed to parse internal CA certificate")
    }

    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientCAs:    caPool,
        ClientAuth:   tls.RequireAndVerifyClientCert,
        MinVersion:   tls.VersionTLS13,
    }, nil
}
```

Note: only embed certificates that are acceptable to store in the binary. Private keys in binaries are readable by anyone with binary access — for sensitive services, use external secret management and only embed CA certificates.

## Database Migration Files

Embedding SQL migrations is a common pattern for self-contained service binaries:

```go
package migrations

import (
    "embed"
    "fmt"
    "io/fs"
    "sort"
    "strings"
)

//go:embed sql
var migrationsFS embed.FS

type Migration struct {
    Version  int
    Name     string
    UpSQL    string
    DownSQL  string
}

func LoadMigrations() ([]Migration, error) {
    entries, err := fs.ReadDir(migrationsFS, "sql")
    if err != nil {
        return nil, fmt.Errorf("reading migrations directory: %w", err)
    }

    migrationMap := make(map[int]*Migration)

    for _, entry := range entries {
        if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
            continue
        }

        // Parse filename: 001_create_users.up.sql or 001_create_users.down.sql
        parts := strings.SplitN(entry.Name(), "_", 2)
        if len(parts) != 2 {
            continue
        }

        var version int
        fmt.Sscanf(parts[0], "%d", &version)

        content, err := migrationsFS.ReadFile("sql/" + entry.Name())
        if err != nil {
            return nil, err
        }

        if _, exists := migrationMap[version]; !exists {
            migrationMap[version] = &Migration{Version: version}
            // Extract name from filename
            namePart := strings.TrimSuffix(parts[1], ".up.sql")
            namePart = strings.TrimSuffix(namePart, ".down.sql")
            migrationMap[version].Name = namePart
        }

        if strings.Contains(entry.Name(), ".up.sql") {
            migrationMap[version].UpSQL = string(content)
        } else if strings.Contains(entry.Name(), ".down.sql") {
            migrationMap[version].DownSQL = string(content)
        }
    }

    // Sort migrations by version
    migrations := make([]Migration, 0, len(migrationMap))
    for _, m := range migrationMap {
        migrations = append(migrations, *m)
    }
    sort.Slice(migrations, func(i, j int) bool {
        return migrations[i].Version < migrations[j].Version
    })

    return migrations, nil
}
```

Directory structure:

```
sql/
  001_create_users.up.sql
  001_create_users.down.sql
  002_add_email_index.up.sql
  002_add_email_index.down.sql
  003_create_sessions.up.sql
  003_create_sessions.down.sql
```

## Testing Embedded Files

```go
package main_test

import (
    "io/fs"
    "testing"
)

func TestEmbeddedFiles(t *testing.T) {
    // Verify all expected files are embedded
    requiredFiles := []string{
        "static/index.html",
        "static/app.js",
        "static/style.css",
    }

    for _, path := range requiredFiles {
        t.Run(path, func(t *testing.T) {
            _, err := staticFS.Open(path)
            if err != nil {
                t.Errorf("Required embedded file %s not found: %v", path, err)
            }
        })
    }
}

func TestNoUnintendedFiles(t *testing.T) {
    // Verify no sensitive files are accidentally embedded
    sensitivePatterns := []string{
        ".env",
        "*.key",
        "*_test.go",
        "*.secret",
    }

    fs.WalkDir(staticFS, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil || d.IsDir() {
            return err
        }

        for _, pattern := range sensitivePatterns {
            matched, _ := fs.Glob(staticFS, pattern)
            for _, m := range matched {
                t.Errorf("Sensitive file found in embedded FS: %s", m)
            }
        }
        return nil
    })
}

func TestTemplatesParseable(t *testing.T) {
    renderer, err := NewTemplateRenderer()
    if err != nil {
        t.Fatalf("Failed to create template renderer: %v", err)
    }

    // Verify all templates can be rendered
    templates := []struct {
        name string
        data interface{}
    }{
        {"home.html", PageData{Title: "Test", User: "test"}},
        {"about.html", nil},
    }

    for _, tt := range templates {
        t.Run(tt.name, func(t *testing.T) {
            if err := renderer.templates.ExecuteTemplate(io.Discard, tt.name, tt.data); err != nil {
                t.Errorf("Template %s failed to render: %v", tt.name, err)
            }
        })
    }
}
```

## Binary Size Impact

Understanding the binary size impact of `//go:embed`:

```bash
# Build without any embeds
go build -o server-no-embed .
ls -lh server-no-embed
# 8.2M

# Build with 5MB of static assets embedded
go build -o server-with-embed .
ls -lh server-with-embed
# 13.4M   (approximately 5MB larger - the compressed/raw size of assets)

# The Go embed mechanism does NOT compress embedded files by default
# Files are stored as-is in the binary

# Check what's inside (embedded content appears in data section)
readelf -S server-with-embed | grep -E "data|rodata"
# [xx] .rodata  PROGBITS  ... embedded files here
```

For large assets, consider whether embedding makes sense vs serving from a CDN or mounted volume. Rule of thumb:
- < 10MB of assets: embed freely
- 10-100MB: consider conditional embedding with build tags
- > 100MB: use external serving (CDN, object storage, mounted volume)

## Production Best Practices

```go
package main

import (
    "embed"
    "io/fs"
    "log/slog"
    "net/http"
    "time"
)

//go:embed dist
var distFS embed.FS

func main() {
    webFS, err := fs.Sub(distFS, "dist")
    if err != nil {
        slog.Error("failed to create web FS", "error", err)
        return
    }

    mux := http.NewServeMux()

    // Static files with proper cache headers
    fileServer := http.FileServer(http.FS(webFS))
    mux.Handle("/static/", cacheControlMiddleware(
        http.StripPrefix("/static/", fileServer),
        365*24*time.Hour,  // 1 year for versioned assets
    ))

    // Dynamic routes without caching
    mux.HandleFunc("/api/", apiHandler)

    // SPA fallback
    mux.Handle("/", NewSPAHandler(webFS))

    slog.Info("Server starting", "port", 8080)
    http.ListenAndServe(":8080", mux)
}

func cacheControlMiddleware(h http.Handler, maxAge time.Duration) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Cache-Control",
            fmt.Sprintf("public, max-age=%d, immutable",
                int(maxAge.Seconds())))
        h.ServeHTTP(w, r)
    })
}
```

## Summary

The `//go:embed` directive simplifies Go deployment significantly:

- Use `string` or `[]byte` for single files; use `embed.FS` for directories and patterns
- `embed.FS` implements `fs.FS` — composable with any fs.FS-aware code
- Use `fs.Sub` to strip the root directory prefix before passing to http.FileServer or template.ParseFS
- The `all:` prefix includes files starting with `.` or `_`
- Build tags enable development hot-reload with live filesystem while production uses embedded files
- Templates loaded from `embed.FS` support the same Funcs, ParseFS, and ExecuteTemplate workflow
- Configuration defaults in embedded files can be merged with user-supplied overrides at runtime
- Database migrations embedded in binaries make schema management part of the service deployment
- Files are stored as-is (not compressed) in the binary; keep total embed size under ~10MB for comfort
- Test that expected files are present and no sensitive files are accidentally included
