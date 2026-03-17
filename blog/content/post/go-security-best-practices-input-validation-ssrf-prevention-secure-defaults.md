---
title: "Go Security Best Practices: Input Validation, SSRF Prevention, and Secure Defaults"
date: 2030-03-22T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Security", "SSRF", "Input Validation", "AppSec", "Secure Coding"]
categories: ["Go", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive Go security guide covering SSRF prevention with allowlist URL validation, safe os/exec usage, HTML template injection prevention, constant-time comparisons for secrets, and defense-in-depth patterns."
more_link: "yes"
url: "/go-security-best-practices-input-validation-ssrf-prevention-secure-defaults/"
---

Go's strong typing and memory safety eliminate entire classes of vulnerabilities that plague C and C++ code. But memory safety does not prevent business logic flaws, injection attacks, or server-side request forgery. A Go HTTP service can be just as vulnerable to SSRF as a PHP application if it blindly proxies user-supplied URLs. An HTML template rendered with `fmt.Sprintf` is as dangerous as `echo $user_input` in a shell script.

This guide covers the security vulnerabilities most commonly exploited in Go web services and the idiomatic patterns for preventing them: SSRF prevention with URL allowlists, safe command execution, template injection prevention, timing attack resistance, and the secure defaults that should be in every Go service from day one.

<!--more-->

## SSRF Prevention: Allowlist-Based URL Validation

Server-Side Request Forgery (SSRF) occurs when user-controlled input causes your server to make HTTP requests to unintended destinations. In cloud environments, this is critical because SSRF can exfiltrate cloud credentials from the metadata service (169.254.169.254).

### Vulnerable SSRF Pattern

```go
// VULNERABLE: Direct proxy of user-supplied URL
func ProxyURL(w http.ResponseWriter, r *http.Request) {
    targetURL := r.URL.Query().Get("url")  // User-controlled

    resp, err := http.Get(targetURL)  // SSRF vulnerability
    if err != nil {
        http.Error(w, "fetch failed", 500)
        return
    }
    defer resp.Body.Close()
    io.Copy(w, resp.Body)  // Attacker can read cloud metadata
}

// Attack: GET /proxy?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

### SSRF Defense: URL Validation with Allowlist

```go
// pkg/security/url_validator.go
package security

import (
    "fmt"
    "net"
    "net/url"
    "strings"
)

// URLValidationConfig defines what URLs are allowed
type URLValidationConfig struct {
    // AllowedHosts is the allowlist of permitted hostnames
    AllowedHosts []string
    // AllowedSchemes restricts to specific schemes
    AllowedSchemes []string
    // BlockedCIDRs prevents requests to private/internal networks
    BlockedCIDRs []*net.IPNet
    // MaxRedirects limits redirect following
    MaxRedirects int
    // RequireHTTPS forces HTTPS in production
    RequireHTTPS bool
}

// DefaultSecureConfig returns a restrictive default configuration
func DefaultSecureConfig() *URLValidationConfig {
    blockedCIDRs := []*net.IPNet{}

    // Block all RFC1918 private networks
    private := []string{
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        // Link-local (cloud metadata)
        "169.254.0.0/16",
        // Loopback
        "127.0.0.0/8",
        // IPv6 loopback
        "::1/128",
        // IPv6 link-local
        "fe80::/10",
        // IPv6 unique local
        "fc00::/7",
        // Cloud metadata addresses
        "100.64.0.0/10",  // CGN
    }

    for _, cidr := range private {
        _, network, err := net.ParseCIDR(cidr)
        if err != nil {
            panic(fmt.Sprintf("invalid CIDR %s: %v", cidr, err))
        }
        blockedCIDRs = append(blockedCIDRs, network)
    }

    return &URLValidationConfig{
        AllowedSchemes: []string{"https"},
        BlockedCIDRs:   blockedCIDRs,
        MaxRedirects:   3,
        RequireHTTPS:   true,
    }
}

// URLValidator validates URLs against the security policy
type URLValidator struct {
    config *URLValidationConfig
}

func NewURLValidator(config *URLValidationConfig) *URLValidator {
    return &URLValidator{config: config}
}

// Validate checks if a URL is safe to fetch
func (v *URLValidator) Validate(rawURL string) error {
    if rawURL == "" {
        return fmt.Errorf("URL is empty")
    }

    // Maximum URL length (prevent buffer issues)
    if len(rawURL) > 2048 {
        return fmt.Errorf("URL exceeds maximum length")
    }

    parsed, err := url.ParseRequestURI(rawURL)
    if err != nil {
        return fmt.Errorf("invalid URL: %w", err)
    }

    // Validate scheme
    if len(v.config.AllowedSchemes) > 0 {
        allowed := false
        for _, scheme := range v.config.AllowedSchemes {
            if strings.EqualFold(parsed.Scheme, scheme) {
                allowed = true
                break
            }
        }
        if !allowed {
            return fmt.Errorf("scheme %q is not allowed", parsed.Scheme)
        }
    }

    // Validate host against allowlist (if configured)
    hostname := parsed.Hostname()
    if len(v.config.AllowedHosts) > 0 {
        allowed := false
        for _, allowed_host := range v.config.AllowedHosts {
            if hostname == allowed_host || strings.HasSuffix(hostname, "."+allowed_host) {
                allowed = true
                break
            }
        }
        if !allowed {
            return fmt.Errorf("host %q is not in the allowlist", hostname)
        }
    }

    // Resolve hostname and check against blocked CIDRs
    if len(v.config.BlockedCIDRs) > 0 {
        ips, err := net.LookupHost(hostname)
        if err != nil {
            return fmt.Errorf("DNS resolution failed for %q: %w", hostname, err)
        }
        if len(ips) == 0 {
            return fmt.Errorf("no IP addresses found for %q", hostname)
        }

        for _, ipStr := range ips {
            ip := net.ParseIP(ipStr)
            if ip == nil {
                return fmt.Errorf("invalid IP address %q in DNS response", ipStr)
            }
            for _, blocked := range v.config.BlockedCIDRs {
                if blocked.Contains(ip) {
                    return fmt.Errorf("host %q resolves to blocked IP %s", hostname, ip)
                }
            }
        }
    }

    return nil
}

// SecureHTTPClient creates an HTTP client with SSRF protections
func SecureHTTPClient(config *URLValidationConfig) *http.Client {
    validator := NewURLValidator(config)

    transport := &http.Transport{
        DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
            // Additional check at connection time (before DNS rebinding attacks)
            host, _, err := net.SplitHostPort(addr)
            if err != nil {
                return nil, fmt.Errorf("invalid address: %w", err)
            }

            ip := net.ParseIP(host)
            if ip != nil {
                for _, blocked := range config.BlockedCIDRs {
                    if blocked.Contains(ip) {
                        return nil, fmt.Errorf("connection to %s blocked by security policy", addr)
                    }
                }
            }

            dialer := &net.Dialer{Timeout: 5 * time.Second}
            return dialer.DialContext(ctx, network, addr)
        },
        TLSHandshakeTimeout:   10 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second,
        IdleConnTimeout:       90 * time.Second,
        MaxIdleConns:          100,
        DisableKeepAlives:     false,
    }

    return &http.Client{
        Timeout:   30 * time.Second,
        Transport: transport,
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            if len(via) >= config.MaxRedirects {
                return fmt.Errorf("too many redirects (max: %d)", config.MaxRedirects)
            }
            // Re-validate redirect destination
            if err := validator.Validate(req.URL.String()); err != nil {
                return fmt.Errorf("redirect to unsafe URL: %w", err)
            }
            return nil
        },
    }
}

