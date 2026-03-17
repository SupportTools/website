---
title: "Go Security Hardening: Input Sanitization, SSRF Prevention, SQL Injection Defense, and Secure Headers"
date: 2028-09-10T00:00:00-05:00
draft: false
tags: ["Go", "Security", "SSRF", "SQL Injection", "Input Validation", "Secure Headers"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Harden Go web services against common attack vectors: SSRF prevention with URL validation and allowlists, SQL injection defense via parameterized queries and schema validation, XSS mitigation, Content Security Policy headers, and security middleware for production deployments."
more_link: "yes"
url: "/go-security-hardening-ssrf-sql-injection-guide/"
---

Security vulnerabilities in Go services follow predictable patterns. SSRF allows attackers to probe internal infrastructure via your application. SQL injection remains OWASP #1 despite being fully preventable. Input validation failures lead to stored XSS, path traversal, and command injection. This guide provides concrete, production-ready Go code for each defense layer, with emphasis on what actually stops attacks rather than security theater.

<!--more-->

# Go Security Hardening: Input Sanitization, SSRF Prevention, SQL Injection Defense, and Secure Headers

## Section 1: Threat Model for Go Web Services

Before writing defensive code, understand what you're defending against:

```
Attack Surface:
├── HTTP Input
│   ├── JSON/form body: injection, oversized payloads, malformed types
│   ├── URL parameters: path traversal, injection
│   ├── Headers: header injection, request smuggling
│   └── File uploads: polyglot files, path traversal, DoS
├── External Calls (SSRF)
│   ├── Webhook URLs from user input
│   ├── Remote image/file fetching
│   └── Any HTTP call with user-controlled URL
├── Database
│   ├── SQL injection via string concatenation
│   ├── Second-order injection (stored, later executed)
│   └── Schema enumeration via error messages
└── Output
    ├── XSS via unescaped output
    ├── Information disclosure in errors
    └── Sensitive data in logs
```

## Section 2: SSRF Prevention

Server-Side Request Forgery (SSRF) lets attackers use your service as a proxy to reach internal systems (metadata APIs, databases, other services).

```go
// security/ssrf.go
package security

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "net/url"
    "strings"
    "time"
)

// SafeHTTPClient is an http.Client with SSRF protections built in.
// Use this for ALL outbound HTTP requests where the URL comes from user input.
var SafeHTTPClient = &http.Client{
    Timeout: 30 * time.Second,
    Transport: &http.Transport{
        DialContext: (&SSRFBlockingDialer{
            AllowedHosts: nil, // nil = use blocklist; set for allowlist mode
        }).DialContext,
        // Disable redirect following to prevent SSRF via redirect chains
        // Set explicitly in the client below
    },
    CheckRedirect: func(req *http.Request, via []*http.Request) error {
        if len(via) >= 3 {
            return fmt.Errorf("too many redirects")
        }
        // Validate each redirect target
        return ValidateURL(req.URL.String(), nil)
    },
}

// SSRFBlockingDialer validates the resolved IP before connecting.
type SSRFBlockingDialer struct {
    AllowedHosts []string // if set, only these hosts are allowed
    dialer       net.Dialer
}

// DialContext resolves the hostname and checks the IP before establishing a connection.
func (d *SSRFBlockingDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
    host, port, err := net.SplitHostPort(addr)
    if err != nil {
        return nil, fmt.Errorf("invalid address: %w", err)
    }

    // Resolve hostname to IPs
    addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
    if err != nil {
        return nil, fmt.Errorf("DNS lookup failed: %w", err)
    }

    for _, a := range addrs {
        if err := validateIP(a.IP); err != nil {
            return nil, fmt.Errorf("SSRF protection: %w", err)
        }
    }

    if d.AllowedHosts != nil {
        allowed := false
        for _, h := range d.AllowedHosts {
            if strings.EqualFold(host, h) || strings.HasSuffix(host, "."+h) {
                allowed = true
                break
            }
        }
        if !allowed {
            return nil, fmt.Errorf("SSRF protection: host %q not in allowlist", host)
        }
    }

    return d.dialer.DialContext(ctx, network, net.JoinHostPort(addrs[0].IP.String(), port))
}

// validateIP returns an error if the IP is a private/loopback/link-local address.
func validateIP(ip net.IP) error {
    // IPv6 localhost
    if ip.Equal(net.IPv6loopback) {
        return fmt.Errorf("loopback address blocked: %s", ip)
    }

    blockedRanges := []struct {
        network *net.IPNet
        reason  string
    }{
        {mustParseCIDR("127.0.0.0/8"), "loopback"},
        {mustParseCIDR("10.0.0.0/8"), "private RFC-1918"},
        {mustParseCIDR("172.16.0.0/12"), "private RFC-1918"},
        {mustParseCIDR("192.168.0.0/16"), "private RFC-1918"},
        {mustParseCIDR("169.254.0.0/16"), "link-local (IMDS)"},
        {mustParseCIDR("100.64.0.0/10"), "carrier-grade NAT"},
        {mustParseCIDR("::1/128"), "IPv6 loopback"},
        {mustParseCIDR("fc00::/7"), "IPv6 unique local"},
        {mustParseCIDR("fe80::/10"), "IPv6 link-local"},
        {mustParseCIDR("0.0.0.0/8"), "unspecified"},
        {mustParseCIDR("240.0.0.0/4"), "reserved"},
    }

    for _, blocked := range blockedRanges {
        if blocked.network.Contains(ip) {
            return fmt.Errorf("%s address blocked: %s", blocked.reason, ip)
        }
    }
    return nil
}

// ValidateURL validates a URL for safe external use.
// Pass allowedHosts to restrict to specific domains.
func ValidateURL(rawURL string, allowedHosts []string) error {
    u, err := url.ParseRequestURI(rawURL)
    if err != nil {
        return fmt.Errorf("invalid URL: %w", err)
    }

    // Only allow https (and http if explicitly needed)
    if u.Scheme != "https" && u.Scheme != "http" {
        return fmt.Errorf("scheme %q not allowed; use https", u.Scheme)
    }

    // Reject file://, gopher://, dict://, etc.
    // (handled above but explicit for clarity)

    // Reject URLs with credentials embedded
    if u.User != nil {
        return fmt.Errorf("credentials in URL not allowed")
    }

    // Reject URLs with port 25 (SMTP), 445 (SMB), etc.
    blockedPorts := map[string]bool{
        "22": true, "23": true, "25": true, "53": true,
        "110": true, "143": true, "445": true, "587": true,
        "993": true, "995": true, "3306": true, "5432": true,
        "6379": true, "27017": true,
    }
    if blockedPorts[u.Port()] {
        return fmt.Errorf("port %s is not allowed for outbound requests", u.Port())
    }

    if len(allowedHosts) > 0 {
        allowed := false
        host := strings.ToLower(u.Hostname())
        for _, h := range allowedHosts {
            h = strings.ToLower(h)
            if host == h || strings.HasSuffix(host, "."+h) {
                allowed = true
                break
            }
        }
        if !allowed {
            return fmt.Errorf("host %q not in allowed list", u.Hostname())
        }
    }

    return nil
}

func mustParseCIDR(s string) *net.IPNet {
    _, network, err := net.ParseCIDR(s)
    if err != nil {
        panic(err)
    }
    return network
}
```

### Webhook Handler with SSRF Protection

```go
// handlers/webhook.go
package handlers

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"

    "github.com/myorg/api/security"
)

type WebhookConfig struct {
    URL     string            `json:"url" validate:"required,url,max=2048"`
    Headers map[string]string `json:"headers,omitempty"`
    Events  []string          `json:"events" validate:"required,min=1"`
}

// TestWebhook sends a test payload to a user-provided webhook URL.
// This is a common SSRF target — must validate the URL before calling.
func TestWebhook(w http.ResponseWriter, r *http.Request) {
    var cfg WebhookConfig
    if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        return
    }

    // Step 1: Validate URL format and scheme
    if err := security.ValidateURL(cfg.URL, nil); err != nil {
        http.Error(w, fmt.Sprintf("unsafe webhook URL: %v", err), http.StatusBadRequest)
        return
    }

    // Step 2: Create payload
    payload := map[string]interface{}{
        "type":      "test",
        "timestamp": time.Now().UTC(),
        "version":   "1.0",
    }
    body, _ := json.Marshal(payload)

    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "POST", cfg.URL, strings.NewReader(string(body)))
    if err != nil {
        http.Error(w, "failed to create request", http.StatusInternalServerError)
        return
    }

    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("User-Agent", "MyOrg-Webhook/1.0")

    // Only allow safe headers — prevent header injection
    for k, v := range cfg.Headers {
        if isAllowedWebhookHeader(k) {
            req.Header.Set(k, v)
        }
    }

    // Step 3: Use the SSRF-protected client — rejects internal IPs at dial time
    resp, err := security.SafeHTTPClient.Do(req)
    if err != nil {
        http.Error(w, fmt.Sprintf("webhook delivery failed: %v", err), http.StatusBadGateway)
        return
    }
    defer resp.Body.Close()

    // Read limited response
    respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status": resp.StatusCode,
        "ok":     resp.StatusCode >= 200 && resp.StatusCode < 300,
        "body":   string(respBody),
    })
}

func isAllowedWebhookHeader(key string) bool {
    allowed := map[string]bool{
        "X-Webhook-Secret":    true,
        "X-Custom-Header":     true,
        "Authorization":       true,
        "X-API-Key":           true,
    }
    // Normalize header name
    return allowed[http.CanonicalHeaderKey(key)]
}
```

## Section 3: SQL Injection Defense

The primary defense is parameterized queries. Never concatenate SQL strings.

```go
// database/queries.go
package database

import (
    "context"
    "database/sql"
    "fmt"
    "regexp"
    "strings"
    "time"
)

// UserRepository demonstrates safe SQL patterns.
type UserRepository struct {
    db *sql.DB
}

// GetUserByEmail — SAFE: parameterized query
func (r *UserRepository) GetUserByEmail(ctx context.Context, email string) (*User, error) {
    // The database driver handles escaping; the email value CANNOT break out of the query
    row := r.db.QueryRowContext(ctx,
        "SELECT id, email, first_name, last_name, created_at FROM users WHERE email = $1 AND deleted_at IS NULL",
        email)

    var u User
    err := row.Scan(&u.ID, &u.Email, &u.FirstName, &u.LastName, &u.CreatedAt)
    if err == sql.ErrNoRows {
        return nil, ErrNotFound
    }
    return &u, err
}

// SearchUsers — SAFE: dynamic ORDER BY with allowlist validation
func (r *UserRepository) SearchUsers(ctx context.Context, query, sortBy, sortDir string, limit, offset int) ([]*User, error) {
    // Validate sort column against an allowlist — NEVER interpolate user input as column name
    allowedColumns := map[string]bool{
        "created_at": true,
        "email":      true,
        "last_name":  true,
        "first_name": true,
    }
    if !allowedColumns[sortBy] {
        sortBy = "created_at"  // safe default
    }

    // Validate sort direction
    sortDir = strings.ToUpper(sortDir)
    if sortDir != "ASC" && sortDir != "DESC" {
        sortDir = "DESC"
    }

    // Validate pagination
    if limit <= 0 || limit > 1000 {
        limit = 20
    }
    if offset < 0 {
        offset = 0
    }

    // Build query with interpolated column name (safe — validated against allowlist)
    // and parameterized values (safe — handled by driver)
    sqlQuery := fmt.Sprintf(
        `SELECT id, email, first_name, last_name, created_at
         FROM users
         WHERE deleted_at IS NULL
           AND ($1 = '' OR (
             first_name ILIKE '%%' || $1 || '%%'
             OR last_name ILIKE '%%' || $1 || '%%'
             OR email ILIKE '%%' || $1 || '%%'
           ))
         ORDER BY %s %s
         LIMIT $2 OFFSET $3`,
        sortBy, sortDir)  // sortBy and sortDir are validated above

    rows, err := r.db.QueryContext(ctx, sqlQuery, query, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("search query: %w", err)
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        u := &User{}
        if err := rows.Scan(&u.ID, &u.Email, &u.FirstName, &u.LastName, &u.CreatedAt); err != nil {
            return nil, err
        }
        users = append(users, u)
    }
    return users, rows.Err()
}

// BulkGetUsers — SAFE: parameterized IN clause using ANY($1)
func (r *UserRepository) BulkGetUsers(ctx context.Context, ids []string) ([]*User, error) {
    if len(ids) == 0 {
        return nil, nil
    }
    if len(ids) > 1000 {
        return nil, fmt.Errorf("too many IDs: max 1000, got %d", len(ids))
    }

    // PostgreSQL: use ANY($1::uuid[]) — passes array as a single parameter
    // This is safe and avoids building a variable-length "?,?,?,?" string
    rows, err := r.db.QueryContext(ctx,
        "SELECT id, email, first_name, last_name, created_at FROM users WHERE id = ANY($1::uuid[])",
        pq.Array(ids))  // pq.Array handles the conversion
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        u := &User{}
        if err := rows.Scan(&u.ID, &u.Email, &u.FirstName, &u.LastName, &u.CreatedAt); err != nil {
            return nil, err
        }
        users = append(users, u)
    }
    return users, rows.Err()
}

// UNSAFE examples — never do these:
/*
// INJECTION: string concatenation
db.QueryContext(ctx, "SELECT * FROM users WHERE email = '" + email + "'")

// INJECTION: fmt.Sprintf without parameterization
db.QueryContext(ctx, fmt.Sprintf("SELECT * FROM users WHERE id = %s", id))

// INJECTION: dynamic column without allowlist
db.QueryContext(ctx, "SELECT * FROM users ORDER BY " + userProvidedColumn)
*/
```

### Second-Order SQL Injection Prevention

```go
// security/second_order.go
package security

import (
    "regexp"
    "strings"
)

var (
    // Detect SQL metacharacters in stored data
    sqlMetaRe = regexp.MustCompile(`['";\\]|--|\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|EXEC|EXECUTE|CAST|CONVERT|DECLARE)\b`)
    // Path traversal patterns
    pathTraversalRe = regexp.MustCompile(`\.\.[\\/]`)
    // Null bytes
    nullByteRe = regexp.MustCompile("\x00")
)

// SanitizeForLog removes sensitive data and control characters from strings
// destined for logs. Does NOT make data safe for SQL (use parameterization).
func SanitizeForLog(s string) string {
    // Remove null bytes
    s = nullByteRe.ReplaceAllString(s, "")
    // Replace newlines to prevent log injection
    s = strings.ReplaceAll(s, "\n", "\\n")
    s = strings.ReplaceAll(s, "\r", "\\r")
    // Truncate long strings in logs
    if len(s) > 500 {
        s = s[:500] + "...[truncated]"
    }
    return s
}

// ValidateIdentifier validates database identifiers (table names, column names)
// that come from configuration (not user input). Use allowlists for user input.
func ValidateIdentifier(s string) bool {
    // Only allow letters, numbers, underscores — no spaces or SQL characters
    return regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`).MatchString(s)
}

// ValidateFilename sanitizes filenames for safe storage.
func ValidateFilename(filename string) (string, error) {
    // Remove path components
    filename = filepath.Base(filename)
    // Remove null bytes
    filename = strings.ReplaceAll(filename, "\x00", "")
    // Block path traversal
    if pathTraversalRe.MatchString(filename) {
        return "", fmt.Errorf("filename contains path traversal")
    }
    // Allow only safe characters
    safeRe := regexp.MustCompile(`^[a-zA-Z0-9._\-]{1,255}$`)
    if !safeRe.MatchString(filename) {
        return "", fmt.Errorf("filename contains invalid characters")
    }
    return filename, nil
}
```

## Section 4: Secure HTTP Headers Middleware

```go
// middleware/secure_headers.go
package middleware

import (
    "fmt"
    "net/http"
    "strings"
)

// SecureHeaders adds security headers to every response.
// Configure CSP and other headers for your specific application.
func SecureHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        h := w.Header()

        // Prevent MIME type sniffing
        h.Set("X-Content-Type-Options", "nosniff")

        // Prevent clickjacking
        h.Set("X-Frame-Options", "DENY")

        // Enable browser XSS filter (legacy browsers)
        h.Set("X-XSS-Protection", "1; mode=block")

        // Strict Transport Security — force HTTPS for 1 year, include subdomains
        h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")

        // Referrer policy — don't leak URL to third parties
        h.Set("Referrer-Policy", "strict-origin-when-cross-origin")

        // Permissions policy — disable unnecessary browser features
        h.Set("Permissions-Policy",
            "geolocation=(), microphone=(), camera=(), payment=(), usb=()")

        // Content Security Policy
        csp := buildCSP(CSPConfig{
            DefaultSrc: []string{"'self'"},
            ScriptSrc:  []string{"'self'", "'strict-dynamic'"},
            StyleSrc:   []string{"'self'", "'unsafe-inline'"}, // if needed for inline styles
            ImgSrc:     []string{"'self'", "data:", "https://cdn.myorg.com"},
            ConnectSrc: []string{"'self'", "https://api.myorg.com"},
            FontSrc:    []string{"'self'", "https://fonts.gstatic.com"},
            ObjectSrc:  []string{"'none'"},
            FrameSrc:   []string{"'none'"},
            BaseURI:    []string{"'self'"},
            FormAction: []string{"'self'"},
            // Report URI for CSP violations
            ReportURI: "https://myorg.report-uri.com/r/d/csp/reportOnly",
        })
        h.Set("Content-Security-Policy", csp)

        // For API endpoints: no-cache to prevent sensitive data caching
        if isAPIPath(r.URL.Path) {
            h.Set("Cache-Control", "no-store, no-cache, must-revalidate")
            h.Set("Pragma", "no-cache")
        }

        next.ServeHTTP(w, r)
    })
}

type CSPConfig struct {
    DefaultSrc []string
    ScriptSrc  []string
    StyleSrc   []string
    ImgSrc     []string
    ConnectSrc []string
    FontSrc    []string
    ObjectSrc  []string
    FrameSrc   []string
    BaseURI    []string
    FormAction []string
    ReportURI  string
}

func buildCSP(cfg CSPConfig) string {
    directives := []string{}
    add := func(name string, sources []string) {
        if len(sources) > 0 {
            directives = append(directives, name+" "+strings.Join(sources, " "))
        }
    }
    add("default-src", cfg.DefaultSrc)
    add("script-src", cfg.ScriptSrc)
    add("style-src", cfg.StyleSrc)
    add("img-src", cfg.ImgSrc)
    add("connect-src", cfg.ConnectSrc)
    add("font-src", cfg.FontSrc)
    add("object-src", cfg.ObjectSrc)
    add("frame-src", cfg.FrameSrc)
    add("base-uri", cfg.BaseURI)
    add("form-action", cfg.FormAction)
    if cfg.ReportURI != "" {
        directives = append(directives, "report-uri "+cfg.ReportURI)
    }
    return strings.Join(directives, "; ")
}

func isAPIPath(path string) bool {
    return strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/internal/")
}

// RemoveServerHeader strips the Server header to avoid version disclosure.
func RemoveServerHeader(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Del("Server")
        w.Header().Del("X-Powered-By")
        next.ServeHTTP(w, r)
    })
}
```

## Section 5: Input Sanitization Against XSS

```go
// security/xss.go
package security

import (
    "html"
    "regexp"
    "strings"
    "unicode/utf8"

    "github.com/microcosm-cc/bluemonday"
)

var (
    strictPolicy  = bluemonday.StrictPolicy()   // strips ALL HTML
    contentPolicy = bluemonday.UGCPolicy()       // allows basic formatting
)

// StripHTML removes all HTML tags from user input.
// Use for fields where HTML is never expected (names, emails, etc.).
func StripHTML(s string) string {
    return strictPolicy.Sanitize(s)
}

// SanitizeHTML allows safe HTML subset for rich-text content.
// Use for blog posts, comments, etc.
func SanitizeHTML(s string) string {
    return contentPolicy.Sanitize(s)
}

// EscapeForHTML escapes special characters for direct inclusion in HTML.
// The standard library's html.EscapeString is sufficient for most use cases.
func EscapeForHTML(s string) string {
    return html.EscapeString(s)
}

// EscapeForJSON returns a string safe for embedding in JSON context.
// The standard json package handles this, but useful for template contexts.
func EscapeForJSON(s string) string {
    // Replace characters that could escape JSON string context
    replacer := strings.NewReplacer(
        `"`, `\"`,
        `\`, `\\`,
        "\n", `\n`,
        "\r", `\r`,
        "\t", `\t`,
    )
    return replacer.Replace(s)
}

// ValidateUTF8 ensures the string is valid UTF-8 and rejects null bytes.
func ValidateUTF8(s string) error {
    if !utf8.ValidString(s) {
        return fmt.Errorf("invalid UTF-8 encoding")
    }
    if strings.ContainsRune(s, 0) {
        return fmt.Errorf("null bytes not allowed")
    }
    return nil
}

// TruncateString safely truncates a string at a rune boundary.
func TruncateString(s string, maxRunes int) string {
    runes := []rune(s)
    if len(runes) > maxRunes {
        return string(runes[:maxRunes])
    }
    return s
}
```

## Section 6: JWT Token Validation

```go
// security/jwt.go
package security

import (
    "context"
    "crypto/rsa"
    "errors"
    "fmt"
    "net/http"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type Claims struct {
    jwt.RegisteredClaims
    UserID     string   `json:"sub"`
    TenantID   string   `json:"tenant_id"`
    Roles      []string `json:"roles"`
    SessionID  string   `json:"sid"`
}

type JWTValidator struct {
    publicKey    *rsa.PublicKey
    issuer       string
    audience     string
    maxAge       time.Duration
}

// ValidateToken parses and validates a JWT, returning claims on success.
func (v *JWTValidator) ValidateToken(tokenString string) (*Claims, error) {
    // Reject obviously malformed tokens early
    if len(tokenString) > 4096 {
        return nil, errors.New("token too large")
    }
    if strings.Count(tokenString, ".") != 2 {
        return nil, errors.New("invalid token format")
    }

    claims := &Claims{}
    token, err := jwt.ParseWithClaims(tokenString, claims,
        func(t *jwt.Token) (interface{}, error) {
            // CRITICAL: Verify the signing algorithm
            // An attacker can forge tokens by changing "alg":"RS256" to "alg":"none"
            // or switching from RS256 to HS256 with the public key as the HMAC secret
            if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
                return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
            }
            return v.publicKey, nil
        },
        jwt.WithValidMethods([]string{"RS256", "RS384", "RS512"}),
        jwt.WithIssuedAt(),
        jwt.WithExpirationRequired(),
        jwt.WithIssuer(v.issuer),
        jwt.WithAudience(v.audience),
    )
    if err != nil {
        return nil, fmt.Errorf("token validation failed: %w", err)
    }
    if !token.Valid {
        return nil, errors.New("token is not valid")
    }

    // Additional validation
    if claims.UserID == "" {
        return nil, errors.New("token missing user ID")
    }
    if time.Since(claims.IssuedAt.Time) > v.maxAge {
        return nil, errors.New("token too old")
    }

    return claims, nil
}

// AuthMiddleware extracts and validates JWT from Authorization header.
func (v *JWTValidator) AuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        authHeader := r.Header.Get("Authorization")
        if authHeader == "" {
            http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"Authorization header required"}}`,
                http.StatusUnauthorized)
            return
        }

        const bearerPrefix = "Bearer "
        if !strings.HasPrefix(authHeader, bearerPrefix) {
            http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"Bearer token required"}}`,
                http.StatusUnauthorized)
            return
        }

        tokenString := authHeader[len(bearerPrefix):]
        claims, err := v.ValidateToken(tokenString)
        if err != nil {
            // Don't reveal why validation failed — just say unauthorized
            // Log the detailed error internally
            logger.Warn("token validation failed",
                "error", err,
                "ip", realIP(r),
                "user_agent", r.UserAgent())
            http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"Invalid or expired token"}}`,
                http.StatusUnauthorized)
            return
        }

        ctx := context.WithValue(r.Context(), contextKeyClaims, claims)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

