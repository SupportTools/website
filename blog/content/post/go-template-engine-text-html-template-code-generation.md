---
title: "Go Template Engine: text/template and html/template for Code Generation"
date: 2031-04-21T00:00:00-05:00
draft: false
tags: ["Go", "Templates", "Code Generation", "Kubernetes", "DevOps", "Golang"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go's text/template and html/template packages for production code generation: template syntax, custom functions, template inheritance, auto-escaping, generating Kubernetes YAML and Go source code, and testing strategies."
more_link: "yes"
url: "/go-template-engine-text-html-template-code-generation/"
---

Go's standard library template packages are among the most underutilized tools in the DevOps engineer's toolkit. Beyond rendering HTML pages, `text/template` and `html/template` are the foundation of Helm charts, `kubectl` output formatting, `kubebuilder` scaffolding, and virtually every code generation tool in the Kubernetes ecosystem. Understanding how these packages work at a deep level unlocks the ability to build custom code generators, configuration renderers, and documentation systems that integrate cleanly with Go toolchains.

This guide covers the complete template lifecycle: syntax and data model, custom function registration, template composition with `define` and `block`, the critical security differences between `text/template` and `html/template`, practical code generation for Kubernetes manifests and Go source code, and a testing methodology that catches template regressions before they reach production.

<!--more-->

# Go Template Engine: text/template and html/template for Code Generation

## Section 1: Template Fundamentals and Data Model

### The Action Syntax

Go templates use double-brace delimiters `{{ }}` to distinguish template actions from literal text. Everything outside the delimiters is emitted verbatim.

```go
package main

import (
    "os"
    "text/template"
)

func main() {
    // The simplest possible template
    tmpl := template.Must(template.New("hello").Parse(
        "Hello, {{.Name}}! You have {{.Count}} messages.\n",
    ))

    data := struct {
        Name  string
        Count int
    }{
        Name:  "Alice",
        Count: 7,
    }

    tmpl.Execute(os.Stdout, data)
    // Output: Hello, Alice! You have 7 messages.
}
```

The dot (`.`) represents the current data value — the "cursor" of the template. It starts as the value passed to `Execute`, and is modified by range, with, and other actions.

### Navigation and Method Calls

```go
package main

import (
    "os"
    "strings"
    "text/template"
    "time"
)

type Service struct {
    Name      string
    Namespace string
    Labels    map[string]string
    CreatedAt time.Time
    Replicas  int
    Ports     []int
}

func (s Service) FQDN() string {
    return s.Name + "." + s.Namespace + ".svc.cluster.local"
}

func main() {
    const tmplText = `
Service: {{.Name}}
Namespace: {{.Namespace}}
FQDN: {{.FQDN}}
Created: {{.CreatedAt.Format "2006-01-02 15:04:05"}}
Replicas: {{.Replicas}}
Labels:
{{- range $key, $value := .Labels}}
  {{$key}}: {{$value}}
{{- end}}
Ports:
{{- range .Ports}}
  - {{.}}
{{- end}}
`

    tmpl := template.Must(template.New("service").Parse(tmplText))

    svc := Service{
        Name:      "api-server",
        Namespace: "production",
        Labels: map[string]string{
            "app":     "api-server",
            "version": "v2.1.0",
            "tier":    "backend",
        },
        CreatedAt: time.Date(2031, 1, 15, 10, 30, 0, 0, time.UTC),
        Replicas:  3,
        Ports:     []int{8080, 9090, 8443},
    }

    if err := tmpl.Execute(os.Stdout, svc); err != nil {
        panic(err)
    }
}
```

### Whitespace Control

The `-` modifier trims whitespace before or after an action. This is critical for generating clean YAML:

```go
const yamlTemplate = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{.Name}}
  namespace: {{.Namespace}}
data:
{{- range $k, $v := .Data}}
  {{$k}}: {{$v}}
{{- end}}
`
```

Without `-`, each `range` iteration would produce a leading newline. With `{{- range}}`, the newline before `range` is consumed, and `{{- end}}` consumes the newline after each value.

### Conditionals and Comparisons

```go
const deploymentTemplate = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{.Name}}
spec:
  replicas: {{.Replicas}}
  {{- if .AutoscalingEnabled}}
  # Replicas managed by HPA
  {{- end}}
  template:
    spec:
      {{- if .NodeSelector}}
      nodeSelector:
        {{- range $k, $v := .NodeSelector}}
        {{$k}}: {{$v}}
        {{- end}}
      {{- end}}
      containers:
      - name: {{.Name}}
        image: {{.Image}}
        {{- if gt .CPURequest 0}}
        resources:
          requests:
            cpu: {{.CPURequest}}m
            memory: {{.MemoryRequest}}Mi
          limits:
            cpu: {{.CPULimit}}m
            memory: {{.MemoryLimit}}Mi
        {{- end}}
        {{- if .EnvVars}}
        env:
        {{- range .EnvVars}}
        - name: {{.Name}}
          value: "{{.Value}}"
        {{- end}}
        {{- end}}
`
```

Built-in comparison functions: `eq`, `ne`, `lt`, `le`, `gt`, `ge`.
Boolean logic: `and`, `or`, `not`.

## Section 2: Variables and Pipelines

### Template Variables

Variables in Go templates are scoped to the block where they are declared:

```go
const varTemplate = `
{{- $total := 0}}
{{- $namespace := .Namespace}}
Services in {{$namespace}}:
{{- range .Services}}
  {{- $total = add $total 1}}
  {{.Name}} ({{.Replicas}} replicas)
{{- end}}
Total: {{$total}} services
`
```

Note: The `add` function is not built-in — you must register it as a custom function (covered in Section 3). The `$total = add $total 1` syntax reassigns an existing variable; `$total := 0` is declaration.

### Pipelines

Pipelines chain function calls using `|`, passing the result of the left side as the last argument of the right side:

```go
package main

import (
    "os"
    "strings"
    "text/template"
)

func main() {
    funcMap := template.FuncMap{
        "upper":  strings.ToUpper,
        "lower":  strings.ToLower,
        "title":  strings.Title,
        "trim":   strings.TrimSpace,
        "repeat": strings.Repeat,
        "join":   strings.Join,
        "split":  strings.Split,
        "hasPrefix": strings.HasPrefix,
        "hasSuffix": strings.HasSuffix,
        "contains":  strings.Contains,
        "replace":   strings.ReplaceAll,
        "printf":    fmt.Sprintf,
    }

    tmpl := template.Must(
        template.New("pipeline").
            Funcs(funcMap).
            Parse(`
Service name: {{"my-api-service" | upper}}
DNS name: {{"My Service Name" | lower | replace " " "-"}}
Label: {{printf "app=%s,version=%s" "api" "v1.0"}}
`))

    tmpl.Execute(os.Stdout, nil)
}
```

## Section 3: Custom Template Functions

Custom functions are registered before parsing via `template.FuncMap`. They can accept any number of arguments and must return either one value or a value plus an error.

### Registering a Comprehensive Function Map