// Usage example
var secureClient = SecureHTTPClient(DefaultSecureConfig())

func FetchExternalResource(rawURL string) ([]byte, error) {
    validator := NewURLValidator(DefaultSecureConfig())
    if err := validator.Validate(rawURL); err != nil {
        return nil, fmt.Errorf("URL validation failed: %w", err)
    }

    resp, err := secureClient.Get(rawURL)
    if err != nil {
        return nil, fmt.Errorf("fetching URL: %w", err)
    }
    defer resp.Body.Close()

    // Limit response size (prevent resource exhaustion)
    const maxResponseSize = 10 * 1024 * 1024  // 10MB
    return io.ReadAll(io.LimitReader(resp.Body, maxResponseSize))
}
```

## Safe os/exec Usage

Command injection via `os/exec` is a critical vulnerability when user input flows into shell commands:

```go
// VULNERABLE: shell injection via bash -c
func ConvertImage(filename string) error {
    cmd := exec.Command("bash", "-c",
        fmt.Sprintf("convert %s output.jpg", filename))
    // filename = "; rm -rf / #"
    // This executes: convert ; rm -rf / # output.jpg
    return cmd.Run()
}

// ALSO VULNERABLE: /bin/sh -c with user input
func ProcessFile(path string) error {
    cmd := exec.Command("/bin/sh", "-c", "gzip "+path)
    return cmd.Run()
}
```

### Secure Command Execution

```go
// security/exec.go
package security