## Section 7: Path Traversal Prevention

```go
// security/path.go
package security

import (
    "fmt"
    "os"
    "path/filepath"
    "strings"
)

// SafeFilePath ensures a user-provided filename cannot escape the base directory.
// This prevents path traversal attacks like "../../etc/passwd".
func SafeFilePath(baseDir, userFilename string) (string, error) {
    // Clean the filename
    userFilename = filepath.Clean(userFilename)

    // Reject absolute paths
    if filepath.IsAbs(userFilename) {
        return "", fmt.Errorf("absolute paths not allowed")
    }

    // Reject path components that navigate upward
    if strings.Contains(userFilename, "..") {
        return "", fmt.Errorf("path traversal not allowed")
    }

    // Join with base directory
    fullPath := filepath.Join(baseDir, userFilename)

    // Resolve symlinks and verify the path is still within baseDir
    resolvedPath, err := filepath.EvalSymlinks(fullPath)
    if err != nil && !os.IsNotExist(err) {
        return "", fmt.Errorf("path resolution failed: %w", err)
    }

    resolvedBase, err := filepath.EvalSymlinks(baseDir)
    if err != nil {
        return "", fmt.Errorf("base dir resolution failed: %w", err)
    }

    // Ensure resolved path is under base dir
    if !strings.HasPrefix(resolvedPath, resolvedBase+string(os.PathSeparator)) &&
        resolvedPath != resolvedBase {
        return "", fmt.Errorf("path traversal detected: %q is outside base dir", userFilename)
    }

    return fullPath, nil
}

// SafeFileServe serves a file from a directory, preventing directory traversal.
func SafeFileServe(w http.ResponseWriter, r *http.Request, baseDir, requestedPath string) {
    safePath, err := SafeFilePath(baseDir, requestedPath)
    if err != nil {
        http.Error(w, "invalid path", http.StatusBadRequest)
        return
    }

    // Check the file exists and is a regular file (not a directory or device)
    info, err := os.Stat(safePath)
    if os.IsNotExist(err) {
        http.NotFound(w, r)
        return
    }
    if err != nil {
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }
    if !info.Mode().IsRegular() {
        http.Error(w, "not a file", http.StatusForbidden)
        return
    }

    http.ServeFile(w, r, safePath)
}
```

