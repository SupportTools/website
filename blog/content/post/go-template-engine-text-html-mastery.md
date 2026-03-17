---
title: "Go Template Engine: text/template and html/template Mastery"
date: 2029-04-30T00:00:00-05:00
draft: false
tags: ["Go", "Templates", "text/template", "html/template", "Helm", "Code Generation"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Go's text/template and html/template packages: template syntax, custom functions, nested templates, HTML auto-escaping, code generation, and Helm chart authoring patterns."
more_link: "yes"
url: "/go-template-engine-text-html-mastery/"
---

Go ships with two powerful template packages in its standard library: `text/template` for general-purpose text generation and `html/template` for safe HTML rendering. Understanding both packages deeply unlocks a wide range of production use cases — from generating Kubernetes manifests and Helm charts to building code generators and rendering dynamic HTML with automatic XSS protection. This guide covers the complete template engine from syntax fundamentals through advanced patterns used in real production systems.

<!--more-->

# Go Template Engine: text/template and html/template Mastery

## Package Overview

Both `text/template` and `html/template` share the same template language and API surface. The key difference is context-aware auto-escaping in `html/template`:

| Feature | text/template | html/template |
|---|---|---|
| Template syntax | Identical | Identical |
| HTML auto-escaping | None | Automatic, context-aware |
| JS auto-escaping | None | Automatic |
| CSS auto-escaping | None | Automatic |
| URL sanitization | None | Automatic |
| Use case | Config files, code gen, Helm | Web pages, email HTML |

```go
import (
    "text/template"   // General-purpose
    "html/template"   // Web/HTML output
)
```

## Template Syntax Fundamentals

### Delimiters

Templates use `{{` and `}}` as default delimiters. Everything outside delimiters is literal text.

```
Hello, {{.Name}}!
Today is {{.Date.Format "2006-01-02"}}.
```

### The Dot: Current Context

The dot (`.`) refers to the current data context. At the top level, it is the value passed to `Execute`. Inside `range` or `with`, it is rebound.

```go
type User struct {
    Name  string
    Email string
    Roles []string
}

tmpl := template.Must(template.New("user").Parse(`
User: {{.Name}} <{{.Email}}>
Roles:
{{- range .Roles}}
  - {{.}}
{{- end}}
`))

tmpl.Execute(os.Stdout, User{
    Name:  "Alice",
    Email: "alice@example.com",
    Roles: []string{"admin", "developer"},
})
```

Output:
```
User: Alice <alice@example.com>
Roles:
  - admin
  - developer
```

### Whitespace Control

The `-` after `{{` or before `}}` trims whitespace (including newlines) on that side:

```
{{- "no leading whitespace"}}
{{"no trailing whitespace" -}}
{{- "no whitespace on either side" -}}
```

This is critical for YAML and structured text generation where extra blank lines break the output.

### Variables

Declare variables with `$`:

```
{{$name := .User.Name}}
Hello, {{$name}}!

{{range $i, $role := .Roles}}
  {{$i}}: {{$role}}
{{end}}
```

The `$` variable retains the outer context's dot inside nested blocks:

```
{{$root := .}}
{{range .Items}}
  Item {{.Name}} belongs to {{$root.Owner}}
{{end}}
```

### Control Structures

**if/else/else if:**

```
{{if .IsAdmin}}
  Admin panel link: /admin
{{else if .IsModerator}}
  Mod panel link: /mod
{{else}}
  Regular user
{{end}}
```

**with (rebinds dot, skips block if zero value):**

```
{{with .Address}}
  City: {{.City}}, State: {{.State}}
{{else}}
  No address on file
{{end}}
```

**range over slice:**

```
{{range .Items}}
  - {{.Name}}: {{.Price}}
{{else}}
  No items available
{{end}}
```

**range over map (ordered Go 1.12+):**

```
{{range $key, $val := .Config}}
  {{$key}}: {{$val}}
{{end}}
```

### Pipelines

Pipelines chain values through functions using `|`:

```
{{.Name | upper | printf "Hello, %s!"}}
{{.Price | printf "%.2f" | printf "$%s"}}
{{.HTML | html}}
```

## Built-in Functions

Go templates include a small set of built-in functions:

```
and       -- logical AND (short-circuit)
call      -- call a function value
html      -- HTML-escape a string
index     -- index into a map/slice/array
slice     -- create a sub-slice
js        -- JavaScript-escape
len       -- length
not       -- logical NOT
or        -- logical OR (short-circuit)
print     -- fmt.Sprint
printf    -- fmt.Sprintf
println   -- fmt.Sprintln
urlquery  -- URL query-escape
eq ne lt le gt ge  -- comparison operators
```

```
{{if eq .Status "active"}}Active{{end}}
{{if gt .Count 0}}{{.Count}} items{{else}}Empty{{end}}
{{printf "%.2f" .Price}}
{{.Items | len}}
```

## Custom Functions

The `FuncMap` allows registering arbitrary Go functions:

```go
package main

import (
    "strings"
    "text/template"
    "time"
    "os"
)

func main() {
    funcMap := template.FuncMap{
        // String operations
        "upper":      strings.ToUpper,
        "lower":      strings.ToLower,
        "trim":       strings.TrimSpace,
        "trimPrefix": strings.TrimPrefix,
        "trimSuffix": strings.TrimSuffix,
        "contains":   strings.Contains,
        "replace":    strings.ReplaceAll,
        "split":      strings.Split,
        "join":       strings.Join,
        "repeat":     strings.Repeat,

        // Date/time
        "now": time.Now,
        "formatDate": func(t time.Time, layout string) string {
            return t.Format(layout)
        },
        "since": func(t time.Time) string {
            return time.Since(t).Round(time.Second).String()
        },

        // Math
        "add":  func(a, b int) int { return a + b },
        "sub":  func(a, b int) int { return a - b },
        "mul":  func(a, b int) int { return a * b },
        "div":  func(a, b int) int { return a / b },
        "mod":  func(a, b int) int { return a % b },

        // Slices/maps
        "first": func(s []interface{}) interface{} {
            if len(s) == 0 { return nil }
            return s[0]
        },
        "last": func(s []interface{}) interface{} {
            if len(s) == 0 { return nil }
            return s[len(s)-1]
        },
        "hasKey": func(m map[string]interface{}, key string) bool {
            _, ok := m[key]
            return ok
        },

        // Type conversion
        "toString": func(v interface{}) string {
            return fmt.Sprintf("%v", v)
        },
        "toInt": func(s string) (int, error) {
            return strconv.Atoi(s)
        },

        // Kubernetes-specific
        "toYaml": func(v interface{}) (string, error) {
            b, err := yaml.Marshal(v)
            return string(b), err
        },
        "fromYaml": func(s string) (interface{}, error) {
            var v interface{}
            return v, yaml.Unmarshal([]byte(s), &v)
        },
        "indent": func(spaces int, s string) string {
            pad := strings.Repeat(" ", spaces)
            return pad + strings.ReplaceAll(s, "\n", "\n"+pad)
        },
        "nindent": func(spaces int, s string) string {
            return "\n" + indent(spaces, s)
        },
        "quote": func(s string) string {
            return strconv.Quote(s)
        },
        "squote": func(s string) string {
            return "'" + strings.ReplaceAll(s, "'", "\\'") + "'"
        },
        "b64enc": func(s string) string {
            return base64.StdEncoding.EncodeToString([]byte(s))
        },
        "b64dec": func(s string) (string, error) {
            b, err := base64.StdEncoding.DecodeString(s)
            return string(b), err
        },
        "sha256sum": func(s string) string {
            h := sha256.Sum256([]byte(s))
            return fmt.Sprintf("%x", h)
        },
        "uuidv4": func() string {
            return uuid.New().String()
        },
        "default": func(def, val interface{}) interface{} {
            if val == nil || val == "" || val == 0 || val == false {
                return def
            }
            return val
        },
        "required": func(msg string, val interface{}) (interface{}, error) {
            if val == nil || val == "" {
                return nil, fmt.Errorf(msg)
            }
            return val, nil
        },
        "coalesce": func(vals ...interface{}) interface{} {
            for _, v := range vals {
                if v != nil && v != "" {
                    return v
                }
            }
            return nil
        },
    }

    tmpl := template.Must(
        template.New("main").Funcs(funcMap).ParseGlob("templates/*.tmpl"),
    )
    tmpl.Execute(os.Stdout, data)
}
```

## Nested Templates and Template Sets

### Defining Named Templates

Use `define` to create named sub-templates within a file:

```
{{define "header"}}
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>{{.Title}}</title>
</head>
<body>
{{end}}

{{define "footer"}}
</body>
</html>
{{end}}

{{define "nav"}}
<nav>
  {{range .NavItems}}
    <a href="{{.URL}}">{{.Label}}</a>
  {{end}}
</nav>
{{end}}
```

### Invoking Named Templates

```
{{template "header" .}}
{{template "nav" .}}
<main>
  {{block "content" .}}Default content{{end}}
</main>
{{template "footer" .}}
```

The `block` directive combines `define` and `template` — it provides a default implementation that child templates can override.

### Template Inheritance via ParseFiles

```go
// Parse base layout first, then page templates
base := template.Must(template.New("base").
    Funcs(funcMap).
    ParseFiles("templates/base.html"))

page := template.Must(
    template.Must(base.Clone()).
        ParseFiles("templates/pages/home.html"),
)

page.ExecuteTemplate(w, "base", data)
```

### Passing Data to Sub-templates

```
{{/* Pass a sub-struct to the template */}}
{{template "userCard" .CurrentUser}}

{{/* Pass a map literal */}}
{{template "badge" (dict "label" "Admin" "color" "red")}}

{{/* Pass a slice element */}}
{{range .Items}}
  {{template "listItem" .}}
{{end}}
```

The `dict` helper (common in Helm) creates a `map[string]interface{}`:

```go
"dict": func(values ...interface{}) (map[string]interface{}, error) {
    if len(values)%2 != 0 {
        return nil, fmt.Errorf("dict requires even number of arguments")
    }
    m := make(map[string]interface{}, len(values)/2)
    for i := 0; i < len(values); i += 2 {
        key, ok := values[i].(string)
        if !ok {
            return nil, fmt.Errorf("dict key must be a string")
        }
        m[key] = values[i+1]
    }
    return m, nil
},
```

## HTML Auto-Escaping in html/template

The `html/template` package understands HTML context and applies the correct escaping automatically:

```go
import "html/template"

tmpl := template.Must(template.New("page").Parse(`
<div class="{{.CSSClass}}">
  <a href="{{.URL}}">{{.Label}}</a>
  <script>var name = "{{.JSVar}}";</script>
</div>
`))
```

If `URL` contains `javascript:alert(1)`, `html/template` will sanitize it to `#ZgotmplZ` (a safe sentinel value). If `JSVar` contains `"; alert(1); //`, the JavaScript context escaper will handle it correctly.

### Bypassing Auto-Escaping (Use with Extreme Care)

When you own the content and know it is safe:

```go
import "html/template"

type PageData struct {
    SafeHTML   template.HTML     // Pre-sanitized HTML markup
    SafeURL    template.URL      // Validated URL
    SafeJS     template.JS       // Trusted JavaScript
    SafeAttr   template.HTMLAttr // Trusted attribute value
    SafeCSS    template.CSS      // Trusted CSS
}

data := PageData{
    SafeHTML: template.HTML("<strong>Bold</strong>"),
    SafeURL:  template.URL("https://example.com"),
}
```

Never cast user-controlled input to these types.

### Content Security

```go
// Sanitize user HTML before marking as safe
import "github.com/microcosm-cc/bluemonday"

policy := bluemonday.UGCPolicy()
sanitized := policy.Sanitize(userInput)
data.SafeHTML = template.HTML(sanitized)
```

## Code Generation with text/template

Code generation is one of the highest-value uses of `text/template`. Here's a complete example that generates type-safe enum types with stringer methods:

### Template for Enum Generation

```go
// File: cmd/gen-enums/main.go
package main

import (
    "flag"
    "go/format"
    "os"
    "text/template"
)

const enumTemplate = `// Code generated by gen-enums. DO NOT EDIT.

package {{.Package}}

import "fmt"

// {{.TypeName}} represents {{.Description}}.
type {{.TypeName}} int

const (
{{- range $i, $v := .Values}}
    {{if eq $i 0}}{{$.TypeName}}{{$v.Name}}{{else}}{{$.TypeName}}{{$v.Name}}{{end}} {{$.TypeName}} = {{$i}}
{{- end}}
)

var {{.TypeName | lower}}Names = map[{{.TypeName}}]string{
{{- range .Values}}
    {{$.TypeName}}{{.Name}}: "{{.Name}}",
{{- end}}
}

var {{.TypeName | lower}}Values = map[string]{{.TypeName}}{
{{- range .Values}}
    "{{.Name}}": {{$.TypeName}}{{.Name}},
{{- end}}
}

func (t {{.TypeName}}) String() string {
    if name, ok := {{.TypeName | lower}}Names[t]; ok {
        return name
    }
    return fmt.Sprintf("{{.TypeName}}(%d)", int(t))
}

func (t {{.TypeName}}) IsValid() bool {
    _, ok := {{.TypeName | lower}}Names[t]
    return ok
}

func Parse{{.TypeName}}(s string) ({{.TypeName}}, error) {
    if v, ok := {{.TypeName | lower}}Values[s]; ok {
        return v, nil
    }
    return 0, fmt.Errorf("unknown {{.TypeName}} value: %q", s)
}

func (t {{.TypeName}}) MarshalText() ([]byte, error) {
    return []byte(t.String()), nil
}

func (t *{{.TypeName}}) UnmarshalText(data []byte) error {
    v, err := Parse{{.TypeName}}(string(data))
    if err != nil {
        return err
    }
    *t = v
    return nil
}
`

type EnumValue struct {
    Name        string
    Description string
}

type EnumDef struct {
    Package     string
    TypeName    string
    Description string
    Values      []EnumValue
}

func main() {
    funcMap := template.FuncMap{
        "lower": strings.ToLower,
    }

    tmpl := template.Must(template.New("enum").Funcs(funcMap).Parse(enumTemplate))

    def := EnumDef{
        Package:     "status",
        TypeName:    "DeploymentStatus",
        Description: "the deployment lifecycle state",
        Values: []EnumValue{
            {Name: "Pending"},
            {Name: "Running"},
            {Name: "Succeeded"},
            {Name: "Failed"},
            {Name: "Unknown"},
        },
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, def); err != nil {
        log.Fatal(err)
    }

    // gofmt the output
    formatted, err := format.Source(buf.Bytes())
    if err != nil {
        // Write unformatted for debugging
        os.Stdout.Write(buf.Bytes())
        log.Fatalf("gofmt error: %v", err)
    }
    os.Stdout.Write(formatted)
}
```

## Helm Chart Authoring Patterns

Helm uses Sprig (a superset of Go template functions) along with a few Helm-specific built-ins. Understanding `text/template` mechanics is essential for effective Helm chart authoring.

### Values and Defaults

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "mychart.fullname" . }}
  labels:
    {{- include "mychart.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount | default 1 }}
  selector:
    matchLabels:
      {{- include "mychart.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      {{- with .Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      labels:
        {{- include "mychart.selectorLabels" . | nindent 8 }}
    spec:
      containers:
      - name: {{ .Chart.Name }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        imagePullPolicy: {{ .Values.image.pullPolicy | default "IfNotPresent" }}
        ports:
        - name: http
          containerPort: {{ .Values.service.port | default 8080 }}
          protocol: TCP
        {{- with .Values.resources }}
        resources:
          {{- toYaml . | nindent 10 }}
        {{- end }}
        {{- with .Values.env }}
        env:
          {{- range $key, $val := . }}
          - name: {{ $key }}
            value: {{ $val | quote }}
          {{- end }}
        {{- end }}
```

### Helper Templates in _helpers.tpl

```yaml
# templates/_helpers.tpl

{{/*
Expand the name of the chart.
*/}}
{{- define "mychart.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "mychart.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "mychart.labels" -}}
helm.sh/chart: {{ include "mychart.chart" . }}
{{ include "mychart.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "mychart.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mychart.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Generate a checksum annotation to trigger rolling updates on ConfigMap changes.
*/}}
{{- define "mychart.configChecksum" -}}
checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- end }}

{{/*
Render environment variables from a values key.
Usage: {{ include "mychart.envVars" (dict "env" .Values.env "envFrom" .Values.envFrom) }}
*/}}
{{- define "mychart.envVars" -}}
{{- with .env }}
env:
  {{- range $key, $value := . }}
  - name: {{ $key }}
    value: {{ $value | toString | quote }}
  {{- end }}
{{- end }}
{{- with .envFrom }}
envFrom:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}
```

### Conditional Resource Generation

```yaml
# templates/ingress.yaml
{{- if .Values.ingress.enabled -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "mychart.fullname" . }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- if .Values.ingress.className }}
  ingressClassName: {{ .Values.ingress.className }}
  {{- end }}
  {{- if .Values.ingress.tls }}
  tls:
    {{- range .Values.ingress.tls }}
    - hosts:
        {{- range .hosts }}
        - {{ . | quote }}
        {{- end }}
      secretName: {{ .secretName }}
    {{- end }}
  {{- end }}
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ .host | quote }}
      http:
        paths:
          {{- range .paths }}
          - path: {{ .path }}
            pathType: {{ .pathType | default "Prefix" }}
            backend:
              service:
                name: {{ include "mychart.fullname" $ }}
                port:
                  number: {{ $.Values.service.port }}
          {{- end }}
    {{- end }}
{{- end }}
```

### Range with Index for Numbered Resources

```yaml
{{- range $i, $worker := .Values.workers }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ printf "%s-worker-%d" (include "mychart.fullname" $) $i }}
spec:
  replicas: {{ $worker.replicas | default 1 }}
  template:
    spec:
      containers:
      - name: worker
        image: {{ $.Values.image.repository }}:{{ $.Values.image.tag }}
        args:
        - --queue={{ $worker.queue }}
        - --concurrency={{ $worker.concurrency | default 4 }}
{{- end }}
```

## Template Execution and Error Handling

### Safe Template Execution

```go
// ParseGlob with error handling
tmpl, err := template.New("root").
    Funcs(funcMap).
    Option("missingkey=error").    // Error on missing map keys
    ParseGlob("templates/**/*.tmpl")
