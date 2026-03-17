---
title: "Go Embedded Files: embed.FS, Template Bundling, and Static Asset Serving"
date: 2030-05-08T00:00:00-05:00
draft: false
tags: ["Go", "embed", "Templates", "Static Assets", "Web Development", "Build Pipeline"]
categories: ["Go", "Web Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Go's embed package: embedding HTML templates and static assets, serving versioned files, bundling database migrations, configuration files, and test fixtures into single-binary deployments."
more_link: "yes"
url: "/go-embedded-files-embed-fs-template-bundling-static-assets/"
---

Go's `embed` package, introduced in Go 1.16, enables bundling files and directories directly into compiled binaries. This transforms deployment from multi-artifact coordination (binary + config files + templates + migrations) into a single-binary delivery model. The result is simpler deployment pipelines, elimination of runtime file-not-found errors, and improved security through immutable, cryptographically reproducible builds.

This guide covers the complete spectrum of embed usage: the `go:embed` directive mechanics, `embed.FS` operations, production-quality template systems, versioned static asset serving, database migration embedding, and performance considerations for large asset sets.

<!--more-->

## embed Package Fundamentals

### The go:embed Directive

The `//go:embed` directive is processed at compile time and must immediately precede a variable declaration of type `string`, `[]byte`, or `embed.FS`:

```go
package main

import (
    "embed"
    _ "embed" // Required even if using only string/[]byte variants
)

// Embed a single file as a string
//go:embed version.txt
var version string

// Embed a single file as bytes
//go:embed config/defaults.yaml
var defaultConfig []byte

// Embed multiple files as an embed.FS
//go:embed templates
var templateFS embed.FS

// Embed multiple patterns
//go:embed static/css static/js static/img
var staticFS embed.FS

// Embed all files in a directory (including nested)
//go:embed migrations
var migrationsFS embed.FS

// Embed a glob pattern
//go:embed assets/*.png assets/*.jpg
var imageFS embed.FS
```

### Embed Directive Rules and Constraints

```go
// RULE 1: The directive must be on the line immediately before the variable
// This will NOT compile:
//go:embed config.yaml

var someOtherVar = "hello" // ERROR: directive not adjacent to variable

//go:embed config.yaml
var configData []byte // Correct

// RULE 2: Embedded paths are relative to the package directory
// If the file is at: mypackage/assets/style.css
// The embed path is: assets/style.css

// RULE 3: Dot files and underscore files are excluded by default
// To include them, use the 'all:' prefix:
//go:embed all:configs
var configsFS embed.FS

// RULE 4: Directories include all files recursively (except dot/underscore)
//go:embed templates  // includes templates/, templates/subdir/, etc.
var templatesFS embed.FS

// RULE 5: String/[]byte can only embed a single file
//go:embed assets/logo.png
var logo []byte // OK

//go:embed assets/  // ERROR: cannot use directory with string/[]byte
var assets string  // Must use embed.FS for directories

// RULE 6: embed.FS is read-only at runtime
// You cannot write to it, only read
```

### embed.FS API

```go
package main

import (
    "embed"
    "fmt"
    "io/fs"
)

//go:embed data
var dataFS embed.FS

func demonstrateEmbedFS() error {
    // Open a file
    f, err := dataFS.Open("data/config.yaml")
    if err != nil {
        return fmt.Errorf("open: %w", err)
    }
    defer f.Close()

    // Read entire file
    content, err := dataFS.ReadFile("data/config.yaml")
    if err != nil {
        return fmt.Errorf("readfile: %w", err)
    }
    fmt.Printf("Config: %s\n", content)

    // List directory contents
    entries, err := dataFS.ReadDir("data")
    if err != nil {
        return fmt.Errorf("readdir: %w", err)
    }
    for _, entry := range entries {
        info, _ := entry.Info()
        fmt.Printf("  %s (%d bytes, dir=%v)\n", entry.Name(), info.Size(), entry.IsDir())
    }

    // Walk the embedded filesystem
    err = fs.WalkDir(dataFS, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        if !d.IsDir() {
            fmt.Printf("  File: %s\n", path)
        }
        return nil
    })
    if err != nil {
        return fmt.Errorf("walk: %w", err)
    }

    // Create a sub-filesystem (strip the leading directory)
    subFS, err := fs.Sub(dataFS, "data")
    if err != nil {
        return fmt.Errorf("sub: %w", err)
    }
    // subFS now has paths without the "data/" prefix
    content2, _ := fs.ReadFile(subFS, "config.yaml")
    _ = content2

    return nil
}
```

## Embedding HTML Templates

### Template Hierarchy with Embedded Files

```
project/
├── main.go
├── server/
│   ├── server.go
│   └── templates/
│       ├── base.html
│       ├── components/
│       │   ├── header.html
│       │   ├── footer.html
│       │   └── nav.html
│       └── pages/
│           ├── index.html
│           ├── dashboard.html
│           └── error.html
└── static/
    ├── css/
    │   └── app.css
    └── js/
        └── app.js
```

```go
// server/server.go
package server

import (
    "embed"
    "fmt"
    "html/template"
    "io/fs"
    "net/http"
    "path/filepath"
    "strings"
    "sync"
    "time"
)

//go:embed templates
var templatesFS embed.FS

//go:embed static
var staticFS embed.FS

// TemplateManager manages parsing and caching of embedded templates.
type TemplateManager struct {
    templates map[string]*template.Template
    funcMap   template.FuncMap
    mu        sync.RWMutex
    // reloadable: if true, re-parse templates on each render (dev mode only)
    reloadable bool
}

func NewTemplateManager(reloadable bool) (*TemplateManager, error) {
    tm := &TemplateManager{
        templates:  make(map[string]*template.Template),
        reloadable: reloadable,
        funcMap: template.FuncMap{
            "formatTime":   formatTime,
            "humanBytes":   humanBytes,
            "safeHTML":     func(s string) template.HTML { return template.HTML(s) },
            "safeURL":      func(s string) template.URL { return template.URL(s) },
            "toJSON":       toJSON,
            "dict":         templateDict,
            "slice":        templateSlice,
            "assetURL":     AssetURL,
        },
    }

    if !reloadable {
        if err := tm.parseAllTemplates(); err != nil {
            return nil, fmt.Errorf("failed to parse templates: %w", err)
        }
    }

    return tm, nil
}

func (tm *TemplateManager) parseAllTemplates() error {
    // Find all page templates
    pageEntries, err := fs.ReadDir(templatesFS, "templates/pages")
    if err != nil {
        return fmt.Errorf("reading pages dir: %w", err)
    }

    // Component and layout files shared across all pages
    baseFiles := []string{"templates/base.html"}
    componentFiles, err := findFiles(templatesFS, "templates/components")
    if err != nil {
        return fmt.Errorf("reading components dir: %w", err)
    }

    // Parse each page template with base + components
    for _, entry := range pageEntries {
        if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".html") {
            continue
        }

        pagePath := "templates/pages/" + entry.Name()
        files := append([]string{pagePath}, append(baseFiles, componentFiles...)...)

        // template.ParseFS parses from embed.FS directly
        tmpl, err := template.New(entry.Name()).
            Funcs(tm.funcMap).
            ParseFS(templatesFS, files...)
        if err != nil {
            return fmt.Errorf("parsing template %s: %w", pagePath, err)
        }

        name := strings.TrimSuffix(entry.Name(), ".html")
        tm.templates[name] = tmpl
    }

    return nil
}

// Render executes a named template with the provided data.
func (tm *TemplateManager) Render(w http.ResponseWriter, name string, data interface{}) error {
    if tm.reloadable {
        // Re-parse on every render (development mode)
        if err := tm.parseAllTemplates(); err != nil {
            return fmt.Errorf("re-parsing templates: %w", err)
        }
    }

    tm.mu.RLock()
    tmpl, ok := tm.templates[name]
    tm.mu.RUnlock()

    if !ok {
        return fmt.Errorf("template %q not found", name)
    }

    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    return tmpl.ExecuteTemplate(w, "base.html", data)
}

func findFiles(fsys fs.FS, dir string) ([]string, error) {
    var files []string
    err := fs.WalkDir(fsys, dir, func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        if !d.IsDir() && strings.HasSuffix(path, ".html") {
            files = append(files, path)
        }
        return nil
    })
    return files, err
}

func formatTime(t time.Time) string {
    return t.Format("2006-01-02 15:04:05")
}

func humanBytes(b int64) string {
    const unit = 1024
    if b < unit {
        return fmt.Sprintf("%d B", b)
    }
    div, exp := int64(unit), 0
    for n := b / unit; n >= unit; n /= unit {
        div *= unit
        exp++
    }
    return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}

func toJSON(v interface{}) template.JS {
    b, _ := json.Marshal(v)
    return template.JS(b)
}

func templateDict(values ...interface{}) map[string]interface{} {
    if len(values)%2 != 0 {
        return nil
    }
    d := make(map[string]interface{}, len(values)/2)
    for i := 0; i < len(values); i += 2 {
        d[fmt.Sprint(values[i])] = values[i+1]
    }
    return d
}

func templateSlice(items ...interface{}) []interface{} {
    return items
}
```

### Template Example: base.html

```html
{{/* templates/base.html */}}
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{block "title" .}}Support Tools{{end}}</title>
    <link rel="stylesheet" href="{{assetURL "/static/css/app.css"}}">
    {{block "head" .}}{{end}}
</head>
<body>
    {{template "header.html" .}}
    {{template "nav.html" .}}
    <main class="content">
        {{block "content" .}}{{end}}
    </main>
    {{template "footer.html" .}}
    <script src="{{assetURL "/static/js/app.js"}}"></script>
    {{block "scripts" .}}{{end}}
</body>
</html>
```

## Versioned Static Asset Serving

### Content Hash-Based Asset URLs

Embedding static assets enables content-hash-based versioning — the hash of the file content is included in the URL, enabling aggressive browser caching with `Cache-Control: immutable`:

```go
// assets.go
package server

import (
    "crypto/sha256"
    "embed"
    "encoding/hex"
    "fmt"
    "io/fs"
    "mime"
    "net/http"
    "path/filepath"
    "strings"
    "sync"
    "time"
)

//go:embed static
var staticFilesFS embed.FS

// AssetManifest maps logical asset paths to versioned paths with content hashes.
type AssetManifest struct {
    mu       sync.RWMutex
    logical  map[string]string // "/static/css/app.css" -> "/static/css/app.abc123.css"
    hashed   map[string][]byte // "/static/css/app.abc123.css" -> content bytes
    etags    map[string]string // hashed path -> ETag value
}

var globalManifest *AssetManifest
var manifestOnce sync.Once

// BuildAssetManifest scans the embedded static filesystem and computes
// content hashes for all files, building the versioned URL manifest.
func BuildAssetManifest() (*AssetManifest, error) {
    m := &AssetManifest{
        logical: make(map[string]string),
        hashed:  make(map[string][]byte),
        etags:   make(map[string]string),
    }

    err := fs.WalkDir(staticFilesFS, "static", func(path string, d fs.DirEntry, err error) error {
        if err != nil || d.IsDir() {
            return err
        }

        content, err := staticFilesFS.ReadFile(path)
        if err != nil {
            return fmt.Errorf("reading %s: %w", path, err)
        }

        // Compute content hash
        h := sha256.Sum256(content)
        hashStr := hex.EncodeToString(h[:8]) // 16-char hex = 64-bit collision resistance

        // Construct versioned path
        // "/static/css/app.css" -> "/static/css/app.abc12345.css"
        logicalPath := "/" + path
        ext := filepath.Ext(path)
        base := strings.TrimSuffix(path, ext)
        hashedPath := fmt.Sprintf("/%s.%s%s", base, hashStr, ext)

        m.logical[logicalPath] = hashedPath
        m.hashed[hashedPath] = content
        m.etags[hashedPath] = fmt.Sprintf(`"%s"`, hashStr)

        return nil
    })
    if err != nil {
        return nil, err
    }

    return m, nil
}

// AssetURL returns the versioned URL for a logical asset path.
// Use this in templates to generate URLs with content hashes.
func AssetURL(logicalPath string) string {
    manifestOnce.Do(func() {
        var err error
        globalManifest, err = BuildAssetManifest()
        if err != nil {
            panic(fmt.Sprintf("failed to build asset manifest: %v", err))
        }
    })

    globalManifest.mu.RLock()
    versioned, ok := globalManifest.logical[logicalPath]
    globalManifest.mu.RUnlock()

    if !ok {
        return logicalPath // Fallback to logical path
    }
    return versioned
}

// StaticFileHandler serves embedded static files with proper caching headers.
func StaticFileHandler(m *AssetManifest) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        path := r.URL.Path

        m.mu.RLock()
        content, ok := m.hashed[path]
        etag, _ := m.etags[path]
        m.mu.RUnlock()

        if !ok {
            http.NotFound(w, r)
            return
        }

        // Check ETag for conditional requests
        if r.Header.Get("If-None-Match") == etag {
            w.WriteHeader(http.StatusNotModified)
            return
        }

        // Set caching headers for versioned (hashed) assets
        // Cache-Control: immutable tells browsers this URL will never change
        w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        w.Header().Set("ETag", etag)

        // Set correct Content-Type
        ext := filepath.Ext(path)
        contentType := mime.TypeByExtension(ext)
        if contentType == "" {
            contentType = "application/octet-stream"
        }
        w.Header().Set("Content-Type", contentType)

        http.ServeContent(w, r, path, time.Time{}, strings.NewReader(string(content)))
    })
}
```

### Registering Static and Template Handlers

```go
// main.go
package main

import (
    "log"
    "net/http"
    "os"

    "myapp/server"
)

func main() {
    isDev := os.Getenv("APP_ENV") == "development"

    // Build asset manifest (computes content hashes at startup)
    manifest, err := server.BuildAssetManifest()
    if err != nil {
        log.Fatalf("Failed to build asset manifest: %v", err)
    }

    // Initialize template manager
    // In dev mode: re-parses templates on each request for live reloading
    // In prod mode: parses once at startup for maximum performance
    tm, err := server.NewTemplateManager(isDev)
    if err != nil {
        log.Fatalf("Failed to initialize templates: %v", err)
    }

    mux := http.NewServeMux()

    // Static assets: versioned URLs with immutable caching
    mux.Handle("/static/", server.StaticFileHandler(manifest))

    // Application routes
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        data := map[string]interface{}{
            "Title":   "Dashboard",
            "Version": version,
        }
        if err := tm.Render(w, "index", data); err != nil {
            log.Printf("Template render error: %v", err)
            http.Error(w, "Internal Server Error", http.StatusInternalServerError)
        }
    })

    log.Println("Starting server on :8080")
    if err := http.ListenAndServe(":8080", mux); err != nil {
        log.Fatalf("Server error: %v", err)
    }
}
```

## Embedding Database Migrations

### Migration File Structure

```
db/
└── migrations/
    ├── 001_initial_schema.up.sql
    ├── 001_initial_schema.down.sql
    ├── 002_add_users_index.up.sql
    ├── 002_add_users_index.down.sql
    ├── 003_add_payment_tables.up.sql
    └── 003_add_payment_tables.down.sql
```

```go
// db/migrations.go
package db

import (
    "context"
    "database/sql"
    "embed"
    "fmt"
    "io/fs"
    "regexp"
    "sort"
    "strconv"
    "strings"
    "time"
)

//go:embed migrations
var migrationsFS embed.FS

// Migration represents a single database migration.
type Migration struct {
    Version    int
    Name       string
    UpSQL      string
    DownSQL    string
}

// MigrationRunner applies and tracks database migrations.
type MigrationRunner struct {
    db         *sql.DB
    migrations []Migration
}

var migrationFilePattern = regexp.MustCompile(`^(\d+)_(.+)\.(up|down)\.sql$`)

// NewMigrationRunner loads migrations from the embedded filesystem.
func NewMigrationRunner(db *sql.DB) (*MigrationRunner, error) {
    entries, err := fs.ReadDir(migrationsFS, "migrations")
    if err != nil {
        return nil, fmt.Errorf("reading migrations dir: %w", err)
    }

    // Collect up/down SQL for each version
    type migData struct {
        name string
        up   string
        down string
    }
    byVersion := make(map[int]*migData)

    for _, entry := range entries {
        if entry.IsDir() {
            continue
        }

        matches := migrationFilePattern.FindStringSubmatch(entry.Name())
        if matches == nil {
            continue
        }

        version, _ := strconv.Atoi(matches[1])
        name := matches[2]
        direction := matches[3]

        content, err := migrationsFS.ReadFile("migrations/" + entry.Name())
        if err != nil {
            return nil, fmt.Errorf("reading %s: %w", entry.Name(), err)
        }

        if byVersion[version] == nil {
            byVersion[version] = &migData{name: name}
        }

        switch direction {
        case "up":
            byVersion[version].up = string(content)
        case "down":
            byVersion[version].down = string(content)
        }
    }

    // Sort by version
    versions := make([]int, 0, len(byVersion))
    for v := range byVersion {
        versions = append(versions, v)
    }
    sort.Ints(versions)

    migrations := make([]Migration, 0, len(versions))
    for _, v := range versions {
        d := byVersion[v]
        migrations = append(migrations, Migration{
            Version: v,
            Name:    d.name,
            UpSQL:   d.up,
            DownSQL: d.down,
        })
    }

    return &MigrationRunner{db: db, migrations: migrations}, nil
}

// EnsureMigrationsTable creates the migrations tracking table if it doesn't exist.
func (mr *MigrationRunner) EnsureMigrationsTable(ctx context.Context) error {
    _, err := mr.db.ExecContext(ctx, `
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            applied_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            duration_ms INTEGER NOT NULL
        )
    `)
    return err
}

// CurrentVersion returns the highest applied migration version.
func (mr *MigrationRunner) CurrentVersion(ctx context.Context) (int, error) {
    var version sql.NullInt64
    err := mr.db.QueryRowContext(ctx,
        "SELECT MAX(version) FROM schema_migrations",
    ).Scan(&version)
    if err != nil {
        return 0, fmt.Errorf("querying current version: %w", err)
    }
    if !version.Valid {
        return 0, nil
    }
    return int(version.Int64), nil
}

// Up applies all migrations newer than the current version.
func (mr *MigrationRunner) Up(ctx context.Context) error {
    if err := mr.EnsureMigrationsTable(ctx); err != nil {
        return fmt.Errorf("ensuring migrations table: %w", err)
    }

    current, err := mr.CurrentVersion(ctx)
    if err != nil {
        return err
    }

    for _, m := range mr.migrations {
        if m.Version <= current {
            continue
        }

        start := time.Now()

        tx, err := mr.db.BeginTx(ctx, nil)
        if err != nil {
            return fmt.Errorf("beginning transaction for migration %d: %w", m.Version, err)
        }

        if _, err := tx.ExecContext(ctx, m.UpSQL); err != nil {
            tx.Rollback()
            return fmt.Errorf("applying migration %d (%s): %w", m.Version, m.Name, err)
        }

        duration := time.Since(start).Milliseconds()
        if _, err := tx.ExecContext(ctx,
            "INSERT INTO schema_migrations (version, name, applied_at, duration_ms) VALUES ($1, $2, NOW(), $3)",
            m.Version, m.Name, duration,
        ); err != nil {
            tx.Rollback()
            return fmt.Errorf("recording migration %d: %w", m.Version, err)
        }

        if err := tx.Commit(); err != nil {
            return fmt.Errorf("committing migration %d: %w", m.Version, err)
        }

        fmt.Printf("Applied migration %d/%s in %dms\n", m.Version, m.Name, duration)
    }

    return nil
}
```

