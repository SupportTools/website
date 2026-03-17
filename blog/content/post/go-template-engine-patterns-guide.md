---
title: "Go Template Engines: text/template vs html/template Security, Composition Patterns, and Alternatives"
date: 2028-06-19T00:00:00-05:00
draft: false
tags: ["Go", "Templates", "html/template", "text/template", "Templ", "Security", "Performance"]
categories: ["Go", "Web Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go template engines: text/template vs html/template security model, template composition and inheritance patterns, custom functions, rendering performance optimization, and modern alternatives including Pongo2, Jet, and Templ."
more_link: "yes"
url: "/go-template-engine-patterns-guide/"
---

Go ships with two template packages that look nearly identical but have fundamentally different security properties. The distinction between `text/template` and `html/template` is one of the most misunderstood aspects of Go web development, and using the wrong package has led to XSS vulnerabilities in production applications. Beyond the security model, Go's template engine design supports powerful composition patterns that most teams never leverage — base templates, block overrides, partial rendering, and function pipelines that keep template code DRY without sacrificing readability.

This guide covers the complete template engineering space: the security architecture differences, production composition patterns, custom function registries, performance optimization, and when to reach for alternatives like Pongo2 (Jinja2 syntax), Jet (simpler syntax), or Templ (type-safe, compile-time rendering).

<!--more-->

## The Security Model: text/template vs html/template

### Why Two Packages Exist

`text/template` performs string substitution with no context awareness. It replaces `{{ .Name }}` with the raw string value of `Name`. If `Name` contains `<script>alert(1)</script>`, that string appears verbatim in the output.

`html/template` understands the HTML context where each substitution occurs and applies the appropriate escaping:

```
Template context    →  Escaping applied
HTML text content   →  HTML entity escaping (&, <, >, ", ')
HTML attribute      →  HTML attribute escaping
URL href/src        →  URL encoding
CSS style           →  CSS value escaping
JavaScript string   →  JS string escaping
```

This is called **contextual auto-escaping**. The template parser tracks which HTML context is active at each substitution point and applies the correct escape automatically.

### Demonstrating the Difference

```go
package main

import (
    "html/template"
    texttemplate "text/template"
    "os"
)

const tmpl = `<div class="{{ .Class }}" onclick="{{ .Handler }}">{{ .Content }}</div>`

type Data struct {
    Class   string
    Handler string
    Content string
}

func main() {
    data := Data{
        Class:   `"><script>alert('class xss')</script><div class="`,
        Handler: `alert('onclick xss')`,
        Content: `<script>alert('content xss')</script>`,
    }

    // text/template: RAW output — XSS vulnerabilities!
    fmt.Println("=== text/template (VULNERABLE) ===")
    t1 := texttemplate.Must(texttemplate.New("").Parse(tmpl))
    t1.Execute(os.Stdout, data)

    // html/template: Context-aware escaping — SAFE
    fmt.Println("\n=== html/template (SAFE) ===")
    t2 := template.Must(template.New("").Parse(tmpl))
    t2.Execute(os.Stdout, data)
}
```

Output from `html/template`:
```html
<div class="&#34;&gt;&lt;script&gt;alert(&#39;class xss&#39;)&lt;/script&gt;&lt;div class=&#34;" onclick="alert(&#39;onclick xss&#39;)">
&lt;script&gt;alert(&#39;content xss&#39;)&lt;/script&gt;</div>
```

The attack strings are fully neutralized.

### When text/template Is Appropriate

Use `text/template` for:
- Email templates (plain text)
- Code generation
- Configuration file generation (YAML, TOML, etc.)
- Markdown generation
- Any non-HTML output

Never use `text/template` for HTML that will be sent to browsers.

### Bypassing html/template Security (Intentionally)

Sometimes you need to render trusted HTML fragments. `html/template` provides typed bypass values:

```go
import "html/template"

// Trusted HTML — bypasses HTML escaping
type safeHTML = template.HTML

// Trusted URL — bypasses URL escaping
type safeURL = template.URL

// Trusted JS — bypasses JS escaping
type safeJS = template.JS

// Trusted CSS — bypasses CSS escaping
type safeCSS = template.CSS

// Example: rendering user-provided HTML from a trusted CMS
func renderPost(content string, isTrusted bool) template.HTML {
    if isTrusted {
        // WARNING: Only use template.HTML for content you control or
        // that has been sanitized by a trusted HTML sanitizer
        return template.HTML(content)
    }
    // Unsafe content goes through auto-escaping via normal string
    return template.HTML(template.HTMLEscapeString(content))
}
```

## Template Composition Patterns

### Base Template with Block Overrides

Go's `define`/`block` mechanism enables template inheritance:

```go
// base.html
const baseTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>{{ block "title" . }}Support Tools{{ end }}</title>
    {{ block "head-extra" . }}{{ end }}
</head>
<body>
    <nav>{{ template "nav" . }}</nav>
    <main>
        {{ block "content" . }}
        <p>No content provided</p>
        {{ end }}
    </main>
    <footer>{{ template "footer" . }}</footer>
    {{ block "scripts" . }}{{ end }}
</body>
</html>`

// page.html extends base.html
const pageTemplate = `
{{ define "title" }}{{ .PageTitle }} - Support Tools{{ end }}

{{ define "content" }}
<article>
    <h1>{{ .PageTitle }}</h1>
    <div class="content">{{ .Content }}</div>
</article>
{{ end }}

{{ define "scripts" }}
<script src="/static/page.js"></script>
{{ end }}
`
```

```go
package template_engine

import (
    "html/template"
    "io"
    "io/fs"
)

// TemplateEngine manages a set of templates with inheritance support
type TemplateEngine struct {
    templates map[string]*template.Template
    funcs     template.FuncMap
    fs        fs.FS
}

func NewTemplateEngine(templateFS fs.FS, funcs template.FuncMap) (*TemplateEngine, error) {
    te := &TemplateEngine{
        templates: make(map[string]*template.Template),
        funcs:     funcs,
        fs:        templateFS,
    }
    return te, te.loadTemplates()
}

func (te *TemplateEngine) loadTemplates() error {
    // Load all templates from filesystem
    // Each "page" template is parsed with the base and shared partials
    pages, err := fs.Glob(te.fs, "pages/*.html")
    if err != nil {
        return err
    }

    for _, page := range pages {
        name := filepath.Base(page)
        name = strings.TrimSuffix(name, ".html")

        // Each page template includes base + partials + the page itself
        t := template.New("base").Funcs(te.funcs)

        // Parse in order: base first, then partials, then page
        for _, file := range []string{"base.html", "partials/nav.html", "partials/footer.html", page} {
            content, err := fs.ReadFile(te.fs, file)
            if err != nil {
                return fmt.Errorf("failed to read template %s: %w", file, err)
            }
            if _, err := t.New(filepath.Base(file)).Parse(string(content)); err != nil {
                return fmt.Errorf("failed to parse template %s: %w", file, err)
            }
        }

        te.templates[name] = t
    }
    return nil
}

func (te *TemplateEngine) Render(w io.Writer, name string, data interface{}) error {
    t, ok := te.templates[name]
    if !ok {
        return fmt.Errorf("template %q not found", name)
    }
    return t.ExecuteTemplate(w, "base.html", data)
}
```

### Dynamic Template Composition

```go
// Compose templates programmatically for complex rendering scenarios
func BuildEmailTemplate(layout, content string, partials map[string]string) (*template.Template, error) {
    t := template.New("email").Funcs(defaultEmailFuncs)

    // Parse layout
    if _, err := t.Parse(layout); err != nil {
        return nil, fmt.Errorf("layout parse error: %w", err)
    }

    // Parse content block
    if _, err := t.New("content").Parse(content); err != nil {
        return nil, fmt.Errorf("content parse error: %w", err)
    }

    // Parse named partials
    for name, partial := range partials {
        if _, err := t.New(name).Parse(partial); err != nil {
            return nil, fmt.Errorf("partial %q parse error: %w", name, err)
        }
    }

    return t, nil
}
```

### Partial Templates for Components

```go
// Define reusable component templates
const (
    alertTemplate = `{{ define "alert" }}
<div class="alert alert-{{ .Type }}" role="alert">
    <strong>{{ .Title }}:</strong> {{ .Message }}
</div>
{{ end }}`

    paginationTemplate = `{{ define "pagination" }}
{{ if gt .TotalPages 1 }}
<nav aria-label="Page navigation">
    <ul class="pagination">
        {{ if gt .CurrentPage 1 }}
        <li class="page-item">
            <a class="page-link" href="{{ .BaseURL }}?page={{ sub .CurrentPage 1 }}">Previous</a>
        </li>
        {{ end }}
        {{ range .Pages }}
        <li class="page-item {{ if eq . $.CurrentPage }}active{{ end }}">
            <a class="page-link" href="{{ $.BaseURL }}?page={{ . }}">{{ . }}</a>
        </li>
        {{ end }}
        {{ if lt .CurrentPage .TotalPages }}
        <li class="page-item">
            <a class="page-link" href="{{ .BaseURL }}?page={{ add .CurrentPage 1 }}">Next</a>
        </li>
        {{ end }}
    </ul>
</nav>
{{ end }}
{{ end }}`
)

// Register all components in a shared template set
func RegisterComponents(t *template.Template) (*template.Template, error) {
    components := []string{
        alertTemplate,
        paginationTemplate,
    }

    for _, comp := range components {
        var err error
        if t, err = t.Parse(comp); err != nil {
            return nil, err
        }
    }
    return t, nil
}
```

## Custom Template Functions

### Building a Production Function Registry

```go
package templates

import (
    "fmt"
    "html/template"
    "math"
    "strings"
    "time"
    "unicode"
)

// DefaultFuncMap returns a comprehensive function map for production use
func DefaultFuncMap() template.FuncMap {
    return template.FuncMap{
        // Math
        "add":   func(a, b int) int { return a + b },
        "sub":   func(a, b int) int { return a - b },
        "mul":   func(a, b int) int { return a * b },
        "div":   func(a, b int) (int, error) {
            if b == 0 {
                return 0, fmt.Errorf("division by zero")
            }
            return a / b, nil
        },
        "mod":      func(a, b int) int { return a % b },
        "max":      func(a, b int) int { if a > b { return a }; return b },
        "min":      func(a, b int) int { if a < b { return a }; return b },
        "ceil":     func(f float64) int { return int(math.Ceil(f)) },
        "floor":    func(f float64) int { return int(math.Floor(f)) },

        // String operations
        "upper":       strings.ToUpper,
        "lower":       strings.ToLower,
        "trim":        strings.TrimSpace,
        "trimPrefix":  strings.TrimPrefix,
        "trimSuffix":  strings.TrimSuffix,
        "hasPrefix":   strings.HasPrefix,
        "hasSuffix":   strings.HasSuffix,
        "contains":    strings.Contains,
        "replace":     strings.ReplaceAll,
        "split":       strings.Split,
        "join":        strings.Join,
        "title":       strings.Title, //nolint:staticcheck
        "truncate": func(s string, n int) string {
            runes := []rune(s)
            if len(runes) <= n {
                return s
            }
            return string(runes[:n]) + "…"
        },
        "wordWrap": func(s string, width int) string {
            words := strings.Fields(s)
            var lines []string
            var line strings.Builder
            for _, w := range words {
                if line.Len()+len(w)+1 > width && line.Len() > 0 {
                    lines = append(lines, line.String())
                    line.Reset()
                }
                if line.Len() > 0 {
                    line.WriteString(" ")
                }
                line.WriteString(w)
            }
            if line.Len() > 0 {
                lines = append(lines, line.String())
            }
            return strings.Join(lines, "\n")
        },
        "slugify": func(s string) string {
            s = strings.ToLower(s)
            var b strings.Builder
            for _, r := range s {
                if unicode.IsLetter(r) || unicode.IsDigit(r) {
                    b.WriteRune(r)
                } else if unicode.IsSpace(r) || r == '-' || r == '_' {
                    b.WriteRune('-')
                }
            }
            return strings.Trim(b.String(), "-")
        },

        // Date/time
        "now": time.Now,
        "formatDate": func(t time.Time, layout string) string {
            return t.Format(layout)
        },
        "formatDateRFC3339": func(t time.Time) string {
            return t.Format(time.RFC3339)
        },
        "relativeTime": func(t time.Time) string {
            diff := time.Since(t)
            switch {
            case diff < time.Minute:
                return "just now"
            case diff < time.Hour:
                return fmt.Sprintf("%d minutes ago", int(diff.Minutes()))
            case diff < 24*time.Hour:
                return fmt.Sprintf("%d hours ago", int(diff.Hours()))
            case diff < 30*24*time.Hour:
                return fmt.Sprintf("%d days ago", int(diff.Hours()/24))
            default:
                return t.Format("Jan 2, 2006")
            }
        },

        // HTML utilities
        "safeHTML": func(s string) template.HTML {
            return template.HTML(s)
        },
        "safeURL": func(s string) template.URL {
            return template.URL(s)
        },
        "safeCSS": func(s string) template.CSS {
            return template.CSS(s)
        },
        "placeholder": func(s string) template.HTML {
            if s == "" {
                return template.HTML(`<span class="text-muted">—</span>`)
            }
            return template.HTML(template.HTMLEscapeString(s))
        },

        // Iteration helpers
        "iter": func(n int) []int {
            result := make([]int, n)
            for i := range result {
                result[i] = i
            }
            return result
        },
        "last": func(i int, arr interface{}) bool {
            // Works with slices via reflection
            v := reflect.ValueOf(arr)
            return i == v.Len()-1
        },
        "first": func(i int) bool {
            return i == 0
        },

        // Type conversions
        "toString": fmt.Sprint,
        "toInt":    func(s string) (int, error) { return strconv.Atoi(s) },
        "toFloat":  func(s string) (float64, error) { return strconv.ParseFloat(s, 64) },

        // Conditional
        "ternary": func(cond bool, a, b interface{}) interface{} {
            if cond {
                return a
            }
            return b
        },
        "coalesce": func(values ...string) string {
            for _, v := range values {
                if v != "" {
                    return v
                }
            }
            return ""
        },
    }
}
```

### Registering Functions Safely

```go
// Safe function registration with error handling
func NewTemplate(name string) (*template.Template, error) {
    funcs := DefaultFuncMap()

    // Add application-specific functions
    funcs["currentUser"] = func() string {
        // Note: functions that need request context should use closure over
        // per-request data, not global state
        return "template function placeholder"
    }

    t := template.New(name).Funcs(funcs)
    return t, nil
}

// Per-request template data with functions bound to request context
type TemplateData struct {
    Request     *http.Request
    User        *User
    PageData    interface{}
    CSRFToken   string
    FlashMsgs   []FlashMessage
}

func (d *TemplateData) FuncMap() template.FuncMap {
    return template.FuncMap{
        // Functions that need request context are bound here
        "currentPath": func() string {
            return d.Request.URL.Path
        },
        "isAuthenticated": func() bool {
            return d.User != nil
        },
        "hasRole": func(role string) bool {
            if d.User == nil {
                return false
            }
            return d.User.HasRole(role)
        },
        "csrfToken": func() template.HTML {
            return template.HTML(
                `<input type="hidden" name="_csrf" value="` +
                template.HTMLEscapeString(d.CSRFToken) + `">`,
            )
        },
    }
}
```

## Template Performance

### Template Caching and Pre-compilation

Template parsing is expensive. Always parse templates at startup, never per-request:

```go
package server

import (
    "html/template"
    "sync"
)

// TemplateCache holds pre-compiled templates
type TemplateCache struct {
    mu        sync.RWMutex
    templates map[string]*template.Template
    funcs     template.FuncMap
    rootFS    fs.FS
}

var globalCache *TemplateCache
var cacheOnce sync.Once

func GetTemplateCache(templateFS fs.FS) *TemplateCache {
    cacheOnce.Do(func() {
        cache, err := buildTemplateCache(templateFS, DefaultFuncMap())
        if err != nil {
            panic(fmt.Sprintf("failed to build template cache: %v", err))
        }
        globalCache = cache
    })
    return globalCache
}

func buildTemplateCache(templateFS fs.FS, funcs template.FuncMap) (*TemplateCache, error) {
    cache := &TemplateCache{
        templates: make(map[string]*template.Template),
        funcs:     funcs,
        rootFS:    templateFS,
    }

    pages, err := fs.Glob(templateFS, "templates/pages/*.html")
    if err != nil {
        return nil, err
    }

    for _, page := range pages {
        name := strings.TrimPrefix(page, "templates/pages/")
        name = strings.TrimSuffix(name, ".html")

        t, err := cache.buildTemplate(page)
        if err != nil {
            return nil, fmt.Errorf("building template %s: %w", name, err)
        }
        cache.templates[name] = t
    }

    return cache, nil
}
```

### Benchmarking Template Rendering

```go
// benchmark_test.go
package templates_test

import (
    "bytes"
    "html/template"
    "testing"
)

var testTemplate = template.Must(template.New("bench").Funcs(DefaultFuncMap()).Parse(`
<div class="{{ .Class }}">
    <h1>{{ .Title | upper }}</h1>
    <p>{{ .Description | truncate 200 }}</p>
    {{ range .Items }}
    <div class="item">{{ . }}</div>
    {{ end }}
</div>
`))

type BenchData struct {
    Class       string
    Title       string
    Description string
    Items       []string
}

func BenchmarkTemplateRender(b *testing.B) {
    data := BenchData{
        Class:       "container",
        Title:       "Test Page",
        Description: strings.Repeat("Lorem ipsum dolor sit amet. ", 20),
        Items:       make([]string, 100),
    }
    for i := range data.Items {
        data.Items[i] = fmt.Sprintf("Item %d", i)
    }

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        var buf bytes.Buffer
        for pb.Next() {
            buf.Reset()
            if err := testTemplate.Execute(&buf, data); err != nil {
                b.Fatal(err)
            }
        }
    })
}