```go
package template_helpers

import (
    "encoding/json"
    "fmt"
    "math"
    "reflect"
    "regexp"
    "sort"
    "strconv"
    "strings"
    "text/template"
    "time"
    "unicode"
)

// BuildFuncMap returns a FuncMap suitable for Kubernetes manifest generation.
func BuildFuncMap() template.FuncMap {
    return template.FuncMap{
        // String manipulation
        "upper":      strings.ToUpper,
        "lower":      strings.ToLower,
        "title":      strings.Title,
        "trim":       strings.TrimSpace,
        "trimPrefix": strings.TrimPrefix,
        "trimSuffix": strings.TrimSuffix,
        "replace":    strings.ReplaceAll,
        "contains":   strings.Contains,
        "hasPrefix":  strings.HasPrefix,
        "hasSuffix":  strings.HasSuffix,
        "split":      strings.Split,
        "join":       strings.Join,
        "repeat":     strings.Repeat,
        "quote":      strconv.Quote,
        "squote": func(s string) string {
            return "'" + s + "'"
        },
        "indent": func(spaces int, s string) string {
            pad := strings.Repeat(" ", spaces)
            return pad + strings.ReplaceAll(s, "\n", "\n"+pad)
        },
        "nindent": func(spaces int, s string) string {
            pad := strings.Repeat(" ", spaces)
            return "\n" + pad + strings.ReplaceAll(s, "\n", "\n"+pad)
        },
        "wrap": func(width int, s string) string {
            return wordWrap(s, width)
        },
        "camelCase":  toCamelCase,
        "snakeCase":  toSnakeCase,
        "kebabCase":  toKebabCase,
        "pascalCase": toPascalCase,

        // Math
        "add":  func(a, b int) int { return a + b },
        "sub":  func(a, b int) int { return a - b },
        "mul":  func(a, b int) int { return a * b },
        "div":  func(a, b int) int { return a / b },
        "mod":  func(a, b int) int { return a % b },
        "max":  func(a, b int) int { if a > b { return a }; return b },
        "min":  func(a, b int) int { if a < b { return a }; return b },
        "ceil": func(f float64) int { return int(math.Ceil(f)) },
        "floor": func(f float64) int { return int(math.Floor(f)) },

        // Collections
        "first": func(list interface{}) interface{} {
            v := reflect.ValueOf(list)
            if v.Len() == 0 {
                return nil
            }
            return v.Index(0).Interface()
        },
        "last": func(list interface{}) interface{} {
            v := reflect.ValueOf(list)
            if v.Len() == 0 {
                return nil
            }
            return v.Index(v.Len() - 1).Interface()
        },
        "len": func(v interface{}) int {
            return reflect.ValueOf(v).Len()
        },
        "append": func(list []interface{}, item interface{}) []interface{} {
            return append(list, item)
        },
        "prepend": func(item interface{}, list []interface{}) []interface{} {
            return append([]interface{}{item}, list...)
        },
        "reverse": func(list []interface{}) []interface{} {
            result := make([]interface{}, len(list))
            for i, v := range list {
                result[len(list)-1-i] = v
            }
            return result
        },
        "sortAlpha": func(list []string) []string {
            sorted := make([]string, len(list))
            copy(sorted, list)
            sort.Strings(sorted)
            return sorted
        },
        "uniq": func(list []string) []string {
            seen := make(map[string]bool)
            result := []string{}
            for _, s := range list {
                if !seen[s] {
                    seen[s] = true
                    result = append(result, s)
                }
            }
            return result
        },
        "hasKey": func(m map[string]interface{}, key string) bool {
            _, ok := m[key]
            return ok
        },
        "keys": func(m map[string]interface{}) []string {
            keys := make([]string, 0, len(m))
            for k := range m {
                keys = append(keys, k)
            }
            sort.Strings(keys)
            return keys
        },
        "values": func(m map[string]interface{}) []interface{} {
            vals := make([]interface{}, 0, len(m))
            for _, v := range m {
                vals = append(vals, v)
            }
            return vals
        },
        "merge": mergeMaps,
        "dict":  buildDict,

        // Encoding
        "toJSON": func(v interface{}) (string, error) {
            b, err := json.Marshal(v)
            return string(b), err
        },
        "toPrettyJSON": func(v interface{}) (string, error) {
            b, err := json.MarshalIndent(v, "", "  ")
            return string(b), err
        },
        "fromJSON": func(s string) (interface{}, error) {
            var v interface{}
            err := json.Unmarshal([]byte(s), &v)
            return v, err
        },
        "b64enc": func(s string) string {
            return base64.StdEncoding.EncodeToString([]byte(s))
        },
        "b64dec": func(s string) (string, error) {
            b, err := base64.StdEncoding.DecodeString(s)
            return string(b), err
        },

        // Type conversion
        "toString": fmt.Sprint,
        "toInt":    toInt,
        "toFloat":  toFloat,
        "toBool":   toBool,
        "default": func(defaultVal, val interface{}) interface{} {
            if isZero(val) {
                return defaultVal
            }
            return val
        },
        "empty": isZero,
        "coalesce": func(vals ...interface{}) interface{} {
            for _, v := range vals {
                if !isZero(v) {
                    return v
                }
            }
            return nil
        },
        "ternary": func(trueVal, falseVal interface{}, condition bool) interface{} {
            if condition {
                return trueVal
            }
            return falseVal
        },

        // Regex
        "regexMatch": func(pattern, s string) (bool, error) {
            return regexp.MatchString(pattern, s)
        },
        "regexFind": func(pattern, s string) string {
            re := regexp.MustCompile(pattern)
            return re.FindString(s)
        },
        "regexReplaceAll": func(pattern, repl, s string) string {
            re := regexp.MustCompile(pattern)
            return re.ReplaceAllString(s, repl)
        },

        // Date/time
        "now":          time.Now,
        "date":         func(fmt string, t time.Time) string { return t.Format(fmt) },
        "dateInZone":   dateInZone,
        "dateModify":   dateModify,
        "unixEpoch":    func(t time.Time) int64 { return t.Unix() },

        // Kubernetes-specific
        "toResourceName": toResourceName,
        "labelValue":     sanitizeLabelValue,
        "dnsLabel":       toDNSLabel,
    }
}

func toCamelCase(s string) string {
    parts := strings.FieldsFunc(s, func(r rune) bool {
        return r == '-' || r == '_' || r == ' '
    })
    for i := 1; i < len(parts); i++ {
        if len(parts[i]) > 0 {
            parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
        }
    }
    return strings.Join(parts, "")
}

func toSnakeCase(s string) string {
    var result strings.Builder
    for i, r := range s {
        if unicode.IsUpper(r) && i > 0 {
            result.WriteRune('_')
        }
        result.WriteRune(unicode.ToLower(r))
    }
    return strings.ReplaceAll(result.String(), "-", "_")
}

func toKebabCase(s string) string {
    return strings.ReplaceAll(toSnakeCase(s), "_", "-")
}

func toPascalCase(s string) string {
    camel := toCamelCase(s)
    if len(camel) == 0 {
        return camel
    }
    return strings.ToUpper(camel[:1]) + camel[1:]
}

func toResourceName(s string) string {
    // Convert to lowercase, replace non-alphanumeric with dash, trim dashes
    re := regexp.MustCompile(`[^a-z0-9]+`)
    result := re.ReplaceAllString(strings.ToLower(s), "-")
    return strings.Trim(result, "-")
}

func toDNSLabel(s string) string {
    label := toResourceName(s)
    if len(label) > 63 {
        label = label[:63]
        label = strings.TrimRight(label, "-")
    }
    return label
}

func sanitizeLabelValue(s string) string {
    re := regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
    result := re.ReplaceAllString(s, "_")
    if len(result) > 63 {
        result = result[:63]
    }
    return strings.Trim(result, "-._")
}

func isZero(v interface{}) bool {
    if v == nil {
        return true
    }
    val := reflect.ValueOf(v)
    switch val.Kind() {
    case reflect.String:
        return val.Len() == 0
    case reflect.Bool:
        return !val.Bool()
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        return val.Int() == 0
    case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
        return val.Uint() == 0
    case reflect.Float32, reflect.Float64:
        return val.Float() == 0
    case reflect.Slice, reflect.Map, reflect.Array:
        return val.Len() == 0
    case reflect.Ptr, reflect.Interface:
        return val.IsNil()
    }
    return false
}

func buildDict(values ...interface{}) (map[string]interface{}, error) {
    if len(values)%2 != 0 {
        return nil, fmt.Errorf("dict requires an even number of arguments")
    }
    dict := make(map[string]interface{}, len(values)/2)
    for i := 0; i < len(values); i += 2 {
        key, ok := values[i].(string)
        if !ok {
            return nil, fmt.Errorf("dict keys must be strings")
        }
        dict[key] = values[i+1]
    }
    return dict, nil
}

func mergeMaps(dst, src map[string]interface{}) map[string]interface{} {
    result := make(map[string]interface{})
    for k, v := range dst {
        result[k] = v
    }
    for k, v := range src {
        result[k] = v
    }
    return result
}
```