## Embedding Configuration Files

### Multi-Environment Configuration

```go
// config/config.go
package config

import (
    "embed"
    "fmt"
    "os"
    "strings"

    "gopkg.in/yaml.v3"
)

//go:embed defaults.yaml environments
var configFS embed.FS

// Config holds the application configuration with layered defaults.
type Config struct {
    Server   ServerConfig   `yaml:"server"`
    Database DatabaseConfig `yaml:"database"`
    Cache    CacheConfig    `yaml:"cache"`
    Features FeatureFlags   `yaml:"features"`
}

type ServerConfig struct {
    Port         int    `yaml:"port"`
    ReadTimeout  string `yaml:"readTimeout"`
    WriteTimeout string `yaml:"writeTimeout"`
    TLSEnabled   bool   `yaml:"tlsEnabled"`
}

type DatabaseConfig struct {
    Host     string `yaml:"host"`
    Port     int    `yaml:"port"`
    Name     string `yaml:"name"`
    MaxConns int    `yaml:"maxConns"`
    SSLMode  string `yaml:"sslMode"`
}

type CacheConfig struct {
    TTL      string `yaml:"ttl"`
    MaxSize  int    `yaml:"maxSize"`
    Shards   int    `yaml:"shards"`
}

type FeatureFlags struct {
    EnableMetrics    bool `yaml:"enableMetrics"`
    EnableProfiling  bool `yaml:"enableProfiling"`
    EnableRatelimit  bool `yaml:"enableRatelimit"`
}

// LoadConfig loads configuration with the following precedence (lowest to highest):
// 1. Embedded defaults.yaml
// 2. Embedded environment-specific config (environments/<env>.yaml)
// 3. Environment variable overrides
func LoadConfig() (*Config, error) {
    // Start with embedded defaults
    defaults, err := configFS.ReadFile("defaults.yaml")
    if err != nil {
        return nil, fmt.Errorf("reading embedded defaults: %w", err)
    }

    var cfg Config
    if err := yaml.Unmarshal(defaults, &cfg); err != nil {
        return nil, fmt.Errorf("parsing defaults: %w", err)
    }

    // Overlay environment-specific config
    env := os.Getenv("APP_ENV")
    if env == "" {
        env = "development"
    }

    envConfigPath := fmt.Sprintf("environments/%s.yaml", env)
    envConfig, err := configFS.ReadFile(envConfigPath)
    if err == nil {
        // Environment config exists - overlay it
        if err := yaml.Unmarshal(envConfig, &cfg); err != nil {
            return nil, fmt.Errorf("parsing environment config for %s: %w", env, err)
        }
    }

    // Override with environment variables
    applyEnvOverrides(&cfg)

    return &cfg, nil
}

func applyEnvOverrides(cfg *Config) {
    if v := os.Getenv("APP_PORT"); v != "" {
        fmt.Sscan(v, &cfg.Server.Port)
    }
    if v := os.Getenv("DB_HOST"); v != "" {
        cfg.Database.Host = v
    }
    if v := os.Getenv("DB_NAME"); v != "" {
        cfg.Database.Name = v
    }
    if v := os.Getenv("DB_MAX_CONNS"); v != "" {
        fmt.Sscan(v, &cfg.Database.MaxConns)
    }
    if strings.ToLower(os.Getenv("ENABLE_METRICS")) == "true" {
        cfg.Features.EnableMetrics = true
    }
}
```

