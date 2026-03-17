---
title: "SAML SSO in Go: Enterprise Authentication with Identity Providers"
date: 2028-10-14T00:00:00-05:00
draft: false
tags: ["Go", "SAML", "SSO", "Security", "Authentication"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement SAML 2.0 Single Sign-On in Go with the crewjam/saml library, covering SP-initiated and IdP-initiated flows, Okta/Azure AD integration, attribute mapping, session management, and certificate rotation."
more_link: "yes"
url: "/go-saml-sso-enterprise-authentication-guide/"
---

Enterprise applications that need to integrate with corporate identity providers — Okta, Azure AD, ADFS, Ping, OneLogin — must implement SAML 2.0. While OAuth2/OIDC is the modern preference for new integrations, SAML remains the dominant protocol in large organizations that have standardized on it for their application catalog. Getting SAML right in Go requires understanding the protocol flow, proper XML canonicalization, certificate management, and the session lifecycle that follows a successful assertion.

This guide builds a complete SAML Service Provider in Go using the `crewjam/saml` library, covering SP-initiated SSO, IdP-initiated SSO, attribute mapping, session management, and operational concerns like certificate rotation and debugging.

<!--more-->

# SAML SSO in Go: Enterprise Authentication with Identity Providers

## SAML 2.0 Protocol Overview

SAML 2.0 exchanges XML assertions between three parties:

- **User (Principal)**: the person logging in via a browser
- **Identity Provider (IdP)**: Okta, Azure AD, ADFS — holds credentials and asserts identity
- **Service Provider (SP)**: your Go application — consumes assertions and establishes sessions

### SP-Initiated Flow (most common)

```
User                    SP (your app)                IdP
 │                           │                         │
 │  GET /protected           │                         │
 │──────────────────────────▶│                         │
 │                           │                         │
 │  302 to IdP with          │                         │
 │  SAMLRequest (base64)     │                         │
 │◀──────────────────────────│                         │
 │                           │                         │
 │  POST /idp/sso with SAMLRequest                     │
 │────────────────────────────────────────────────────▶│
 │                           │                         │
 │  User authenticates with IdP                        │
 │◀────────────────────────────────────────────────────│
 │                           │                         │
 │  POST /saml/acs with SAMLResponse (signed XML)      │
 │──────────────────────────▶│                         │
 │                           │  validate signature,    │
 │                           │  decrypt assertion,     │
 │                           │  extract attributes     │
 │  Set-Cookie: session_id   │                         │
 │  302 to /protected        │                         │
 │◀──────────────────────────│                         │
```

### IdP-Initiated Flow

In this flow, the user starts at the IdP portal (e.g., the Okta dashboard), clicks your application tile, and the IdP POSTs directly to your ACS URL without a prior SAMLRequest. The SP must handle unsolicited responses and validate the assertion timestamp and audience restriction.

## Dependencies and Project Setup

```bash
go get github.com/crewjam/saml@v0.4.14
go get github.com/gorilla/sessions@v1.3.0
go get github.com/google/uuid@v1.6.0
```

```
saml-service/
├── cmd/server/main.go
├── internal/
│   ├── auth/
│   │   ├── saml.go          # SP configuration and middleware
│   │   ├── session.go       # session store and user model
│   │   └── attributes.go    # attribute extraction helpers
│   └── handlers/
│       └── app.go           # protected application handlers
├── certs/
│   ├── sp.key               # SP private key (generated)
│   └── sp.crt               # SP certificate (self-signed or CA-signed)
└── go.mod
```

## Generating SP Certificates

The SP certificate is used to sign outgoing AuthnRequests (optional but recommended) and to decrypt encrypted assertions from the IdP. Use a 2048-bit or 4096-bit RSA key.

```bash
# Generate SP key pair (valid for 10 years)
openssl req -x509 -newkey rsa:4096 -keyout certs/sp.key -out certs/sp.crt \
  -days 3650 -nodes \
  -subj "/C=US/ST=CA/O=YourOrg/CN=app.yourorg.com"

# Verify the certificate
openssl x509 -in certs/sp.crt -text -noout | grep -E "Subject:|Not After"
```

## Implementing the SAML Service Provider

```go
// internal/auth/saml.go
package auth

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"net/url"
	"os"

	"github.com/crewjam/saml"
	"github.com/crewjam/saml/samlsp"
)

// SAMLMiddleware wraps crewjam/saml's middleware with our session handling.
type SAMLMiddleware struct {
	*samlsp.Middleware
	sessions SessionStore
}

// Config holds all SAML SP configuration.
type Config struct {
	// EntityID is the SP's unique identifier — must match what is registered in the IdP.
	EntityID string
	// RootURL is the base URL of the SP (e.g., https://app.yourorg.com).
	RootURL string
	// ACSPath is the Assertion Consumer Service path.
	ACSPath string
	// MetadataPath is where the SP serves its metadata XML.
	MetadataPath string
	// KeyFile is the path to the SP's private key PEM file.
	KeyFile string
	// CertFile is the path to the SP's certificate PEM file.
	CertFile string
	// IdPMetadataURL is the URL to fetch IdP metadata from.
	// Alternatively, set IdPMetadataXML to use a static file.
	IdPMetadataURL string
	// IdPMetadataXML is the path to a local IdP metadata XML file.
	IdPMetadataXML string
}

// NewSAMLMiddleware creates a configured SAML SP middleware.
func NewSAMLMiddleware(cfg Config, sessions SessionStore) (*SAMLMiddleware, error) {
	// Load SP key pair
	keyPair, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("load SP key pair: %w", err)
	}
	keyPair.Leaf, err = x509.ParseCertificate(keyPair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse SP certificate: %w", err)
	}

	rootURL, err := url.Parse(cfg.RootURL)
	if err != nil {
		return nil, fmt.Errorf("parse root URL: %w", err)
	}

	// Fetch or load IdP metadata
	var idpMetadata *saml.EntityDescriptor
	if cfg.IdPMetadataURL != "" {
		idpMetadata, err = samlsp.FetchMetadata(
			http.DefaultContext(),
			http.DefaultClient,
			*mustParseURL(cfg.IdPMetadataURL),
		)
		if err != nil {
			return nil, fmt.Errorf("fetch IdP metadata from %s: %w", cfg.IdPMetadataURL, err)
		}
	} else if cfg.IdPMetadataXML != "" {
		data, err := os.ReadFile(cfg.IdPMetadataXML)
		if err != nil {
			return nil, fmt.Errorf("read IdP metadata file: %w", err)
		}
		idpMetadata, err = samlsp.ParseMetadata(data)
		if err != nil {
			return nil, fmt.Errorf("parse IdP metadata: %w", err)
		}
	} else {
		return nil, fmt.Errorf("either IdPMetadataURL or IdPMetadataXML must be set")
	}

	opts := samlsp.Options{
		URL:         *rootURL,
		Key:         keyPair.PrivateKey,
		Certificate: keyPair.Leaf,
		IDPMetadata: idpMetadata,
		// Sign outgoing AuthnRequests (recommended for security)
		SignRequest: true,
		// Allow IdP-initiated SSO (handle unsolicited responses)
		AllowIDPInitiated: true,
		// Use cookies for session state
		CookieName:     "saml_session",
		CookieMaxAge:   0, // session cookie (expires on browser close)
		CookieSameSite: http.SameSiteLaxMode,
		CookieSecure:   true,
	}

	sp, err := samlsp.New(opts)
	if err != nil {
		return nil, fmt.Errorf("create SAML SP: %w", err)
	}

	// Override the session provider to use our own store.
	sp.Session = &sessionProvider{store: sessions}

	return &SAMLMiddleware{
		Middleware: sp,
		sessions:   sessions,
	}, nil
}

func mustParseURL(rawURL string) *url.URL {
	u, err := url.Parse(rawURL)
	if err != nil {
		panic(fmt.Sprintf("invalid URL %q: %v", rawURL, err))
	}
	return u
}
```

## Session Management

After the SAML assertion is validated, you need to extract attributes and create an application session. The `crewjam/saml` library stores minimal SAML token data in a signed cookie, but production apps need a server-side session with the full user profile.

```go
// internal/auth/session.go
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/crewjam/saml"
	"github.com/crewjam/saml/samlsp"
	"github.com/gorilla/sessions"
)

// User represents an authenticated user with attributes from the SAML assertion.
type User struct {
	NameID      string            `json:"name_id"`
	Email       string            `json:"email"`
	DisplayName string            `json:"display_name"`
	FirstName   string            `json:"first_name"`
	LastName    string            `json:"last_name"`
	Groups      []string          `json:"groups"`
	Department  string            `json:"department"`
	RawAttrs    map[string]string `json:"raw_attrs,omitempty"`
}

// SessionStore is the interface for session persistence.
type SessionStore interface {
	Get(r *http.Request) (*User, error)
	Save(w http.ResponseWriter, r *http.Request, user *User) error
	Delete(w http.ResponseWriter, r *http.Request) error
}

type cookieSessionStore struct {
	store sessions.Store
}

func NewCookieSessionStore(secret []byte) SessionStore {
	store := sessions.NewCookieStore(secret)
	store.Options = &sessions.Options{
		Path:     "/",
		MaxAge:   8 * 60 * 60, // 8 hours
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	}
	return &cookieSessionStore{store: store}
}

func (s *cookieSessionStore) Get(r *http.Request) (*User, error) {
	sess, err := s.store.Get(r, "app_session")
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	data, ok := sess.Values["user"].([]byte)
	if !ok {
		return nil, nil
	}
	var user User
	if err := json.Unmarshal(data, &user); err != nil {
		return nil, fmt.Errorf("decode user: %w", err)
	}
	return &user, nil
}

func (s *cookieSessionStore) Save(w http.ResponseWriter, r *http.Request, user *User) error {
	sess, _ := s.store.Get(r, "app_session")
	data, err := json.Marshal(user)
	if err != nil {
		return fmt.Errorf("encode user: %w", err)
	}
	sess.Values["user"] = data
	sess.Values["created_at"] = time.Now().Unix()
	return sess.Save(r, w)
}

func (s *cookieSessionStore) Delete(w http.ResponseWriter, r *http.Request) error {
	sess, _ := s.store.Get(r, "app_session")
	sess.Options.MaxAge = -1
	return sess.Save(r, w)
}

// sessionProvider implements samlsp.SessionProvider and bridges SAML assertions
// to our application session store.
type sessionProvider struct {
	store SessionStore
}

func (sp *sessionProvider) CreateSession(w http.ResponseWriter, r *http.Request, assertion *saml.Assertion) error {
	user := extractUserFromAssertion(assertion)
	return sp.store.Save(w, r, user)
}

func (sp *sessionProvider) DeleteSession(w http.ResponseWriter, r *http.Request) error {
	return sp.store.Delete(w, r)
}

func (sp *sessionProvider) GetSession(r *http.Request) (samlsp.Session, error) {
	user, err := sp.store.Get(r)
	if err != nil || user == nil {
		return nil, samlsp.ErrNoSession
	}
	return user, nil
}

// User implements samlsp.Session interface (just needs to be a non-nil value).
func (u *User) GetNameID() string { return u.NameID }

// UserFromContext retrieves the authenticated user from the request context.
// crewjam/saml stores the session in the context after authentication.
func UserFromContext(ctx context.Context) *User {
	sess := samlsp.SessionFromContext(ctx)
	if sess == nil {
		return nil
	}
	user, ok := sess.(*User)
	if !ok {
		return nil
	}
	return user
}
```

## Attribute Extraction and Mapping

Different IdPs use different attribute names for the same concepts. Build a flexible mapper that handles Okta, Azure AD, and ADFS conventions:

```go
// internal/auth/attributes.go
package auth

import (
	"strings"

	"github.com/crewjam/saml"
)

// extractUserFromAssertion pulls standard attributes from a SAML assertion.
// Handles attribute name variations across Okta, Azure AD, and ADFS.
func extractUserFromAssertion(assertion *saml.Assertion) *User {
	attrs := buildAttrMap(assertion)
	user := &User{
		NameID:   assertion.Subject.NameID.Value,
		RawAttrs: attrs,
	}

	// Email — multiple possible attribute names
	user.Email = firstNonEmpty(attrs,
		"email",
		"mail",
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
	)
	// Fall back to NameID if it looks like an email
	if user.Email == "" && strings.Contains(user.NameID, "@") {
		user.Email = user.NameID
	}

	// Display name
	user.DisplayName = firstNonEmpty(attrs,
		"displayName",
		"http://schemas.microsoft.com/identity/claims/displayname",
		"cn",
	)

	// First name
	user.FirstName = firstNonEmpty(attrs,
		"firstName",
		"givenName",
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
	)

	// Last name
	user.LastName = firstNonEmpty(attrs,
		"lastName",
		"sn",
		"surname",
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
	)

	// Department
	user.Department = firstNonEmpty(attrs,
		"department",
		"http://schemas.microsoft.com/identity/claims/department",
	)

	// Groups / roles — may be multi-valued
	user.Groups = extractGroups(assertion)

	return user
}

// buildAttrMap converts SAML attributes to a flat map (first value wins for multi-valued).
func buildAttrMap(assertion *saml.Assertion) map[string]string {
	m := make(map[string]string)
	for _, stmt := range assertion.AttributeStatements {
		for _, attr := range stmt.Attributes {
			name := attr.Name
			// Also index by FriendlyName if present
			if attr.FriendlyName != "" {
				if len(attr.Values) > 0 {
					m[attr.FriendlyName] = attr.Values[0].Value
				}
			}
			if len(attr.Values) > 0 {
				m[name] = attr.Values[0].Value
			}
		}
	}
	return m
}

// extractGroups handles multi-valued group membership attributes.
func extractGroups(assertion *saml.Assertion) []string {
	groupAttrNames := []string{
		"groups",
		"memberOf",
		"http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
		"http://schemas.xmlsoap.org/claims/Group",
	}

	for _, stmt := range assertion.AttributeStatements {
		for _, attr := range stmt.Attributes {
			for _, name := range groupAttrNames {
				if attr.Name == name || attr.FriendlyName == name {
					groups := make([]string, 0, len(attr.Values))
					for _, v := range attr.Values {
						if v.Value != "" {
							groups = append(groups, v.Value)
						}
					}
					return groups
				}
			}
		}
	}
	return nil
}

func firstNonEmpty(m map[string]string, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != "" {
			return v
		}
	}
	return ""
}
```

## Wiring Routes in main.go

```go
// cmd/server/main.go
package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/yourorg/saml-service/internal/auth"
	"github.com/yourorg/saml-service/internal/handlers"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	sessionStore := auth.NewCookieSessionStore([]byte(os.Getenv("SESSION_SECRET")))

	samlCfg := auth.Config{
		EntityID:       "https://app.yourorg.com",
		RootURL:        "https://app.yourorg.com",
		ACSPath:        "/saml/acs",
		MetadataPath:   "/saml/metadata",
		KeyFile:        "certs/sp.key",
		CertFile:       "certs/sp.crt",
		IdPMetadataURL: os.Getenv("IDP_METADATA_URL"),
		// For Okta: https://yourorg.okta.com/app/exkxxxxxxxxxx/sso/saml/metadata
		// For Azure AD: https://login.microsoftonline.com/{tenant-id}/federationmetadata/2007-06/federationmetadata.xml
		// For ADFS: https://adfs.yourorg.com/federationmetadata/2007-06/federationmetadata.xml
	}

	samlMiddleware, err := auth.NewSAMLMiddleware(samlCfg, sessionStore)
	if err != nil {
		logger.Error("failed to initialize SAML", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()

	// SAML endpoints — must NOT be behind auth middleware
	mux.Handle("/saml/", samlMiddleware)
	// The metadata endpoint is served at /saml/metadata automatically by crewjam/saml

	// Public routes
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Protected routes — wrap with SAML authentication middleware
	appHandler := handlers.NewAppHandler(sessionStore, logger)
	mux.Handle("/", samlMiddleware.RequireAccount(appHandler))

	// SLO (Single Logout) handler
	mux.HandleFunc("/logout", func(w http.ResponseWriter, r *http.Request) {
		if err := sessionStore.Delete(w, r); err != nil {
			logger.Error("delete session", "error", err)
		}
		// Optionally initiate IdP SLO
		http.Redirect(w, r, "/", http.StatusFound)
	})

	logger.Info("server starting", "addr", ":8080")
	if err := http.ListenAndServeTLS(":8080", "certs/tls.crt", "certs/tls.key",
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			mux.ServeHTTP(w, r)
		}),
	); err != nil {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}
```

## Protected Handler Example

```go
// internal/handlers/app.go
package handlers

import (
	"html/template"
	"log/slog"
	"net/http"
	"strings"

	"github.com/yourorg/saml-service/internal/auth"
)

type AppHandler struct {
	sessions auth.SessionStore
	logger   *slog.Logger
}

func NewAppHandler(sessions auth.SessionStore, logger *slog.Logger) *AppHandler {
	return &AppHandler{sessions: sessions, logger: logger}
}

func (h *AppHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	user, err := h.sessions.Get(r)
	if err != nil || user == nil {
		http.Redirect(w, r, "/saml/login", http.StatusFound)
		return
	}

	// Authorization: check group membership
	if r.URL.Path == "/admin" && !h.userIsAdmin(user) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	tmpl := template.Must(template.New("profile").Parse(`
<!DOCTYPE html>
<html>
<head><title>Profile</title></head>
<body>
  <h1>Welcome, {{.DisplayName}}</h1>
  <p>Email: {{.Email}}</p>
  <p>Department: {{.Department}}</p>
  <p>Groups: {{.GroupList}}</p>
  <a href="/logout">Logout</a>
</body>
</html>`))

	data := struct {
		DisplayName string
		Email       string
		Department  string
		GroupList   string
	}{
		DisplayName: user.DisplayName,
		Email:       user.Email,
		Department:  user.Department,
		GroupList:   strings.Join(user.Groups, ", "),
	}

	if err := tmpl.Execute(w, data); err != nil {
		h.logger.Error("template execute", "error", err)
	}
}

func (h *AppHandler) userIsAdmin(user *auth.User) bool {
	for _, g := range user.Groups {
		if g == "platform-admins" || g == "CN=Admins,OU=Groups,DC=yourorg,DC=com" {
			return true
		}
	}
	return false
}
```

## Configuring Okta as the IdP

In the Okta Admin Console:

1. Applications -> Create App Integration -> SAML 2.0
2. Set **Single sign-on URL** to `https://app.yourorg.com/saml/acs`
3. Set **Audience URI (SP Entity ID)** to `https://app.yourorg.com`
4. Under **Attribute Statements**, add:
   - `email` -> `user.email`
   - `firstName` -> `user.firstName`
   - `lastName` -> `user.lastName`
   - `displayName` -> `user.displayName`
5. Under **Group Attribute Statements**, add:
   - `groups` -> Matches regex: `.*` (or specific group filter)
6. Copy the **Metadata URL** and set it as `IDP_METADATA_URL`

## Configuring Azure AD as the IdP

In the Azure Portal -> Enterprise Applications -> New Application -> Non-gallery:

1. Set up **Single Sign-On** -> SAML
2. Basic SAML Configuration:
   - **Identifier (Entity ID)**: `https://app.yourorg.com`
   - **Reply URL (ACS)**: `https://app.yourorg.com/saml/acs`
3. Attributes & Claims — Azure AD defaults:
   - `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` -> `user.mail`
   - `http://schemas.microsoft.com/identity/claims/displayname` -> `user.displayname`
4. Download **Federation Metadata XML** or note the **App Federation Metadata URL**

## Certificate Rotation

SP certificates expire. Plan the rotation before they do:

```bash
# Check current certificate expiry
openssl x509 -in certs/sp.crt -noout -enddate
# notAfter=Oct 11 00:00:00 2034 GMT

# Generate new certificate (keep old one active during transition)
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/sp-new.key -out certs/sp-new.crt \
  -days 3650 -nodes \
  -subj "/C=US/ST=CA/O=YourOrg/CN=app.yourorg.com"
```

Rotation process:

1. Add the new SP certificate to your IdP as a secondary signing certificate (do not remove the old one yet)
2. Deploy the new SP certificate to your application
3. Verify SSO works with the new certificate
4. Remove the old SP certificate from the IdP
5. Schedule the next rotation

For automated rotation, store the key material in a secrets manager and reload it without pod restarts:

```go
// Hot-reload SP certificate from Vault
func reloadCertificate(sp *SAMLMiddleware, keyPath, certPath string) error {
	keyPair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return err
	}
	keyPair.Leaf, err = x509.ParseCertificate(keyPair.Certificate[0])
	if err != nil {
		return err
	}
	sp.ServiceProvider.Key = keyPair.PrivateKey
	sp.ServiceProvider.Certificate = keyPair.Leaf
	return nil
}
```

## Debugging SAML

**SAML Tracer** (Firefox/Chrome extension): decodes base64-encoded SAMLRequests and SAMLResponses in browser requests, showing the full XML. Essential for debugging attribute mapping issues.

Decode a SAMLResponse from the terminal:

```bash
# Capture the SAMLResponse from browser devtools network tab, then:
echo 'PHNhbWxwOlJlc3BvbnNlIHhtbG5zOnNhbWxwPSJ1cm46b2FzaXM6bmFtZXM6dGM6U0FNTDoy...' | \
  base64 -d | \
  python3 -c "import sys,zlib; data=sys.stdin.buffer.read(); \
    print(zlib.decompress(data, -15).decode() if data[:2]==b'x\x9c' else data.decode())" | \
  xmllint --format -
```

Common issues and fixes:

```
Error: "assertion is expired"
Fix: Sync server time (NTP). SAML assertions are time-sensitive (5-10 minute window).

Error: "audience restriction mismatch"
Fix: The Audience element in the assertion must exactly match the SP Entity ID.
     Check for trailing slashes: "https://app.yourorg.com" vs "https://app.yourorg.com/"

Error: "invalid signature"
Fix: Ensure the IdP is signing with the certificate in their metadata.
     Some IdPs sign the Response, some sign the Assertion, some sign both.
     crewjam/saml accepts both by default.

Error: "no session" on IdP-initiated SSO
Fix: Set AllowIDPInitiated: true in samlsp.Options.

Error: POST /saml/acs returns 404
Fix: Mount the SAML handler at "/saml/" (with trailing slash) not "/saml".
```

## Production Hardening

```go
// Enforce HTTPS for all SAML endpoints
func httpsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Forwarded-Proto") == "http" {
			http.Redirect(w, r,
				"https://"+r.Host+r.RequestURI,
				http.StatusMovedPermanently,
			)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Log SAML authentication events for audit trail
func auditSAMLLogin(user *auth.User, r *http.Request) {
	slog.Info("saml_login",
		"user_email", user.Email,
		"name_id", user.NameID,
		"remote_addr", r.RemoteAddr,
		"user_agent", r.UserAgent(),
		"groups", user.Groups,
	)
}
```

The SP metadata endpoint (`/saml/metadata`) serves the XML document you share with your IdP during registration. Share this URL with your IdP administrator — most modern IdPs can fetch it automatically and update automatically when your SP certificate rotates, simplifying ongoing maintenance.