## Section 4: Template Inheritance with define and block

### Named Templates with define

The `define` action creates a named template that can be invoked from other templates:

```go
package main

import (
    "os"
    "text/template"
)

const masterTemplate = `
{{define "metadata"}}
metadata:
  name: {{.Name}}
  namespace: {{.Namespace}}
  labels:
    {{- range $k, $v := .Labels}}
    {{$k}}: {{$v}}
    {{- end}}
  annotations:
    generated-by: support.tools/generator
    generation-timestamp: {{.Timestamp}}
{{end}}

{{define "deployment"}}
apiVersion: apps/v1
kind: Deployment
{{template "metadata" .}}
spec:
  replicas: {{.Replicas}}
  selector:
    matchLabels:
      app: {{.Name}}
  template:
    {{template "metadata" .}}
    spec:
      containers:
      - name: {{.Name}}
        image: {{.Image}}
        ports:
        {{- range .Ports}}
        - containerPort: {{.}}
        {{- end}}
{{end}}

{{define "service"}}
apiVersion: v1
kind: Service
{{template "metadata" .}}
spec:
  selector:
    app: {{.Name}}
  ports:
  {{- range .Ports}}
  - port: {{.}}
    targetPort: {{.}}
  {{- end}}
  type: {{.ServiceType}}
{{end}}
`

func main() {
    tmpl := template.Must(template.New("k8s").Parse(masterTemplate))

    type AppConfig struct {
        Name        string
        Namespace   string
        Labels      map[string]string
        Timestamp   string
        Replicas    int
        Image       string
        Ports       []int
        ServiceType string
    }

    app := AppConfig{
        Name:      "api-gateway",
        Namespace: "production",
        Labels: map[string]string{
            "app":     "api-gateway",
            "team":    "platform",
            "version": "v3.2.1",
        },
        Timestamp: "2031-04-21T10:00:00Z",
        Replicas:  3,
        Image:     "registry.support.tools/api-gateway:v3.2.1",
        Ports:     []int{8080, 9090},
        ServiceType: "ClusterIP",
    }

    fmt.Println("--- Deployment ---")
    tmpl.ExecuteTemplate(os.Stdout, "deployment", app)

    fmt.Println("--- Service ---")
    tmpl.ExecuteTemplate(os.Stdout, "service", app)
}
```

### block for Overridable Defaults

The `block` action defines a template that can be overridden by child templates. This is the template inheritance pattern:

```go
package main

import (
    "os"
    "text/template"
)

// Base template with default blocks
const baseTemplate = `
{{define "base-deployment"}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{.Name}}
  namespace: {{.Namespace}}
spec:
  replicas: {{block "replicas" .}}{{.Replicas}}{{end}}
  selector:
    matchLabels:
      app: {{.Name}}
  template:
    metadata:
      labels:
        app: {{.Name}}
        {{block "extra-labels" .}}{{end}}
    spec:
      {{block "security-context" .}}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
      {{end}}
      containers:
      - name: {{.Name}}
        image: {{.Image}}
        {{block "resources" .}}
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        {{end}}
        {{block "extra-containers" .}}{{end}}
{{end}}
`

// Child template overrides specific blocks
const highMemTemplate = `
{{define "resources"}}
resources:
  requests:
    cpu: 500m
    memory: 4Gi
  limits:
    cpu: 2000m
    memory: 8Gi
{{end}}
{{define "replicas"}}5{{end}}
`

func main() {
    // Parse base template first
    tmpl := template.Must(template.New("base").Parse(baseTemplate))
    // Parse child template into same set — overrides blocks
    template.Must(tmpl.Parse(highMemTemplate))

    type Config struct {
        Name      string
        Namespace string
        Replicas  int
        Image     string
    }

    cfg := Config{
        Name:      "data-processor",
        Namespace: "analytics",
        Replicas:  3, // Will be overridden by highMemTemplate
        Image:     "registry.support.tools/data-processor:v2.0",
    }

    tmpl.ExecuteTemplate(os.Stdout, "base-deployment", cfg)
}
```

## Section 5: html/template Auto-Escaping and Security

### When to Use html/template

`html/template` wraps `text/template` and adds context-aware escaping. Use it whenever rendering content into HTML that may contain untrusted data. The package understands HTML, CSS, JavaScript, and URL contexts:

```go
package main

import (
    "html/template"
    "os"
)

func main() {
    tmpl := template.Must(template.New("page").Parse(`
<!DOCTYPE html>
<html>
<head>
  <title>{{.Title}}</title>
  <style>
    .container { color: {{.CSSColor}}; }
  </style>
</head>
<body>
  <h1>{{.Title}}</h1>
  <p>{{.UserInput}}</p>
  <a href="{{.URL}}">{{.LinkText}}</a>
  <script>
    var config = {{.JSONConfig}};
    var name = "{{.JSValue}}";
  </script>