## Embedding Test Fixtures

### Reusable Test Data

```go
// testhelpers/fixtures.go
package testhelpers

import (
    "embed"
    "encoding/json"
    "io/fs"
    "path/filepath"
    "testing"
)

//go:embed fixtures
var fixturesFS embed.FS

// LoadFixture reads a test fixture file from the embedded filesystem.
func LoadFixture(t *testing.T, name string) []byte {
    t.Helper()

    content, err := fixturesFS.ReadFile(filepath.Join("fixtures", name))
    if err != nil {
        t.Fatalf("Failed to load fixture %s: %v", name, err)
    }
    return content
}

// LoadJSONFixture reads and unmarshals a JSON test fixture.
func LoadJSONFixture[T any](t *testing.T, name string) T {
    t.Helper()

    content := LoadFixture(t, name)
    var result T
    if err := json.Unmarshal(content, &result); err != nil {
        t.Fatalf("Failed to parse JSON fixture %s: %v", name, err)
    }
    return result
}

// ListFixtures returns all fixture files in a given subdirectory.
func ListFixtures(t *testing.T, subdir string) []string {
    t.Helper()

    dir := filepath.Join("fixtures", subdir)
    entries, err := fs.ReadDir(fixturesFS, dir)
    if err != nil {
        t.Fatalf("Failed to list fixtures in %s: %v", subdir, err)
    }

    var names []string
    for _, entry := range entries {
        if !entry.IsDir() {
            names = append(names, entry.Name())
        }
    }
    return names
}

// Example usage in tests:
func TestPaymentProcessing(t *testing.T) {
    type PaymentRequest struct {
        Amount   int    `json:"amount"`
        Currency string `json:"currency"`
        Method   string `json:"method"`
    }

    req := LoadJSONFixture[PaymentRequest](t, "payments/valid_card.json")
    // req.Amount = 9999, req.Currency = "USD", etc.
    _ = req
}
```