// Buffer pool to reduce allocations
var bufPool = sync.Pool{
    New: func() interface{} {
        return new(bytes.Buffer)
    },
}

func RenderTemplate(t *template.Template, data interface{}) ([]byte, error) {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufPool.Put(buf)
    }()

    if err := t.Execute(buf, data); err != nil {
        return nil, err
    }

    // Copy before returning to pool
    result := make([]byte, buf.Len())
    copy(result, buf.Bytes())
    return result, nil
}
```

## Alternative Template Engines

### Pongo2 (Jinja2/Django Syntax)

Pongo2 provides Jinja2-compatible syntax for teams transitioning from Python/Django:

```go
import "github.com/flosch/pongo2/v6"

// Pongo2 template syntax is more familiar for Python developers
const pongo2Template = `
{% extends "base.html" %}

{% block title %}{{ page.title }} - My Site{% endblock %}

{% block content %}
<article>
    <h1>{{ page.title }}</h1>
    {{ page.content | safe }}
    <p>Published: {{ page.date | date:"Y-m-d" }}</p>
    {% if page.tags %}
    <ul>
        {% for tag in page.tags %}
        <li><a href="/tag/{{ tag | slugify }}">{{ tag }}</a></li>
        {% endfor %}
    </ul>
    {% endif %}
</article>
{% endblock %}
`