</body>
</html>
`))

    data := struct {
        Title      string
        CSSColor   string
        UserInput  string
        URL        string
        LinkText   string
        JSONConfig template.JS
        JSValue    string
    }{
        Title:      "Dashboard",
        CSSColor:   "#ff0000",
        UserInput:  `<script>alert("xss")</script>`, // This will be escaped
        URL:        "/dashboard?user=alice&tab=metrics",
        LinkText:   "View Metrics",
        JSONConfig: template.JS(`{"debug": false, "timeout": 30}`),
        JSValue:    `"; alert("xss"); "`, // This will be JS-escaped
    }

    tmpl.Execute(os.Stdout, data)
}
```

`html/template` escapes `UserInput` to `&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;` and escapes `JSValue` to prevent JavaScript injection.

### Safe Type Markers

When you need to inject trusted HTML, CSS, JS, or URLs, use the safe type markers:

```go
import "html/template"

type PageData struct {
    TrustedHTML    template.HTML     // Won't be escaped
    TrustedCSS     template.CSS      // Won't be escaped in CSS context
    TrustedJS      template.JS       // Won't be escaped in JS context
    TrustedURL     template.URL      // Won't be escaped in URL context
    TrustedAttr    template.HTMLAttr // Won't be escaped in attribute context
    UntrustedInput string            // WILL be escaped
}
```

Use these only for values you control. Never cast user-provided input to safe types.

## Section 6: Generating Kubernetes YAML

### A Complete Kubernetes Manifest Generator

```go
// pkg/generator/kubernetes.go
package generator

import (
    "bytes"
    "encoding/base64"
    "fmt"
    "sort"
    "strings"
    "text/template"
)

// ManifestSet holds all generated Kubernetes manifests for an application.
type ManifestSet struct {
    Namespace   string
    Deployment  string
    Service     string
    ConfigMap   string
    Secret      string
    HPA         string
    Ingress     string
    ServiceAccount string
    RBAC        string
}

// AppConfig defines the complete configuration for a Kubernetes application.
type AppConfig struct {
    Name             string
    Namespace        string
    Image            string
    ImagePullPolicy  string
    Replicas         int
    ServiceType      string
    ServicePort      int
    ContainerPort    int
    MetricsPort      int
    ConfigData       map[string]string
    SecretData       map[string][]byte
    EnvVars          []EnvVar
    Labels           map[string]string
    Annotations      map[string]string
    NodeSelector     map[string]string
    Tolerations      []Toleration
    CPURequest       string
    CPULimit         string
    MemoryRequest    string
    MemoryLimit      string
    LivenessPath     string
    ReadinessPath    string
    MinReplicas      int
    MaxReplicas      int
    TargetCPUPercent int
    IngressHostname  string
    IngressTLSSecret string
    ServiceAccountName string
    CreateServiceAccount bool
}

type EnvVar struct {
    Name      string
    Value     string
    SecretRef string
    SecretKey string
    ConfigRef string
    ConfigKey string
}

type Toleration struct {
    Key      string
    Operator string
    Value    string
    Effect   string
}

const deploymentTmpl = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{.Name}}
  namespace: {{.Namespace}}
  labels:
    {{- range $k, $v := .Labels}}
    {{$k}}: {{$v | quote}}
    {{- end}}
  {{- if .Annotations}}
  annotations:
    {{- range $k, $v := .Annotations}}
    {{$k}}: {{$v | quote}}
    {{- end}}
  {{- end}}
spec:
  replicas: {{.Replicas}}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{.Name}}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        {{- range $k, $v := .Labels}}
        {{$k}}: {{$v | quote}}
        {{- end}}
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "{{.MetricsPort}}"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: {{.ServiceAccountName}}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
      {{- if .NodeSelector}}
      nodeSelector:
        {{- range $k, $v := .NodeSelector}}
        {{$k}}: {{$v | quote}}
        {{- end}}
      {{- end}}
      {{- if .Tolerations}}
      tolerations:
      {{- range .Tolerations}}
      - key: {{.Key | quote}}
        operator: {{.Operator}}
        {{- if .Value}}
        value: {{.Value | quote}}
        {{- end}}
        effect: {{.Effect}}
      {{- end}}
      {{- end}}
      terminationGracePeriodSeconds: 30
      containers:
      - name: {{.Name}}
        image: {{.Image}}
        imagePullPolicy: {{.ImagePullPolicy | default "IfNotPresent"}}
        ports:
        - name: http
          containerPort: {{.ContainerPort}}
          protocol: TCP
        - name: metrics
          containerPort: {{.MetricsPort}}
          protocol: TCP
        {{- if .EnvVars}}
        env:
        {{- range .EnvVars}}
        - name: {{.Name | quote}}
          {{- if .SecretRef}}
          valueFrom:
            secretKeyRef:
              name: {{.SecretRef | quote}}
              key: {{.SecretKey | quote}}
          {{- else if .ConfigRef}}
          valueFrom:
            configMapKeyRef:
              name: {{.ConfigRef | quote}}
              key: {{.ConfigKey | quote}}
          {{- else}}
          value: {{.Value | quote}}
          {{- end}}
        {{- end}}
        {{- end}}
        {{- if .ConfigData}}
        envFrom:
        - configMapRef:
            name: {{.Name}}-config
        {{- end}}
        resources:
          requests:
            cpu: {{.CPURequest | default "100m"}}
            memory: {{.MemoryRequest | default "128Mi"}}
          limits:
            cpu: {{.CPULimit | default "500m"}}
            memory: {{.MemoryLimit | default "512Mi"}}
        livenessProbe:
          httpGet:
            path: {{.LivenessPath | default "/healthz"}}
            port: http
          initialDelaySeconds: 15
          periodSeconds: 20
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: {{.ReadinessPath | default "/readyz"}}
            port: http
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 3
          failureThreshold: 3
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app.kubernetes.io/name: {{.Name}}
              topologyKey: kubernetes.io/hostname
`