import (
    "context"
    "fmt"
    "os/exec"
    "path/filepath"
    "strings"
    "time"
)

// AllowedCommands is the allowlist of permitted executables
var AllowedCommands = map[string]string{
    "convert":   "/usr/bin/convert",   // ImageMagick
    "ffmpeg":    "/usr/bin/ffmpeg",
    "pdftotext": "/usr/bin/pdftotext",
}

// SecureExec executes a command with security constraints
// Arguments are passed as separate array elements, NEVER concatenated into a shell string
func SecureExec(ctx context.Context, command string, args ...string) ([]byte, error) {
    // Look up the full path from allowlist
    fullPath, ok := AllowedCommands[command]
    if !ok {
        return nil, fmt.Errorf("command %q is not allowed", command)
    }

    // Validate each argument
    for i, arg := range args {
        if err := validateArg(arg); err != nil {
            return nil, fmt.Errorf("invalid argument %d: %w", i, err)
        }
    }

    // Set a timeout on the context
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    // Execute with explicit path, no shell
    cmd := exec.CommandContext(ctx, fullPath, args...)

    // Set environment to minimal set (prevent env variable injection)
    cmd.Env = []string{
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "HOME=/tmp",
    }

    // Capture output
    output, err := cmd.Output()
    if err != nil {
        var exitErr *exec.ExitError
        if errors.As(err, &exitErr) {
            return nil, fmt.Errorf("command failed (exit %d): %s",
                exitErr.ExitCode(), string(exitErr.Stderr))
        }
        return nil, fmt.Errorf("executing command: %w", err)
    }

    return output, nil
}

func validateArg(arg string) error {
    // Reject null bytes
    if strings.ContainsRune(arg, '\x00') {
        return fmt.Errorf("null byte in argument")
    }

    // For file path arguments, validate they don't escape the working directory
    if strings.HasPrefix(arg, "/") || strings.Contains(arg, "..") {
        // Additional path validation for file arguments
        cleaned := filepath.Clean(arg)
        // Ensure path stays within allowed directory
        if !strings.HasPrefix(cleaned, "/allowed/base/") {
            return fmt.Errorf("path %q is outside allowed directory", arg)
        }
    }

    return nil
}

// ConvertImageSafe demonstrates safe command execution
func ConvertImageSafe(inputPath, outputPath string) error {
    // Validate paths independently
    if err := validateFilePath(inputPath); err != nil {
        return fmt.Errorf("invalid input path: %w", err)
    }
    if err := validateFilePath(outputPath); err != nil {
        return fmt.Errorf("invalid output path: %w", err)
    }

    // Each argument is a separate array element - NO shell interpretation
    _, err := SecureExec(context.Background(), "convert",
        inputPath,       // Input file
        "-resize", "800x600",
        "-quality", "85",
        outputPath,      // Output file
    )
    return err
}

func validateFilePath(path string) error {
    if path == "" {
        return fmt.Errorf("path is empty")
    }

    cleaned := filepath.Clean(path)

    // Prevent directory traversal
    if strings.Contains(cleaned, "..") {
        return fmt.Errorf("path traversal detected")
    }

    // Must be within allowed upload directory
    allowedBase := "/app/uploads"
    if !strings.HasPrefix(cleaned, allowedBase+"/") {
        return fmt.Errorf("path must be within %s", allowedBase)
    }

    // Check for dangerous characters
    for _, c := range path {
        if c < 32 || c == '|' || c == '&' || c == ';' || c == '$' ||
            c == '`' || c == '(' || c == ')' || c == '{' || c == '}' {
            return fmt.Errorf("dangerous character in path: %q", c)
        }
    }

    return nil
}
```

## HTML Template Injection Prevention

Go's `html/template` package is injection-safe, but many developers accidentally use `text/template` or bypass escaping:

```go
// VULNERABLE: text/template does NOT escape HTML
import "text/template"