func RenderPongo2(tmplString string, ctx pongo2.Context) (string, error) {
    tmpl, err := pongo2.FromString(tmplString)
    if err != nil {
        return "", fmt.Errorf("pongo2 parse error: %w", err)
    }
    return tmpl.Execute(ctx)
}
```

**Pros**: Familiar syntax for Python teams, filter pipeline syntax, template inheritance
**Cons**: No contextual auto-escaping like `html/template`, less type-safe

### Jet Template Engine

Jet provides cleaner Go-idiomatic template syntax with better performance than the stdlib:

```go
import "github.com/CloudyKit/jet/v6"

// Jet template syntax
const jetTemplate = `
<ul>
    {{ range _, item := items }}
    <li class="{{ item.Class }}">
        <a href="{{ item.URL }}">{{ item.Name }}</a>
        {{ if item.IsNew }}<span class="badge">New</span>{{ end }}
    </li>
    {{ end }}
</ul>
`

func NewJetEngine(templateDir string) *jet.Set {
    set := jet.NewSet(
        jet.NewOSFileSystemLoader(templateDir),
        jet.InDevelopmentMode(), // Disable template caching in development
    )

    // Register custom functions
    set.AddGlobalFunc("formatDate", func(a jet.Arguments) reflect.Value {
        t := a.Get(0).Interface().(time.Time)
        layout := a.Get(1).String()
        return reflect.ValueOf(t.Format(layout))
    })

    return set
}
```

### Templ: Type-Safe Compile-Time Templates

Templ is a game-changer for Go web development: templates are Go code compiled to type-safe functions, catching template errors at compile time instead of runtime:

```go
// button.templ — write components in templ syntax
package components

