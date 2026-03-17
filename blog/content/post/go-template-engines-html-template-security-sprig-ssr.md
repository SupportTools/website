---
title: "Go Template Engines: html/template Security, Sprig Functions, and Server-Side Rendering"
date: 2030-05-11T00:00:00-05:00
draft: false
tags: ["Go", "Templates", "html/template", "Security", "Sprig", "XSS", "Server-Side Rendering"]
categories: ["Go", "Web Development", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Go's html/template engine: contextual escaping for XSS prevention, Sprig template functions library, partial rendering patterns, and server-side rendering versus API-only architecture trade-offs."
more_link: "yes"
url: "/go-template-engines-html-template-security-sprig-ssr/"
---

Go's `html/template` package provides a security-first templating engine with contextual auto-escaping that prevents the most common class of web vulnerabilities by construction. Unlike `text/template` (which treats all output as plain text) or PHP-style templating (where forgetting to escape is the easy path), `html/template` understands HTML, CSS, JavaScript, and URL contexts — and applies the correct escaping for each automatically.

This guide covers the security model behind `html/template`'s contextual escaping, how to safely bypass escaping for trusted content, the Sprig function library for production templates, partial rendering patterns for HTMX and progressive enhancement, and the architectural trade-offs between server-side rendering and SPA/API approaches.

<!--more-->

## html/template vs text/template

### The Critical Difference

```go
package main

import (
    "html/template"
    "os"
    "text/template"
)

// With text/template: NO protection against XSS
func unsafeExample() {
    tmpl := texttemplate.Must(texttemplate.New("").Parse(`
        <p>Hello, {{.Name}}!</p>
        <script>var user = "{{.Username}}";</script>
    `))

    // This will output the raw string, enabling XSS:
    // <p>Hello, <script>alert(1)</script>!</p>
    tmpl.Execute(os.Stdout, map[string]string{
        "Name":     "<script>alert(1)</script>",
        "Username": `"; alert(1); var x = "`,
    })
}

// With html/template: AUTOMATIC contextual escaping
func safeExample() {
    tmpl := template.Must(template.New("").Parse(`
        <p>Hello, {{.Name}}!</p>
        <script>var user = "{{.Username}}";</script>
    `))

    // html/template knows the context and escapes correctly:
    // HTML context: <p>Hello, &lt;script&gt;alert(1)&lt;/script&gt;!</p>
    // JS string context: var user = "\"; alert(1); var x = \"";
    tmpl.Execute(os.Stdout, map[string]string{
        "Name":     "<script>alert(1)</script>",
        "Username": `"; alert(1); var x = "`,
    })
}
```

### Contextual Escaping Explained

`html/template` tracks the parser context and applies different escaping for each context:

```
Context Type          Escaping Applied
─────────────────────────────────────────────────────────────────────
HTML body             HTML entity encoding: < > & " '
HTML attribute value  HTML attribute escaping (quotes also escaped)
URL parameter         URL percent-encoding
JavaScript string     JS string escaping (\", \n, etc.)
JavaScript expression JSON-like escaping for values
CSS property value    CSS string escaping
```

```html
{{/* Template demonstrating multiple contexts */}}
<a href="/user?id={{.UserID}}"           {{/* URL context: /user?id=abc%3D123 */}}
   data-name="{{.Name}}"                 {{/* HTML attr context */}}
   onclick="selectUser('{{.UserID}}')">  {{/* JS string context within HTML attr */}}
    {{.Name}}                            {{/* HTML body context */}}
</a>

<style>
    .highlight { color: {{.Color}}; }    {{/* CSS context */}}
</style>

<script>
    var config = {
        userId: "{{.UserID}}",           {{/* JS string context */}}
        count:  {{.Count}},              {{/* JS value context (no quotes) */}}
    };
</script>
```

## Safe Bypass Mechanisms

### Trusting Content: type aliases

When you need to bypass escaping for content you explicitly control:

```go
package templates

import "html/template"

// Demonstrate the safe bypass types

// template.HTML: marks content as safe HTML
// Use ONLY for HTML you have generated or sanitized yourself
func SafeHTMLExample() template.HTML {
    // This is safe because you generated it, not from user input
    return template.HTML(`<strong>Bold text</strong>`)
}

// template.JS: marks content as safe JavaScript
// Use ONLY for JS literals you fully control
func SafeJSExample() template.JS {
    // Safe: integer literal, no user data
    return template.JS(`42`)
}

// template.CSS: marks content as safe CSS
func SafeCSSExample() template.CSS {
    return template.CSS(`color: #ff0000`)
}