const hpaTmpl = `{{- if gt .MaxReplicas .Replicas}}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{.Name}}
  namespace: {{.Namespace}}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{.Name}}
  minReplicas: {{.MinReplicas | default .Replicas}}
  maxReplicas: {{.MaxReplicas}}
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: {{.TargetCPUPercent | default 70}}
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 25
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
{{- end}}
`

// Generator creates Kubernetes manifests from templates.
type Generator struct {
    tmpl *template.Template
}

// New creates a new Generator with all templates parsed and functions registered.
func New() (*Generator, error) {
    funcMap := BuildFuncMap()

    tmpl, err := template.New("k8s").
        Funcs(funcMap).
        Parse(deploymentTmpl)
    if err != nil {
        return nil, fmt.Errorf("parsing deployment template: %w", err)
    }

    if _, err := tmpl.New("hpa").Parse(hpaTmpl); err != nil {
        return nil, fmt.Errorf("parsing HPA template: %w", err)
    }

    return &Generator{tmpl: tmpl}, nil
}

// Generate produces all Kubernetes manifests for the given config.
func (g *Generator) Generate(cfg AppConfig) (*ManifestSet, error) {
    ms := &ManifestSet{Namespace: cfg.Namespace}

    var buf bytes.Buffer

    if err := g.tmpl.ExecuteTemplate(&buf, "k8s", cfg); err != nil {
        return nil, fmt.Errorf("generating deployment: %w", err)
    }
    ms.Deployment = buf.String()
    buf.Reset()

    if err := g.tmpl.ExecuteTemplate(&buf, "hpa", cfg); err != nil {
        return nil, fmt.Errorf("generating HPA: %w", err)
    }
    ms.HPA = buf.String()

    return ms, nil
}
```

## Section 7: Generating Go Source Code

### A Go Source Code Generator

```go
// pkg/generator/gocode.go
package generator

import (
    "bytes"
    "go/format"
    "text/template"
)

const clientCodeTmpl = `// Code generated by support.tools/generator. DO NOT EDIT.

package {{.PackageName}}

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/go-resty/resty/v2"
)

// {{.ClientName}} is a generated client for the {{.ServiceName}} API.
type {{.ClientName}} struct {
    baseURL    string
    httpClient *resty.Client
    timeout    time.Duration
}

// New{{.ClientName}} creates a new {{.ClientName}} with the given base URL.
func New{{.ClientName}}(baseURL string, timeout time.Duration) *{{.ClientName}} {
    client := resty.New().
        SetBaseURL(baseURL).
        SetTimeout(timeout).
        SetHeader("Content-Type", "application/json").
        SetHeader("Accept", "application/json")

    return &{{.ClientName}}{
        baseURL:    baseURL,
        httpClient: client,
        timeout:    timeout,
    }
}
{{range .Methods}}
{{- if eq .HTTPMethod "GET"}}
// {{.Name}} calls GET {{.Path}}.
func (c *{{$.ClientName}}) {{.Name}}(ctx context.Context{{range .PathParams}}, {{.ParamName}} {{.ParamType}}{{end}}) (*{{.ResponseType}}, error) {
    var result {{.ResponseType}}
    path := fmt.Sprintf({{.PathFormat | printf "%q"}}, {{.PathParamNames | join ", "}})

    resp, err := c.httpClient.R().
        SetContext(ctx).
        SetResult(&result).
        Get(path)

    if err != nil {
        return nil, fmt.Errorf("{{$.ServiceName}}.{{.Name}}: %w", err)
    }
    if resp.StatusCode() != http.StatusOK {
        return nil, fmt.Errorf("{{$.ServiceName}}.{{.Name}}: unexpected status %d: %s", resp.StatusCode(), resp.String())
    }
    return &result, nil
}
{{- else if eq .HTTPMethod "POST"}}
// {{.Name}} calls POST {{.Path}}.
func (c *{{$.ClientName}}) {{.Name}}(ctx context.Context, req *{{.RequestType}}) (*{{.ResponseType}}, error) {
    var result {{.ResponseType}}

    resp, err := c.httpClient.R().
        SetContext(ctx).
        SetBody(req).
        SetResult(&result).
        Post({{.Path | printf "%q"}})

    if err != nil {
        return nil, fmt.Errorf("{{$.ServiceName}}.{{.Name}}: %w", err)
    }
    if resp.StatusCode() != http.StatusCreated && resp.StatusCode() != http.StatusOK {
        return nil, fmt.Errorf("{{$.ServiceName}}.{{.Name}}: unexpected status %d: %s", resp.StatusCode(), resp.String())
    }
    return &result, nil
}
{{- else if eq .HTTPMethod "DELETE"}}
// {{.Name}} calls DELETE {{.Path}}.
func (c *{{$.ClientName}}) {{.Name}}(ctx context.Context{{range .PathParams}}, {{.ParamName}} {{.ParamType}}{{end}}) error {
    path := fmt.Sprintf({{.PathFormat | printf "%q"}}, {{.PathParamNames | join ", "}})

    resp, err := c.httpClient.R().
        SetContext(ctx).
        Delete(path)

    if err != nil {
        return fmt.Errorf("{{$.ServiceName}}.{{.Name}}: %w", err)
    }
    if resp.StatusCode() != http.StatusNoContent && resp.StatusCode() != http.StatusOK {
        return fmt.Errorf("{{$.ServiceName}}.{{.Name}}: unexpected status %d: %s", resp.StatusCode(), resp.String())
    }
    return nil
}
{{- end}}
{{end}}
`