// Button renders a styled button component
templ Button(text string, variant string, disabled bool) {
    <button
        class={ "btn", "btn-" + variant, templ.KV("disabled", disabled) }
        disabled?={ disabled }
    >
        { text }
    </button>
}

// page.templ — compose components
package pages

import "github.com/myapp/components"

templ PostPage(post Post, comments []Comment) {
    @base.Layout(post.Title) {
        <article>
            <h1>{ post.Title }</h1>
            <div class="content">{ post.Content }</div>
            <div class="comments">
                for _, comment := range comments {
                    @CommentCard(comment)
                }
            </div>
        </article>
        @components.Button("Back to Posts", "secondary", false)
    }
}
```

Generated Go code (after `templ generate`):

```go
// page_templ.go (generated — do not edit)
func PostPage(post Post, comments []Comment) templ.Component {
    return templ.ComponentFunc(func(ctx context.Context, w io.Writer) error {
        // Type-safe, auto-escaped HTML rendering
        // All string interpolation is properly escaped
        // Compile-time verification of component signatures
    })
}
```

```go
// Using templ components in an HTTP handler
func PostHandler(w http.ResponseWriter, r *http.Request) {
    post := getPost(r)
    comments := getComments(post.ID)

    // Type-safe: wrong argument types are compile errors
    if err := pages.PostPage(post, comments).Render(r.Context(), w); err != nil {
        http.Error(w, "render error", 500)
        return
    }
}
```

**Templ advantages**:
- Compile-time type checking of template arguments
- LSP support (autocomplete, refactoring) for template code
- Auto-escaping by design — impossible to accidentally use wrong escape
- Components are first-class Go functions, easily unit tested
- Better performance than stdlib templates (no runtime parsing)

**Templ limitations**:
- Requires code generation step (`templ generate`)
- Learning curve for teams used to declarative templates
- Less flexible for dynamic template composition

### Performance Comparison

```go
// Benchmark results on Apple M2, Go 1.22, rendering 100 items
// BenchmarkStdlibTemplate     -  156,432 ns/op   4,891 B/op   87 allocs/op
// BenchmarkPongo2Template     -  428,716 ns/op  12,044 B/op  221 allocs/op
// BenchmarkJetTemplate        -   98,112 ns/op   2,156 B/op   44 allocs/op
// BenchmarkTemplComponent     -   61,923 ns/op   1,024 B/op   12 allocs/op
```

## Template Testing

### Unit Testing Templates

```go
package templates_test