## Section 8: Error Handling — Preventing Information Disclosure

```go
// security/errors.go
package security

import (
    "encoding/json"
    "log/slog"
    "net/http"

    "github.com/google/uuid"
)

// SafeError wraps an internal error for safe external exposure.
// Never expose raw database errors, stack traces, or internal paths to clients.
type SafeError struct {
    Code      string `json:"code"`
    Message   string `json:"message"`
    RequestID string `json:"request_id,omitempty"`
}

// WriteError writes a safe error response.
// internalErr is logged but NOT sent to the client.
func WriteError(w http.ResponseWriter, r *http.Request, status int, code, safeMessage string, internalErr error) {
    requestID := r.Header.Get("X-Request-ID")
    if requestID == "" {
        requestID = uuid.New().String()
    }

    if internalErr != nil {
        slog.Error("request error",
            "request_id", requestID,
            "status", status,
            "code", code,
            "error", internalErr,
            "path", r.URL.Path,
            "method", r.Method,
            "ip", realIP(r),
        )
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Request-ID", requestID)
    w.WriteHeader(status)

    json.NewEncoder(w).Encode(SafeError{
        Code:      code,
        Message:   safeMessage,
        RequestID: requestID,
    })
}

// RecoveryMiddleware catches panics and returns a safe 500 error.
func RecoveryMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                slog.Error("panic recovered",
                    "panic", err,
                    "path", r.URL.Path,
                    "stack", debug.Stack(),
                )
                WriteError(w, r, http.StatusInternalServerError,
                    "INTERNAL_ERROR",
                    "An unexpected error occurred. Our team has been notified.",
                    fmt.Errorf("panic: %v", err))
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

## Section 9: Security Testing

```go
// security_test.go
package security_test