func RenderProfile(w http.ResponseWriter, username string) {
    t := template.Must(template.New("").Parse(`
        <h1>Hello, {{.Username}}!</h1>
    `))
    // username = "<script>alert('xss')</script>"
    // Output: <h1>Hello, <script>alert('xss')</script>!</h1>  <- XSS!
    t.Execute(w, map[string]string{"Username": username})
}

// ALSO VULNERABLE: html/template with JS/CSS context
import "html/template"

func RenderPage(w http.ResponseWriter, data string) {
    t := template.Must(html_template.New("").Parse(`
        <script>var config = {data: "{{.}}"}</script>
    `))
    // data = '"}; alert(1); //'
    // html/template only escapes HTML contexts, not JS string contexts correctly
}
```

### Secure Template Usage

```go
// templates/secure.go
package templates

import (
    "html/template"
    "io"
    "net/url"
    "strings"
)

// SafeHTML marks a string as safe to embed in HTML without escaping
// Use ONLY when you are certain the content is safe
type SafeHTML = template.HTML

// SafeURL marks a URL as safe for href/src attributes
// Validates scheme before marking safe
func SafeURL(rawURL string) (template.URL, error) {
    parsed, err := url.ParseRequestURI(rawURL)
    if err != nil {
        return "", fmt.Errorf("invalid URL: %w", err)
    }

    // Only allow safe schemes
    switch strings.ToLower(parsed.Scheme) {
    case "https", "http", "mailto":
        return template.URL(rawURL), nil
    default:
        // Prevent javascript:, data:, vbscript:, etc.
        return "", fmt.Errorf("unsafe URL scheme: %s", parsed.Scheme)
    }
}

// TemplateRenderer provides secure template rendering
type TemplateRenderer struct {
    templates *template.Template
}

// NewTemplateRenderer creates a renderer with pre-compiled templates
func NewTemplateRenderer(pattern string) (*TemplateRenderer, error) {
    // Use html/template (NOT text/template) for all HTML output
    funcMap := template.FuncMap{
        // Custom functions that return pre-escaped content
        "safeURL": func(s string) (template.URL, error) {
            return SafeURL(s)
        },
        // JSON encoding for embedding in script tags
        "jsonEncode": func(v interface{}) (template.JS, error) {
            data, err := json.Marshal(v)
            if err != nil {
                return "", err
            }
            return template.JS(data), nil
        },
        // Truncate user input to prevent UI injection
        "truncate": func(s string, n int) string {
            if len(s) <= n {
                return s
            }
            return s[:n] + "..."
        },
    }

    t, err := template.New("").Funcs(funcMap).ParseGlob(pattern)
    if err != nil {
        return nil, fmt.Errorf("parsing templates: %w", err)
    }

    return &TemplateRenderer{templates: t}, nil
}

func (r *TemplateRenderer) Render(w io.Writer, name string, data interface{}) error {
    return r.templates.ExecuteTemplate(w, name, data)
}
```

```html
{{/* templates/profile.html - using html/template safe rendering */}}
{{define "profile"}}
<!DOCTYPE html>
<html>
<head>
    <title>Profile - {{.Username}}</title>
    <meta charset="utf-8">
    {{/* Content Security Policy prevents inline script execution */}}
</head>
<body>
    {{/* html/template auto-escapes: <script> becomes &lt;script&gt; */}}
    <h1>Hello, {{.Username}}!</h1>

    {{/* Safe URL with validation */}}
    {{if .ProfileURL}}
        {{with safeURL .ProfileURL}}
            <a href="{{.}}">Profile Link</a>
        {{end}}
    {{end}}

    {{/* JSON data for JavaScript: use jsonEncode, not Printf */}}
    <script>
        // html/template handles JS context correctly with template.JS type
        var userData = {{.UserData | jsonEncode}};
    </script>
</body>
</html>
{{end}}
```

## Constant-Time Comparisons for Secrets

Timing attacks exploit the fact that string comparison returns early when it finds a mismatch. An attacker can measure response times to determine how many characters of a secret are correct:

```go
// VULNERABLE: early-exit string comparison leaks timing information
func ValidateAPIKey(provided, expected string) bool {
    return provided == expected  // Returns immediately on first mismatch
}