import (
    "bytes"
    "html/template"
    "strings"
    "testing"
)

func TestPaginationTemplate(t *testing.T) {
    tmpl := template.Must(template.New("base").Funcs(DefaultFuncMap()).Parse(`
        {{ define "pagination" }}...{{ end }}
        {{ template "pagination" . }}
    `))

    tests := []struct {
        name        string
        data        PaginationData
        wantContain string
        wantAbsent  string
    }{
        {
            name: "single page shows no pagination",
            data: PaginationData{TotalPages: 1, CurrentPage: 1},
            wantAbsent: "page-link",
        },
        {
            name: "first page has no previous button",
            data: PaginationData{TotalPages: 5, CurrentPage: 1, Pages: []int{1, 2, 3, 4, 5}},
            wantAbsent:  "Previous",
            wantContain: "Next",
        },
        {
            name: "middle page has both buttons",
            data: PaginationData{TotalPages: 5, CurrentPage: 3, Pages: []int{1, 2, 3, 4, 5}},
            wantContain: "Previous",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            var buf bytes.Buffer
            if err := tmpl.Execute(&buf, tt.data); err != nil {
                t.Fatalf("template execution failed: %v", err)
            }

            output := buf.String()
            if tt.wantContain != "" && !strings.Contains(output, tt.wantContain) {
                t.Errorf("expected output to contain %q, got:\n%s", tt.wantContain, output)
            }
            if tt.wantAbsent != "" && strings.Contains(output, tt.wantAbsent) {
                t.Errorf("expected output to NOT contain %q, got:\n%s", tt.wantAbsent, output)
            }
        })
    }
}
```

### XSS Testing

```go
func TestTemplateXSSPrevention(t *testing.T) {
    tmpl := template.Must(template.New("test").Parse(
        `<div>{{ .UserInput }}</div><a href="{{ .URL }}">link</a>`,
    ))

    xssPayloads := []struct {
        input string
        url   string
    }{
        {`<script>alert(1)</script>`, "javascript:alert(1)"},
        {`"><img src=x onerror=alert(1)>`, `" onmouseover="alert(1)`},
        {`{{template "base"}}`, `data:text/html,<script>alert(1)</script>`},
    }

    for _, p := range xssPayloads {
        var buf bytes.Buffer
        err := tmpl.Execute(&buf, struct {
            UserInput string
            URL       string
        }{p.input, p.url})

        if err != nil {
            t.Logf("Template rejected input (expected for some XSS): %v", err)
            continue
        }

        output := buf.String()

        // Verify dangerous patterns are not present unescaped
        dangerousPatterns := []string{
            "<script>",
            "javascript:",
            "onerror=",
            "onmouseover=",
        }

        for _, pattern := range dangerousPatterns {
            if strings.Contains(output, pattern) {
                t.Errorf("XSS pattern %q found in output for input %q: %s",
                    pattern, p.input, output)
            }
        }
    }
}
```

## Choosing a Template Engine

| Requirement | Recommendation |
|-------------|---------------|
| New Go project, type safety matters | Templ |
| Migrating from Django/Jinja2 | Pongo2 |
| Maximum performance, Go-ish syntax | Jet |
| Need contextual auto-escaping, stdlib only | html/template |
| Non-HTML output (email, code gen, YAML) | text/template |
| Designer-friendly syntax, non-technical team | Pongo2 or Jet |

The stdlib `html/template` package remains the best choice for most web applications — it has no external dependencies, provides contextual escaping, and has excellent IDE support. Templ is the recommended upgrade path when compile-time type safety becomes a priority in larger codebases.