type ClientConfig struct {
    PackageName string
    ClientName  string
    ServiceName string
    Methods     []MethodConfig
}

type MethodConfig struct {
    Name           string
    HTTPMethod     string
    Path           string
    PathFormat     string
    PathParams     []PathParam
    PathParamNames []string
    RequestType    string
    ResponseType   string
}

type PathParam struct {
    ParamName string
    ParamType string
}

// GenerateGoClient generates a Go HTTP client from a ClientConfig.
// The generated code is formatted with gofmt.
func GenerateGoClient(cfg ClientConfig) (string, error) {
    funcMap := template.FuncMap{
        "join": strings.Join,
    }

    tmpl, err := template.New("client").Funcs(funcMap).Parse(clientCodeTmpl)
    if err != nil {
        return "", fmt.Errorf("parsing template: %w", err)
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, cfg); err != nil {
        return "", fmt.Errorf("executing template: %w", err)
    }

    // Format with gofmt
    formatted, err := format.Source(buf.Bytes())
    if err != nil {
        // Return unformatted code with the error for debugging
        return buf.String(), fmt.Errorf("formatting generated code: %w\n\nUnformatted output:\n%s", err, buf.String())
    }

    return string(formatted), nil
}
```

## Section 8: Testing Templates

### Unit Testing Template Output

```go
// pkg/generator/kubernetes_test.go
package generator_test

import (
    "strings"
    "testing"

    "gopkg.in/yaml.v3"

    "github.com/support-tools/generator/pkg/generator"
)

func TestDeploymentGeneration(t *testing.T) {
    gen, err := generator.New()
    if err != nil {
        t.Fatalf("creating generator: %v", err)
    }

    cfg := generator.AppConfig{
        Name:          "test-service",
        Namespace:     "test-ns",
        Image:         "registry.example.com/test-service:v1.0.0",
        Replicas:      2,
        ContainerPort: 8080,
        MetricsPort:   9090,
        ServicePort:   80,
        ServiceType:   "ClusterIP",
        CPURequest:    "100m",
        CPULimit:      "500m",
        MemoryRequest: "128Mi",
        MemoryLimit:   "512Mi",
        Labels: map[string]string{
            "app.kubernetes.io/name":       "test-service",
            "app.kubernetes.io/managed-by": "support.tools",
        },
        ServiceAccountName: "test-service",
        MaxReplicas:        5,
        TargetCPUPercent:   70,
    }

    ms, err := gen.Generate(cfg)
    if err != nil {
        t.Fatalf("generating manifests: %v", err)
    }

    t.Run("deployment is valid YAML", func(t *testing.T) {
        var doc interface{}
        if err := yaml.Unmarshal([]byte(ms.Deployment), &doc); err != nil {
            t.Errorf("deployment is not valid YAML: %v\n\nOutput:\n%s", err, ms.Deployment)
        }
    })

    t.Run("deployment contains expected fields", func(t *testing.T) {
        tests := []struct {
            name    string
            contain string
        }{
            {"name", "name: test-service"},
            {"namespace", "namespace: test-ns"},
            {"image", "image: registry.example.com/test-service:v1.0.0"},
            {"replicas", "replicas: 2"},
            {"container port", "containerPort: 8080"},
            {"metrics port", "containerPort: 9090"},
            {"cpu request", "cpu: 100m"},
            {"memory limit", "memory: 512Mi"},
        }

        for _, tt := range tests {
            t.Run(tt.name, func(t *testing.T) {
                if !strings.Contains(ms.Deployment, tt.contain) {
                    t.Errorf("deployment missing %q\n\nFull output:\n%s", tt.contain, ms.Deployment)
                }
            })
        }
    })

    t.Run("HPA is generated when MaxReplicas > Replicas", func(t *testing.T) {
        if ms.HPA == "" {
            t.Error("expected HPA to be generated")
        }
        if !strings.Contains(ms.HPA, "maxReplicas: 5") {
            t.Errorf("HPA missing maxReplicas: 5\n\nHPA:\n%s", ms.HPA)
        }
    })

    t.Run("HPA is not generated when MaxReplicas <= Replicas", func(t *testing.T) {
        cfgNoHPA := cfg
        cfgNoHPA.MaxReplicas = 0

        msNoHPA, err := gen.Generate(cfgNoHPA)
        if err != nil {
            t.Fatalf("generating manifests: %v", err)
        }

        if strings.TrimSpace(msNoHPA.HPA) != "" {
            t.Errorf("expected no HPA, got:\n%s", msNoHPA.HPA)
        }
    })
}