if err != nil {
    return fmt.Errorf("parsing templates: %w", err)
}

// Execute to a buffer first to catch errors before writing response
var buf bytes.Buffer
if err := tmpl.ExecuteTemplate(&buf, "page.tmpl", data); err != nil {
    // Don't write partial output to http.ResponseWriter
    http.Error(w, "Template error", http.StatusInternalServerError)
    log.Printf("template error: %v", err)
    return
}

w.Header().Set("Content-Type", "text/html; charset=utf-8")
buf.WriteTo(w)
```

### Template Options

```go
// "missingkey=zero"  -- zero value for missing keys (default)
// "missingkey=error" -- error on missing keys
// "missingkey=default" -- same as zero
tmpl.Option("missingkey=error")
```

### Dynamic Template Loading

```go
type TemplateCache struct {
    mu        sync.RWMutex
    templates map[string]*template.Template
    funcMap   template.FuncMap
    dir       string
}

func (c *TemplateCache) Get(name string) (*template.Template, error) {
    c.mu.RLock()
    if tmpl, ok := c.templates[name]; ok {
        c.mu.RUnlock()
        return tmpl, nil
    }
    c.mu.RUnlock()

    c.mu.Lock()
    defer c.mu.Unlock()

    // Double-check
    if tmpl, ok := c.templates[name]; ok {
        return tmpl, nil
    }

    path := filepath.Join(c.dir, name)
    tmpl, err := template.New(name).Funcs(c.funcMap).ParseFiles(path)
    if err != nil {
        return nil, fmt.Errorf("parsing template %s: %w", name, err)
    }

    c.templates[name] = tmpl
    return tmpl, nil
}
```

## Testing Templates

```go
package templates_test