// VULNERABLE: byte-by-byte comparison with early exit
func ValidateHMACInsecure(a, b []byte) bool {
    if len(a) != len(b) {
        return false  // Leaks length information
    }
    for i := range a {
        if a[i] != b[i] {
            return false  // Returns on first mismatch: timing leak
        }
    }
    return true
}
```

### Constant-Time Comparison Functions

```go
// security/crypto.go
package security

import (
    "crypto/hmac"
    "crypto/rand"
    "crypto/sha256"
    "crypto/subtle"
    "encoding/hex"
    "fmt"
)

// ConstantTimeEqual compares two strings in constant time
// Returns false if lengths differ (does NOT leak length)
func ConstantTimeEqual(a, b string) bool {
    aBytes := []byte(a)
    bBytes := []byte(b)
    return subtle.ConstantTimeCompare(aBytes, bBytes) == 1
}

// ConstantTimeEqualBytes compares byte slices in constant time
func ConstantTimeEqualBytes(a, b []byte) bool {
    return subtle.ConstantTimeCompare(a, b) == 1
}

// ValidateHMAC computes and verifies HMAC-SHA256 in constant time
func ValidateHMAC(message, providedHMAC []byte, key []byte) bool {
    mac := hmac.New(sha256.New, key)
    mac.Write(message)
    expectedHMAC := mac.Sum(nil)
    // hmac.Equal uses subtle.ConstantTimeCompare internally
    return hmac.Equal(providedHMAC, expectedHMAC)
}

// GenerateSecureToken creates a cryptographically secure random token
func GenerateSecureToken(length int) (string, error) {
    bytes := make([]byte, length)
    if _, err := rand.Read(bytes); err != nil {
        return "", fmt.Errorf("generating secure token: %w", err)
    }
    return hex.EncodeToString(bytes), nil
}

// HashSecret creates a non-reversible hash of a secret for storage
// Uses sha256 here; for passwords, use bcrypt or argon2id
func HashSecret(secret, salt string) string {
    h := hmac.New(sha256.New, []byte(salt))
    h.Write([]byte(secret))
    return hex.EncodeToString(h.Sum(nil))
}

// ValidateAPIKey validates an API key in constant time
// The key is stored as "keyID:keySecret" where keyID is used for lookup
type APIKeyStore struct {
    keys map[string]string // keyID -> hashed secret
    salt string
}

func (s *APIKeyStore) Validate(providedKey string) bool {
    parts := strings.SplitN(providedKey, ".", 2)
    if len(parts) != 2 {
        // Return false in constant time even for malformed keys
        // This dummy comparison prevents timing attacks on the format check
        subtle.ConstantTimeCompare([]byte("dummy"), []byte("check"))
        return false
    }

    keyID, keySecret := parts[0], parts[1]

    storedHash, exists := s.keys[keyID]
    if !exists {
        // Perform a dummy hash to prevent timing attacks on key lookup
        HashSecret("dummy-secret", s.salt)
        return false
    }

    providedHash := HashSecret(keySecret, s.salt)
    return ConstantTimeEqual(providedHash, storedHash)
}
```

## Input Validation and Sanitization

```go
// validation/input.go
package validation

import (
    "fmt"
    "net"
    "regexp"
    "strings"
    "unicode"
    "unicode/utf8"
)

var (
    emailRegexp    = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)
    usernameRegexp = regexp.MustCompile(`^[a-zA-Z0-9_\-]{3,50}$`)
    // UUIDs
    uuidRegexp = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// Validator provides input validation with detailed error messages
type Validator struct {
    errors []ValidationError
}

type ValidationError struct {
    Field   string
    Message string
}

func (v *Validator) Check(condition bool, field, message string) {
    if !condition {
        v.errors = append(v.errors, ValidationError{Field: field, Message: message})
    }
}

func (v *Validator) Valid() bool {
    return len(v.errors) == 0
}

func (v *Validator) Errors() []ValidationError {
    return v.errors
}

// ValidateEmail validates email format
func ValidateEmail(email string) error {
    if len(email) > 254 {  // RFC 5321 limit
        return fmt.Errorf("email exceeds maximum length")
    }
    if !emailRegexp.MatchString(email) {
        return fmt.Errorf("invalid email format")
    }
    return nil
}