// template.URL: marks content as a safe URL
// WARNING: only use for URLs you've validated as safe (e.g., starts with https://)
func SafeURLExample(u string) (template.URL, error) {
    if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "/") {
        return "", fmt.Errorf("unsafe URL scheme: %s", u)
    }
    return template.URL(u), nil
}

// template.HTMLAttr: safe HTML attribute (name=value pair)
func SafeAttrExample() template.HTMLAttr {
    return template.HTMLAttr(`class="user-avatar"`)
}
```

### HTML Sanitization for User Content

When you need to display user-provided HTML (e.g., a rich text editor), use a sanitizer rather than bypassing escaping entirely:

```go
package sanitize

import (
    "html/template"

    "github.com/microcosm-cc/bluemonday"
)

var (
    // Strict policy: only allows basic formatting
    strictPolicy *bluemonday.Policy
    // Rich policy: allows more HTML elements (tables, images from trusted sources)
    richPolicy *bluemonday.Policy
)

func init() {
    strictPolicy = bluemonday.StrictPolicy()
    strictPolicy.AllowElements("p", "br", "strong", "em", "ul", "ol", "li")
    strictPolicy.AllowAttrs("href").OnElements("a")
    strictPolicy.AllowURLSchemes("https", "mailto")

    richPolicy = bluemonday.NewPolicy()
    richPolicy.AllowStandardURLs()
    richPolicy.AllowElements("p", "br", "h1", "h2", "h3",
        "strong", "em", "ul", "ol", "li",
        "table", "thead", "tbody", "tr", "th", "td",
        "blockquote", "code", "pre")
    richPolicy.AllowAttrs("href").OnElements("a")
    richPolicy.AllowAttrs("src").OnElements("img")
    richPolicy.AllowAttrs("class").Globally()
}

// SanitizeStrict returns sanitized HTML safe for embedding in templates.
// Result should be used with template.HTML() to bypass escaping.
func SanitizeStrict(input string) template.HTML {
    sanitized := strictPolicy.Sanitize(input)
    return template.HTML(sanitized)
}

// SanitizeRich allows more HTML elements for trusted content (e.g., CMS).
func SanitizeRich(input string) template.HTML {
    sanitized := richPolicy.Sanitize(input)
    return template.HTML(sanitized)
}
```

## Template Function Maps

### Production FuncMap

```go
// funcmap.go
package templates

import (
    "encoding/json"
    "fmt"
    "html/template"
    "math"
    "strings"
    "time"
    "unicode/utf8"
)

// NewFuncMap returns a template.FuncMap with production-ready helper functions.
func NewFuncMap() template.FuncMap {
    return template.FuncMap{
        // === String functions ===
        "toLower":    strings.ToLower,
        "toUpper":    strings.ToUpper,
        "trimSpace":  strings.TrimSpace,
        "contains":   strings.Contains,
        "hasPrefix":  strings.HasPrefix,
        "hasSuffix":  strings.HasSuffix,
        "replace":    strings.ReplaceAll,
        "split":      strings.Split,
        "join":       strings.Join,
        "truncate":   truncate,
        "wordCount":  wordCount,
        "slugify":    slugify,

        // === Number functions ===
        "add":     func(a, b int) int { return a + b },
        "sub":     func(a, b int) int { return a - b },
        "mul":     func(a, b int) int { return a * b },
        "div":     func(a, b int) int { return a / b },
        "mod":     func(a, b int) int { return a % b },
        "percent": func(part, total float64) float64 {
            if total == 0 {
                return 0
            }
            return math.Round(part/total*10000) / 100
        },
        "humanBytes":   humanBytes,
        "humanNumber":  humanNumber,
        "formatFloat":  func(f float64, prec int) string {
            return fmt.Sprintf("%.*f", prec, f)
        },

        // === Time functions ===
        "now":           time.Now,
        "formatTime":    formatTime,
        "relativeTime":  relativeTime,
        "timeAgo":       timeAgo,
        "parseTime":     parseTime,

        // === Collection functions ===
        "dict":    makeDict,
        "list":    makeList,
        "first":   first,
        "last":    last,
        "length":  length,
        "reverse": reverse,

        // === Logic functions ===
        "and": func(a, b bool) bool { return a && b },
        "or":  func(a, b bool) bool { return a || b },
        "not": func(a bool) bool { return !a },
        "eq":  func(a, b interface{}) bool { return fmt.Sprint(a) == fmt.Sprint(b) },
        "ne":  func(a, b interface{}) bool { return fmt.Sprint(a) != fmt.Sprint(b) },
        "lt":  func(a, b int) bool { return a < b },
        "gt":  func(a, b int) bool { return a > b },
        "ternary": func(condition bool, trueVal, falseVal interface{}) interface{} {
            if condition {
                return trueVal
            }
            return falseVal
        },

        // === Safe HTML functions ===
        "safeHTML": func(s string) template.HTML { return template.HTML(s) },
        "safeURL":  func(s string) template.URL { return template.URL(s) },
        "safeJS":   func(s string) template.JS { return template.JS(s) },
        "toJSON": func(v interface{}) template.JS {
            b, err := json.Marshal(v)
            if err != nil {
                return template.JS("null")
            }
            return template.JS(b)
        },

        // === URL functions ===
        "queryEscape": url.QueryEscape,
        "pathEscape":  url.PathEscape,
    }
}