## Performance Considerations

### Memory Impact of Embedded Files

Embedded files are stored in the data segment of the binary and are mapped into memory when the program starts. For large asset sets, this has implications:

```go
// Measure the memory impact of your embedded assets
package main

import (
    "embed"
    "fmt"
    "io/fs"
    "runtime"
)

//go:embed static
var staticFS embed.FS

func measureEmbedMemory() {
    var before, after runtime.MemStats
    runtime.ReadMemStats(&before)

    // Force all embedded files to be accessed (triggering OS page mapping)
    var totalBytes int64
    fs.WalkDir(staticFS, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil || d.IsDir() {
            return err
        }
        content, _ := staticFS.ReadFile(path)
        totalBytes += int64(len(content))
        return nil
    })

    runtime.GC()
    runtime.ReadMemStats(&after)

    fmt.Printf("Embedded assets: %.2f MB\n", float64(totalBytes)/1024/1024)
    fmt.Printf("Heap increase: %.2f MB\n",
        float64(after.HeapAlloc-before.HeapAlloc)/1024/1024)
}
```

### When NOT to Use embed

```go
// Scenarios where embed is inappropriate:

// 1. Frequently changing content that requires hot-reload without rebuild
// Solution: use os.ReadFile with a filesystem path, configurable via env var

// 2. Content generated at build time (e.g., compiled CSS from SCSS)
// Solution: generate files before go build, then embed them
// In your Makefile:
// build: generate-assets
//     go build ./...
// generate-assets:
//     npx sass src/style.scss > static/css/app.css
//     npx esbuild src/app.ts --bundle --outfile=static/js/app.js

// 3. Very large binary assets (> 100 MB) in a service with constrained memory
// Solution: serve from object storage (S3, GCS) or a separate CDN origin

// 4. Files that differ between deployment environments (runtime config)
// Solution: use ConfigMaps in Kubernetes; embed only defaults
```