import (
    "bytes"
    "testing"
    "text/template"
)

func TestDeploymentTemplate(t *testing.T) {
    tmpl := template.Must(template.New("test").Funcs(helmFuncMap).ParseFiles(
        "../../templates/_helpers.tpl",
        "../../templates/deployment.yaml",
    ))

    tests := []struct {
        name     string
        values   map[string]interface{}
        contains []string
        notContains []string
    }{
        {
            name: "basic deployment",
            values: map[string]interface{}{
                "replicaCount": 3,
                "image": map[string]interface{}{
                    "repository": "nginx",
                    "tag":        "1.25",
                },
            },
            contains: []string{
                "replicas: 3",
                "image: nginx:1.25",
            },
        },
        {
            name: "default replica count",
            values: map[string]interface{}{},
            contains: []string{"replicas: 1"},
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            var buf bytes.Buffer
            err := tmpl.ExecuteTemplate(&buf, "deployment.yaml", helmData(tt.values))
            if err != nil {
                t.Fatalf("template execution failed: %v", err)
            }
            output := buf.String()
            for _, want := range tt.contains {
                if !strings.Contains(output, want) {
                    t.Errorf("expected output to contain %q\nGot:\n%s", want, output)
                }
            }
            for _, notWant := range tt.notContains {
                if strings.Contains(output, notWant) {
                    t.Errorf("expected output NOT to contain %q\nGot:\n%s", notWant, output)
                }
            }
        })
    }
}
```

## Performance Considerations

Templates are parsed once and executed many times. The parsing step is expensive; execution is fast.

```go
var (
    // Parse templates at startup, not per-request
    templates *template.Template
    once      sync.Once
)

func getTemplates() *template.Template {
    once.Do(func() {
        templates = template.Must(
            template.New("root").Funcs(funcMap).ParseGlob("templates/*.html"),
        )
    })
    return templates
}

// For development: reload templates on every request
func getTemplatesDev() *template.Template {
    return template.Must(
        template.New("root").Funcs(funcMap).ParseGlob("templates/*.html"),
    )
}
```

For hot reload in development without restarting the process, use `fsnotify` to watch the template directory and re-parse when files change.

## Summary

Go's template engine is deceptively powerful. The combination of `text/template` mechanics and `html/template` safety features, augmented with a rich `FuncMap`, supports everything from simple string interpolation to complex Helm chart authoring and production code generators. The key principles to internalize are: parse once and cache, use `missingkey=error` to catch data issues early, always execute to a buffer before writing to a response, and prefer composition via named sub-templates over monolithic template files.