import (
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestSSRFBlocksInternalIPs(t *testing.T) {
    blocked := []string{
        "http://127.0.0.1/secret",
        "http://localhost/admin",
        "http://10.0.0.1/internal",
        "http://172.16.0.1/private",
        "http://192.168.1.1/router",
        "http://169.254.169.254/latest/meta-data/",  // AWS IMDS
        "http://[::1]/ipv6-localhost",
    }

    for _, url := range blocked {
        t.Run(url, func(t *testing.T) {
            err := security.ValidateURL(url, nil)
            assert.Error(t, err, "should block internal URL: %s", url)
        })
    }
}

func TestSSRFAllowsExternalURLs(t *testing.T) {
    allowed := []string{
        "https://api.stripe.com/v1/charges",
        "https://hooks.slack.com/services/abc/def",
        "https://api.sendgrid.com/v3/mail/send",
    }

    for _, url := range allowed {
        t.Run(url, func(t *testing.T) {
            err := security.ValidateURL(url, nil)
            assert.NoError(t, err, "should allow external URL: %s", url)
        })
    }
}

func TestSecureHeadersPresent(t *testing.T) {
    handler := middleware.SecureHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    }))

    req := httptest.NewRequest("GET", "/", nil)
    rr := httptest.NewRecorder()
    handler.ServeHTTP(rr, req)

    requiredHeaders := map[string]string{
        "X-Content-Type-Options":    "nosniff",
        "X-Frame-Options":           "DENY",
        "Strict-Transport-Security": "",  // just check presence
        "Content-Security-Policy":   "",
        "Referrer-Policy":           "",
        "Permissions-Policy":        "",
    }

    for header, expected := range requiredHeaders {
        val := rr.Header().Get(header)
        require.NotEmpty(t, val, "Header %s should be set", header)
        if expected != "" {
            assert.Equal(t, expected, val)
        }
    }
}