### Hybrid: Embedded Defaults with Runtime Overrides

```go
// hybrid_config.go
package config

import (
    "embed"
    "os"
)

//go:embed defaults
var defaultsFS embed.FS

// OpenConfigFile opens a config file, preferring a runtime path if provided.
// Falls back to the embedded default if the runtime file doesn't exist.
// This pattern lets Kubernetes ConfigMaps override embedded defaults.
func OpenConfigFile(name string) ([]byte, error) {
    // Check if a runtime override exists
    runtimePath := os.Getenv("CONFIG_DIR")
    if runtimePath != "" {
        path := filepath.Join(runtimePath, name)
        if content, err := os.ReadFile(path); err == nil {
            return content, nil
        }
    }

    // Fall back to embedded default
    return defaultsFS.ReadFile(filepath.Join("defaults", name))
}
```

## Key Takeaways

The `embed` package fundamentally changes the Go deployment model by enabling single-binary builds that carry all their dependencies. The key decisions that affect production outcomes are:

**Use `embed.FS` for directories; string/`[]byte` for single critical files**: `embed.FS` provides the full filesystem API needed for templates and asset directories. Reserve string and `[]byte` embeds for single-file scenarios like version strings, certificates, or default configurations.

**Content-hash-based versioned URLs are the correct static asset strategy**: Embedding assets makes content hashing trivial — compute the hash once at startup from the embedded bytes. The resulting versioned URLs enable `Cache-Control: immutable` with no server-side state or build pipeline configuration.

**Database migrations are an ideal embed use case**: Embedding migrations eliminates the "migration files not found" deployment failure mode and ensures the binary always carries exactly the migrations it expects. The version tracking table in the database provides the state management layer.

**Separate embedded defaults from runtime configuration**: Embed the defaults that every deployment needs, but always provide an override mechanism via environment variables or mounted ConfigMaps. This maintains the flexibility needed for multi-environment deployments without compromising the single-binary model.

**Be deliberate about binary size**: Every embedded file increases binary size. Audit your embedded assets, compress if appropriate (embed the compressed form and decompress on read), and consider CDN offloading for large media assets that don't benefit from co-location with the binary.