// TestGoldenFiles tests template output against golden files.
func TestDeploymentGoldenFile(t *testing.T) {
    gen, err := generator.New()
    if err != nil {
        t.Fatalf("creating generator: %v", err)
    }

    cfg := generator.AppConfig{
        Name:               "golden-service",
        Namespace:          "production",
        Image:              "registry.example.com/golden-service:v2.0.0",
        Replicas:           3,
        ContainerPort:      8080,
        MetricsPort:        9090,
        ServicePort:        80,
        ServiceType:        "ClusterIP",
        CPURequest:         "200m",
        CPULimit:           "1000m",
        MemoryRequest:      "256Mi",
        MemoryLimit:        "1Gi",
        ServiceAccountName: "golden-service",
        MaxReplicas:        10,
        MinReplicas:        3,
        TargetCPUPercent:   70,
        Labels: map[string]string{
            "app.kubernetes.io/name": "golden-service",
        },
    }

    ms, err := gen.Generate(cfg)
    if err != nil {
        t.Fatalf("generating manifests: %v", err)
    }

    // Use testdata/golden/ directory for golden files
    goldenPath := "testdata/golden/golden-service-deployment.yaml"
    if *update {
        // Run with -update flag to regenerate golden files
        os.WriteFile(goldenPath, []byte(ms.Deployment), 0644)
        return
    }

    expected, err := os.ReadFile(goldenPath)
    if err != nil {
        t.Fatalf("reading golden file %s: %v (run with -update to create)", goldenPath, err)
    }

    if string(expected) != ms.Deployment {
        t.Errorf("deployment does not match golden file\n\nDiff:\n%s",
            diff.Diff(string(expected), ms.Deployment))
    }
}

var update = flag.Bool("update", false, "update golden files")
```

### Testing Custom Functions

```go
func TestCustomFunctions(t *testing.T) {
    funcMap := generator.BuildFuncMap()

    tests := []struct {
        name     string
        template string
        data     interface{}
        expected string
    }{
        {
            name:     "upper",
            template: `{{upper .}}`,
            data:     "hello world",
            expected: "HELLO WORLD",
        },
        {
            name:     "camelCase",
            template: `{{camelCase .}}`,
            data:     "my-service-name",
            expected: "myServiceName",
        },
        {
            name:     "dnsLabel",
            template: `{{dnsLabel .}}`,
            data:     "My Service Name With Capitals",
            expected: "my-service-name-with-capitals",
        },
        {
            name:     "default",
            template: `{{default "fallback" .}}`,
            data:     "",
            expected: "fallback",
        },
        {
            name:     "ternary true",
            template: `{{ternary "yes" "no" .}}`,
            data:     true,
            expected: "yes",
        },
        {
            name:     "indent",
            template: `{{indent 4 .}}`,
            data:     "line1\nline2",
            expected: "    line1\n    line2",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            tmpl, err := template.New("test").Funcs(funcMap).Parse(tt.template)
            if err != nil {
                t.Fatalf("parsing template: %v", err)
            }

            var buf bytes.Buffer
            if err := tmpl.Execute(&buf, tt.data); err != nil {
                t.Fatalf("executing template: %v", err)
            }

            if buf.String() != tt.expected {
                t.Errorf("got %q, want %q", buf.String(), tt.expected)
            }
        })
    }
}
```

## Section 9: Production Patterns

### Error Handling and Template Validation

Never use `template.Must` in production paths where input is user-controlled:

```go
func ParseUserTemplate(input string) (*template.Template, error) {
    tmpl, err := template.New("user").
        Funcs(safeFuncMap()). // Only expose safe functions
        Parse(input)
    if err != nil {
        return nil, fmt.Errorf("invalid template syntax: %w", err)
    }

    // Perform a dry-run with zero values to catch runtime errors
    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, struct{}{}); err != nil {
        // Some errors are expected (missing fields on zero struct)
        // but syntax errors will be caught at Parse time
        _ = err
    }

    return tmpl, nil
}

// safeFuncMap returns a restricted function map for user-provided templates.
func safeFuncMap() template.FuncMap {
    return template.FuncMap{
        "upper":   strings.ToUpper,
        "lower":   strings.ToLower,
        "trim":    strings.TrimSpace,
        "default": func(d, v string) string { if v == "" { return d }; return v },
        // Explicitly do NOT include: exec, shell, file I/O functions
    }
}
```

### Caching Parsed Templates

Parsing templates is expensive — always cache them:

```go
type TemplateCache struct {
    mu      sync.RWMutex
    cache   map[string]*template.Template
    funcMap template.FuncMap
}

func NewTemplateCache() *TemplateCache {
    return &TemplateCache{
        cache:   make(map[string]*template.Template),
        funcMap: BuildFuncMap(),
    }
}

func (c *TemplateCache) Get(name, text string) (*template.Template, error) {
    c.mu.RLock()
    if tmpl, ok := c.cache[name]; ok {
        c.mu.RUnlock()
        return tmpl, nil
    }
    c.mu.RUnlock()

    c.mu.Lock()
    defer c.mu.Unlock()

    // Double-check after acquiring write lock
    if tmpl, ok := c.cache[name]; ok {
        return tmpl, nil
    }

    tmpl, err := template.New(name).Funcs(c.funcMap).Parse(text)
    if err != nil {
        return nil, err
    }

    c.cache[name] = tmpl
    return tmpl, nil
}
```

The Go template engine is a powerful foundation for any code generation or configuration rendering system. The patterns in this guide — custom function maps, template inheritance with `define`/`block`, golden file testing, and cached template pools — form the basis of production-quality template infrastructure that scales from single manifest generation to full GitOps configuration pipelines.