func truncate(s string, maxLen int) string {
    if utf8.RuneCountInString(s) <= maxLen {
        return s
    }
    runes := []rune(s)
    return string(runes[:maxLen-3]) + "..."
}

func wordCount(s string) int {
    return len(strings.Fields(s))
}

func slugify(s string) string {
    s = strings.ToLower(s)
    s = strings.Map(func(r rune) rune {
        if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
            return r
        }
        if r == ' ' || r == '-' || r == '_' {
            return '-'
        }
        return -1
    }, s)
    // Remove consecutive dashes
    for strings.Contains(s, "--") {
        s = strings.ReplaceAll(s, "--", "-")
    }
    return strings.Trim(s, "-")
}

func humanBytes(b int64) string {
    if b < 1024 {
        return fmt.Sprintf("%d B", b)
    }
    div, exp := int64(1024), 0
    for n := b / 1024; n >= 1024; n /= 1024 {
        div *= 1024
        exp++
    }
    return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func humanNumber(n int64) string {
    if n < 1000 {
        return fmt.Sprintf("%d", n)
    }
    if n < 1000000 {
        return fmt.Sprintf("%.1fK", float64(n)/1000)
    }
    return fmt.Sprintf("%.1fM", float64(n)/1000000)
}

func formatTime(t time.Time, layout string) string {
    if layout == "" {
        layout = "2006-01-02 15:04:05"
    }
    return t.Format(layout)
}

func timeAgo(t time.Time) string {
    since := time.Since(t)
    switch {
    case since < time.Minute:
        return "just now"
    case since < time.Hour:
        mins := int(since.Minutes())
        if mins == 1 {
            return "1 minute ago"
        }
        return fmt.Sprintf("%d minutes ago", mins)
    case since < 24*time.Hour:
        hours := int(since.Hours())
        if hours == 1 {
            return "1 hour ago"
        }
        return fmt.Sprintf("%d hours ago", hours)
    default:
        days := int(since.Hours() / 24)
        if days == 1 {
            return "yesterday"
        }
        return fmt.Sprintf("%d days ago", days)
    }
}

func makeDict(pairs ...interface{}) map[string]interface{} {
    d := make(map[string]interface{}, len(pairs)/2)
    for i := 0; i+1 < len(pairs); i += 2 {
        d[fmt.Sprint(pairs[i])] = pairs[i+1]
    }
    return d
}

func makeList(items ...interface{}) []interface{} {
    return items
}
```

## Sprig Template Functions

Sprig provides over 70 additional template functions compatible with Go's template system:

```go
// sprig_integration.go
package templates

import (
    "html/template"

    "github.com/Masterminds/sprig/v3"
)

// NewSprigFuncMap returns a FuncMap with all Sprig functions.
// Sprig functions are designed for text/template - we adapt them for html/template.
func NewSprigFuncMap() template.FuncMap {
    // Get all sprig functions (these are for text/template)
    sprigFuncs := sprig.TxtFuncMap()

    // Convert to html/template compatible FuncMap
    // Most functions are safe as-is since they don't output raw HTML
    result := make(template.FuncMap, len(sprigFuncs))
    for name, fn := range sprigFuncs {
        result[name] = fn
    }

    // Override functions that need html/template-specific types
    // (sprig's htmlSafe outputs template.HTML which is correct)

    return result
}

// Example template using Sprig functions:
var sprigExampleTemplate = `
{{/* String manipulation */}}
<p>{{.Name | upper | trimAll " "}}</p>
<p>{{.Description | trunc 100 | nospace}}</p>

{{/* Default values */}}
<p>{{.OptionalField | default "N/A"}}</p>

{{/* Date formatting (Sprig adds more format options) */}}
<time>{{.CreatedAt | date "Mon, 02 Jan 2006"}}</time>
<time>{{.CreatedAt | dateInZone "2006-01-02" "UTC"}}</time>

{{/* Math */}}
<p>Price: ${{.Price | float64 | mul 1.1 | round 2}}</p>

{{/* Collections */}}
{{$items := .Items | sortAlpha}}
{{range $i, $item := $items}}
    <li>{{add $i 1}}. {{$item}}</li>
{{end}}

{{/* Type conversion */}}
<script>
var count = {{.Count | int64 | toString | js}};
var enabled = {{.Enabled | ternary "true" "false" | js}};
</script>

{{/* Crypto (useful for cache-busting) */}}
<link rel="stylesheet" href="/style.css?v={{.Content | sha256sum | trunc 8}}">

{{/* UUID generation */}}
<div id="{{uuidv4}}">Dynamic content</div>
`
```

## Partial Rendering for HTMX

HTMX enables server-side rendering with dynamic updates by making targeted HTTP requests and replacing portions of the DOM:

```go
// htmx_handler.go
package handlers

import (
    "html/template"
    "net/http"
)

// isHTMXRequest detects if the request comes from HTMX.
func isHTMXRequest(r *http.Request) bool {
    return r.Header.Get("HX-Request") == "true"
}

// PartialRenderer wraps template rendering with HTMX-aware logic.
// Full page: renders the complete layout
// Partial request (HTMX): renders only the requested fragment
type PartialRenderer struct {
    tm *TemplateManager
}

func (pr *PartialRenderer) Render(
    w http.ResponseWriter,
    r *http.Request,
    data interface{},
    fullTemplate string,
    fragmentTemplate string,
) error {
    if isHTMXRequest(r) {
        // HTMX request: render only the fragment, no layout wrapping
        return pr.tm.RenderFragment(w, fragmentTemplate, data)
    }
    // Full page request: render complete layout
    return pr.tm.Render(w, fullTemplate, data)
}

// UserListHandler demonstrates the pattern
type UserListHandler struct {
    renderer *PartialRenderer
    users    UserService
}

func (h *UserListHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    page, _ := strconv.Atoi(r.URL.Query().Get("page"))
    if page < 1 {
        page = 1
    }

    users, total, err := h.users.List(r.Context(), page, 20)
    if err != nil {
        http.Error(w, "Internal Server Error", http.StatusInternalServerError)
        return
    }

    data := map[string]interface{}{
        "Users":       users,
        "CurrentPage": page,
        "TotalPages":  (total + 19) / 20,
        "TotalUsers":  total,
    }

    // For HTMX requests: return only the user-list fragment
    // For full requests: return the complete page with layout
    if err := h.renderer.Render(w, r, data, "users", "user-list-fragment"); err != nil {
        http.Error(w, "Template error", http.StatusInternalServerError)
    }
}
```

### Template Structure for HTMX

```html
{{/* templates/pages/users.html - Full page template */}}
{{define "content"}}
    <div class="page-header">
        <h1>Users</h1>
        <input type="search"
               name="q"
               hx-get="/users"
               hx-target="#user-list"
               hx-swap="innerHTML"
               hx-trigger="keyup changed delay:300ms"
               placeholder="Search users...">
    </div>

    {{/* The target div that HTMX updates */}}
    <div id="user-list">
        {{template "user-list-fragment" .}}
    </div>
{{end}}

{{/* templates/fragments/user-list-fragment.html */}}
{{define "user-list-fragment"}}
<table class="data-table">
    <thead>
        <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Created</th>
            <th>Actions</th>
        </tr>
    </thead>
    <tbody>
        {{range .Users}}
        <tr id="user-{{.ID}}">
            <td>{{.Name | html}}</td>
            <td>{{.Email}}</td>
            <td>{{.CreatedAt | timeAgo}}</td>
            <td>
                <button hx-delete="/users/{{.ID}}"
                        hx-target="#user-{{.ID}}"
                        hx-swap="outerHTML swap:500ms"
                        hx-confirm="Delete {{.Name}}?"
                        class="btn-danger">
                    Delete
                </button>
            </td>
        </tr>
        {{else}}
        <tr><td colspan="4" class="empty">No users found</td></tr>
        {{end}}
    </tbody>
</table>

{{/* Pagination controls */}}
{{if gt .TotalPages 1}}
<div class="pagination">
    {{if gt .CurrentPage 1}}
    <button hx-get="/users?page={{sub .CurrentPage 1}}"
            hx-target="#user-list"
            hx-swap="innerHTML">Previous</button>
    {{end}}

    <span>Page {{.CurrentPage}} of {{.TotalPages}} ({{.TotalUsers}} users)</span>

    {{if lt .CurrentPage .TotalPages}}
    <button hx-get="/users?page={{add .CurrentPage 1}}"
            hx-target="#user-list"
            hx-swap="innerHTML">Next</button>
    {{end}}
</div>
{{end}}
{{end}}
```

## Template Rendering Performance

### Template Caching and Pooling

```go
// renderer.go
package templates

import (
    "bytes"
    "html/template"
    "net/http"
    "sync"
)

// bufferedRenderer uses sync.Pool to reuse render buffers,
// reducing GC pressure in high-traffic scenarios.
type bufferedRenderer struct {
    pool *sync.Pool
}

func newBufferedRenderer() *bufferedRenderer {
    return &bufferedRenderer{
        pool: &sync.Pool{
            New: func() interface{} {
                return new(bytes.Buffer)
            },
        },
    }
}

// render executes the template into a buffer and writes to the ResponseWriter.
// Writing to a buffer first allows us to set the correct Content-Length header
// and avoid partial responses if the template fails mid-render.
func (r *bufferedRenderer) render(
    w http.ResponseWriter,
    tmpl *template.Template,
    data interface{},
) error {
    buf := r.pool.Get().(*bytes.Buffer)
    buf.Reset()
    defer r.pool.Put(buf)

    if err := tmpl.Execute(buf, data); err != nil {
        return err
    }

    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
    _, err := buf.WriteTo(w)
    return err
}

// TemplateCache pre-parses all templates at startup for production use.
// In development mode, templates can be re-parsed per request.
type TemplateCache struct {
    templates   map[string]*template.Template
    funcMap     template.FuncMap
    renderer    *bufferedRenderer
    mu          sync.RWMutex
    development bool
}

func NewTemplateCache(development bool) (*TemplateCache, error) {
    tc := &TemplateCache{
        templates:   make(map[string]*template.Template),
        funcMap:     BuildFuncMap(),
        renderer:    newBufferedRenderer(),
        development: development,
    }

    if !development {
        if err := tc.parseAll(); err != nil {
            return nil, err
        }
    }

    return tc, nil
}

func (tc *TemplateCache) BuildFuncMap() template.FuncMap {
    fm := NewFuncMap()
    sprigFns := NewSprigFuncMap()
    for k, v := range sprigFns {
        fm[k] = v
    }
    return fm
}

// Render renders a named template with data, using buffered output.
func (tc *TemplateCache) Render(w http.ResponseWriter, name string, data interface{}) error {
    if tc.development {
        tc.mu.Lock()
        defer tc.mu.Unlock()
        if err := tc.parseAll(); err != nil {
            return fmt.Errorf("parsing templates: %w", err)
        }
    }

    tc.mu.RLock()
    tmpl, ok := tc.templates[name]
    tc.mu.RUnlock()

    if !ok {
        return fmt.Errorf("template not found: %q", name)
    }

    return tc.renderer.render(w, tmpl, data)
}
```

## SSR vs API-Only Architecture

### Trade-off Analysis

```
Server-Side Rendering (Go html/template):

Advantages:
  + First Contentful Paint is faster (no JS bundle to download and parse)
  + Works without JavaScript (accessibility, corporate firewalls)
  + Simpler security model (no CORS, no JWT in localStorage)
  + Better SEO out of the box
  + Reduced client complexity
  + Type-safe template compilation (compile-time errors, not runtime)

Disadvantages:
  - Full page reloads for navigation (unless using HTMX/Turbo)
  - Server must generate HTML for every request (more compute)
  - Less rich interactivity without additional JavaScript
  - Session state ties users to server instances (use Redis for sessions)

API-Only (JSON + React/Vue/Angular frontend):

Advantages:
  + Rich, app-like interactivity
  + Client handles UI state (reduces server chattiness)
  + CDN-cacheable static frontend
  + Reusable API for mobile apps, third-party integrations

Disadvantages:
  - Larger initial load (JS bundles)
  - CORS configuration complexity
  - Authentication tokens in localStorage (XSS risk)
  - SEO requires SSR or pre-rendering for crawlability
  - Dual codebase (Go API + JavaScript frontend)

Hybrid (Go SSR + HTMX for dynamic parts):

Recommended for:
  - Internal tools and admin dashboards
  - Content-heavy sites with moderate interactivity
  - Teams comfortable with Go but limited JavaScript expertise
  - Applications where SEO and accessibility are critical
```

### Session Management for SSR

```go
// session.go - Secure session handling for SSR applications
package session

import (
    "crypto/rand"
    "encoding/base64"
    "net/http"
    "time"

    "github.com/redis/go-redis/v9"
)

const (
    sessionCookieName = "session_id"
    sessionTTL        = 24 * time.Hour
)

type Manager struct {
    redis *redis.Client
}

func NewManager(redis *redis.Client) *Manager {
    return &Manager{redis: redis}
}

// Create creates a new session and sets the session cookie.
func (m *Manager) Create(w http.ResponseWriter, data map[string]interface{}) (string, error) {
    // Generate a cryptographically random session ID
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", fmt.Errorf("generating session ID: %w", err)
    }
    sessionID := base64.URLEncoding.EncodeToString(b)

    // Store session data in Redis
    encoded, err := json.Marshal(data)
    if err != nil {
        return "", err
    }

    if err := m.redis.SetEx(context.Background(),
        "session:"+sessionID,
        encoded,
        sessionTTL,
    ).Err(); err != nil {
        return "", fmt.Errorf("storing session: %w", err)
    }

    // Set secure, HTTP-only cookie
    http.SetCookie(w, &http.Cookie{
        Name:     sessionCookieName,
        Value:    sessionID,
        Path:     "/",
        MaxAge:   int(sessionTTL.Seconds()),
        HttpOnly: true,  // Prevents JavaScript access (XSS protection)
        Secure:   true,  // Only sent over HTTPS
        SameSite: http.SameSiteStrictMode, // CSRF protection
    })

    return sessionID, nil
}