// ValidateUsername validates username format and content
func ValidateUsername(username string) error {
    if !utf8.ValidString(username) {
        return fmt.Errorf("username contains invalid UTF-8")
    }
    if !usernameRegexp.MatchString(username) {
        return fmt.Errorf("username must be 3-50 characters, alphanumeric, hyphens, or underscores only")
    }
    // Additional content checks
    lower := strings.ToLower(username)
    forbidden := []string{"admin", "root", "system", "superuser", "null"}
    for _, word := range forbidden {
        if lower == word {
            return fmt.Errorf("username %q is not allowed", username)
        }
    }
    return nil
}

// ValidateUUID validates UUID format (prevent UUID injection)
func ValidateUUID(id string) error {
    if !uuidRegexp.MatchString(strings.ToLower(id)) {
        return fmt.Errorf("invalid UUID format")
    }
    return nil
}

// StripControlChars removes ASCII control characters from string
// Prevents terminal injection and log injection attacks
func StripControlChars(s string) string {
    return strings.Map(func(r rune) rune {
        if unicode.IsControl(r) && r != '\n' && r != '\t' {
            return -1  // Drop the character
        }
        return r
    }, s)
}

// SanitizeForLog makes a string safe to include in log output
// Prevents log injection attacks (e.g., ANSI escape codes, newlines)
func SanitizeForLog(s string) string {
    // Remove ANSI escape sequences
    ansiEscape := regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)
    s = ansiEscape.ReplaceAllString(s, "")

    // Replace newlines and carriage returns (prevent log forging)
    s = strings.NewReplacer(
        "\n", "\\n",
        "\r", "\\r",
        "\t", "\\t",
    ).Replace(s)

    // Truncate to prevent excessive log entries
    if len(s) > 1000 {
        s = s[:1000] + "[truncated]"
    }

    return s
}

// ValidateInteger validates an integer within bounds
func ValidateInteger(value, min, max int64) error {
    if value < min || value > max {
        return fmt.Errorf("value %d out of range [%d, %d]", value, min, max)
    }
    return nil
}

// ValidateIPAddress validates an IP address (v4 or v6)
func ValidateIPAddress(ip string) error {
    if net.ParseIP(ip) == nil {
        return fmt.Errorf("invalid IP address: %q", ip)
    }
    return nil
}
```

## SQL Injection Prevention

```go
// database/safe_queries.go
package database

import (
    "database/sql"
    "fmt"
)

// VULNERABLE: string concatenation in SQL
func getUserVulnerable(db *sql.DB, username string) (*User, error) {
    query := "SELECT * FROM users WHERE username = '" + username + "'"
    // username = "' OR '1'='1" -> returns all users
    row := db.QueryRow(query)
    // ...
}

// SECURE: parameterized queries
func getUser(db *sql.DB, username string) (*User, error) {
    user := &User{}
    err := db.QueryRow(
        "SELECT id, email, created_at FROM users WHERE username = $1",
        username,  // Passed as parameter, never interpolated into query string
    ).Scan(&user.ID, &user.Email, &user.CreatedAt)
    if err == sql.ErrNoRows {
        return nil, ErrNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("querying user: %w", err)
    }
    return user, nil
}

// SECURE: dynamic ORDER BY with allowlist
func listUsers(db *sql.DB, sortBy string, descending bool) ([]*User, error) {
    // Allowlist for column names (never trust user input for column names)
    allowedColumns := map[string]string{
        "name":       "name",
        "email":      "email",
        "created_at": "created_at",
        "last_login": "last_login",
    }

    column, ok := allowedColumns[sortBy]
    if !ok {
        column = "created_at"  // Default
    }

    direction := "ASC"
    if descending {
        direction = "DESC"
    }

    // Build query with allowlisted column and direction (not user input)
    query := fmt.Sprintf(
        "SELECT id, name, email FROM users ORDER BY %s %s LIMIT $1",
        column, direction,  // These come from the allowlist, not user input
    )

    rows, err := db.Query(query, 100)
    // ...
}
```

## Secure HTTP Server Defaults

```go
// server/secure_server.go
package server

import (
    "crypto/tls"
    "net/http"
    "time"
)

// SecureServer creates an HTTP server with production security defaults
func SecureServer(addr string, handler http.Handler) *http.Server {
    return &http.Server{
        Addr:    addr,
        Handler: securityMiddleware(handler),

        // Prevent Slowloris and slow read attacks
        ReadTimeout:       10 * time.Second,
        WriteTimeout:      10 * time.Second,
        IdleTimeout:       120 * time.Second,
        ReadHeaderTimeout: 5 * time.Second,

        // Prevent HTTP/2 server push abuse
        MaxHeaderBytes: 1 << 20,  // 1MB
    }
}