func TestPathTraversalBlocked(t *testing.T) {
    baseDir := t.TempDir()

    malicious := []string{
        "../../etc/passwd",
        "../../../root/.ssh/id_rsa",
        "subfolder/../../sensitive.txt",
        "/absolute/path",
        "file\x00.txt",
    }

    for _, path := range malicious {
        t.Run(path, func(t *testing.T) {
            _, err := security.SafeFilePath(baseDir, path)
            assert.Error(t, err, "should block: %s", path)
        })
    }
}

func TestXSSStripped(t *testing.T) {
    inputs := []struct {
        input    string
        expected string
    }{
        {`<script>alert('xss')</script>Hello`, "Hello"},
        {`<img src=x onerror=alert(1)>World`, "World"},
        {`Normal text`, "Normal text"},
        {`<b>Bold</b> text`, "Bold text"},  // strict policy strips all HTML
    }

    for _, tt := range inputs {
        t.Run(tt.input, func(t *testing.T) {
            result := security.StripHTML(tt.input)
            assert.Equal(t, tt.expected, result)
        })
    }
}
```

## Section 10: Security Checklist for Go Services

```markdown
# Pre-deployment Security Checklist

## Input Handling
- [ ] All user input validated with strict types and length limits
- [ ] File uploads: type validation, size limits, safe filename, non-web-accessible storage
- [ ] No direct user input in SQL queries (parameterized only)
- [ ] Dynamic ORDER BY / table names validated against allowlists
- [ ] URL parameters: path traversal, null bytes, control chars rejected