// Get retrieves session data for the current request.
func (m *Manager) Get(r *http.Request) (map[string]interface{}, error) {
    cookie, err := r.Cookie(sessionCookieName)
    if err != nil {
        return nil, nil // No session
    }

    data, err := m.redis.Get(r.Context(), "session:"+cookie.Value).Bytes()
    if err != nil {
        if err == redis.Nil {
            return nil, nil // Session expired
        }
        return nil, fmt.Errorf("fetching session: %w", err)
    }

    var result map[string]interface{}
    if err := json.Unmarshal(data, &result); err != nil {
        return nil, fmt.Errorf("decoding session: %w", err)
    }

    return result, nil
}
```

## Key Takeaways

Go's `html/template` provides a uniquely strong foundation for secure web applications through its context-aware automatic escaping. The key principles for production template systems built on it are:

**Never use `text/template` for HTML output**: The compile-time safety guarantee of `html/template` — contextual escaping by construction — is worth the slight additional complexity. A single misuse of `text/template` can introduce persistent XSS vulnerabilities.

**Use `template.HTML` and related types sparingly and explicitly**: The safe bypass types (`template.HTML`, `template.URL`, `template.JS`) are escape hatches, not the default path. Every use should be a deliberate decision with explicit sanitization via bluemonday or equivalent when user content is involved.

**Sprig extends templates without compromising security**: The Sprig library adds the missing template functions (date formatting, string manipulation, type conversion) that make Go templates competitive with Jinja2 and ERB without introducing security regressions.

**Buffer templates before writing to ResponseWriter**: Rendering to a `bytes.Buffer` first allows you to detect template errors before any bytes are written to the client, set correct `Content-Length` headers, and avoid sending partial HTML on errors.

**HTMX bridges the gap between SSR and SPA**: For applications that need dynamic updates without a full JavaScript framework, HTMX's pattern of server-rendered HTML fragments returned to targeted DOM elements provides excellent interactivity with minimal JavaScript complexity and full SSR security benefits.

**SSR with secure HTTP-only cookies is more secure than JWT in localStorage**: SPA-only architectures that store authentication tokens in localStorage are vulnerable to XSS token theft. Server-side sessions with HTTP-only cookies eliminate this attack vector entirely.