// SecureTLSConfig returns a TLS configuration with secure defaults
func SecureTLSConfig() *tls.Config {
    return &tls.Config{
        // TLS 1.2 minimum (1.1 and below are deprecated)
        MinVersion: tls.VersionTLS12,

        // Prefer server cipher order (prevents downgrade attacks)
        PreferServerCipherSuites: true,

        // Modern cipher suites only (no 3DES, RC4, CBC with SHA-1)
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
            tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
            tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        },

        // Modern curves only
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
        },
    }
}

// securityMiddleware adds security headers to all responses
func securityMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        h := w.Header()

        // Prevent MIME type sniffing
        h.Set("X-Content-Type-Options", "nosniff")

        // Prevent clickjacking
        h.Set("X-Frame-Options", "DENY")

        // XSS protection (legacy browsers)
        h.Set("X-XSS-Protection", "1; mode=block")

        // HTTPS-only for 1 year, include subdomains
        h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")

        // Referrer policy
        h.Set("Referrer-Policy", "strict-origin-when-cross-origin")

        // Permissions policy
        h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")

        // Content Security Policy
        h.Set("Content-Security-Policy",
            "default-src 'self'; "+
            "script-src 'self'; "+
            "style-src 'self'; "+
            "img-src 'self' data: https:; "+
            "font-src 'self'; "+
            "connect-src 'self'; "+
            "frame-ancestors 'none'; "+
            "base-uri 'self'; "+
            "form-action 'self'")

        next.ServeHTTP(w, r)
    })
}
```

## Security Testing with go-fuzz

```go
// fuzz/url_validator_test.go
package fuzz

import (
    "testing"

    "myapp/pkg/security"
)

// FuzzURLValidator validates that the URL validator never panics
// Run: go test -fuzz=FuzzURLValidator -fuzztime=60s
func FuzzURLValidator(f *testing.F) {
    // Seed corpus with known inputs
    f.Add("https://example.com/path?query=value")
    f.Add("http://169.254.169.254/latest/meta-data/")
    f.Add("javascript:alert(1)")
    f.Add("file:///etc/passwd")
    f.Add("https://user:pass@example.com/path")
    f.Add("")
    f.Add("not-a-url")

    validator := security.NewURLValidator(security.DefaultSecureConfig())

    f.Fuzz(func(t *testing.T, url string) {
        // Should never panic regardless of input
        _ = validator.Validate(url)
    })
}

// FuzzSanitizeForLog validates log sanitization never panics
func FuzzSanitizeForLog(f *testing.F) {
    f.Add("normal log message")
    f.Add("message with \n newline")
    f.Add("\x1b[31mRed text\x1b[0m")
    f.Add(string([]byte{0x00, 0x01, 0x02}))

    f.Fuzz(func(t *testing.T, input string) {
        result := security.SanitizeForLog(input)
        // Result should never contain raw control sequences
        if strings.ContainsAny(result, "\n\r") {
            t.Errorf("SanitizeForLog(%q) = %q: contains unescaped newline", input, result)
        }
    })
}
```

## Key Takeaways

Go's memory safety removes an entire attack surface, but application-layer security requires explicit design:

**SSRF requires defense at two layers**: URL validation before the request AND connection-time IP validation after DNS resolution. DNS rebinding attacks can bypass pre-request URL validation by returning a private IP only after the check has passed.

**Never use shell for command execution**: `exec.Command("bash", "-c", userInput)` is always wrong. Always use `exec.Command(binaryPath, arg1, arg2, ...)` with arguments as separate parameters and validate each argument against an allowlist.

**Use html/template exclusively for HTML output**: Never import `text/template` for HTTP handlers. The package-level import is the bug — switching to `html/template` provides automatic context-aware escaping for HTML, URL, and JavaScript contexts.

**Constant-time comparison is non-negotiable for secrets**: Use `crypto/subtle.ConstantTimeCompare` for API keys, tokens, and HMACs. The standard library's `crypto/hmac.Equal` handles HMAC specifically. Regular string equality is never safe for cryptographic values.

**Input validation must happen at the service boundary**: Validate and sanitize all inputs at the HTTP handler level, before any business logic. Use parameterized queries for all database interactions — there is no legitimate use case for string-concatenated SQL in Go.