## SSRF Prevention
- [ ] All user-supplied URLs validated before HTTP requests
- [ ] SafeHTTPClient used for webhook/remote URL fetching
- [ ] Internal IP ranges blocked at dial time
- [ ] Redirect chains validated, max redirects enforced

## Output Security
- [ ] HTML output escaped (html/template handles this automatically)
- [ ] JSON API responses use json.Marshal (never manual string building)
- [ ] Error responses: safe messages only, details logged not returned
- [ ] No stack traces, SQL errors, or internal paths in responses

## HTTP Security
- [ ] HTTPS enforced (HSTS header set)
- [ ] Secure headers middleware applied to all routes
- [ ] CSP configured for front-end routes
- [ ] Server header removed

## Authentication
- [ ] JWT algorithm validated (reject 'none', only allow RS256/ES256)
- [ ] Token expiry enforced
- [ ] Session invalidation on logout
- [ ] Rate limiting on auth endpoints

## Dependencies
- [ ] go mod tidy && go mod verify
- [ ] govulncheck ./... run in CI
- [ ] gosec ./... run in CI
- [ ] Container image scanned with Trivy
```

Security is a depth problem — each layer catches what the previous layer misses. The defenses in this guide (SSRF-blocking HTTP clients, parameterized queries, XSS sanitization, secure headers, and JWT algorithm validation) address the attacks most likely to affect production Go services.
