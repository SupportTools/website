---
title: "Go OAuth2 and OIDC Integration: Building Secure Authentication Flows"
date: 2030-08-23T00:00:00-05:00
draft: false
tags: ["Go", "OAuth2", "OIDC", "Keycloak", "Auth0", "JWT", "Security", "Authentication"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to building secure OAuth2 and OIDC authentication in Go, covering PKCE flows, JWT validation, refresh token rotation, Keycloak and Auth0 integration, and middleware for protected routes."
more_link: "yes"
url: "/go-oauth2-oidc-integration-secure-authentication-flows/"
---

Authentication in enterprise Go services is not simply a matter of adding a library. It requires careful handling of token lifetimes, secure storage of client credentials, proper PKCE implementation to prevent authorization code interception, and robust JWT validation that does not silently accept tampered tokens. This post builds a complete OAuth2 and OIDC integration from the foundation up, covering the golang.org/x/oauth2 package, coreos/go-oidc for discovery and validation, and the middleware patterns that enforce authentication across HTTP handlers.

<!--more-->

## OAuth2 and OIDC Foundations

OAuth2 is an authorization framework. OpenID Connect (OIDC) is an identity layer built on top of OAuth2 that standardizes how identity tokens are issued and validated. In enterprise environments, the typical flow for a web application is:

1. The application redirects the user to the Identity Provider (IdP) authorization endpoint.
2. The user authenticates with the IdP.
3. The IdP redirects back to the application's callback URL with an authorization code.
4. The application exchanges the code for an access token, ID token, and optionally a refresh token.
5. The application validates the ID token (a JWT) to establish the user's identity.
6. The application uses the access token to call protected APIs.

PKCE (Proof Key for Code Exchange, pronounced "pixie") extends this flow to prevent an attacker who intercepts the authorization code from exchanging it for tokens. It is mandatory for public clients (SPAs, mobile apps) and strongly recommended for confidential clients in modern security postures.

## Dependencies and Module Setup

```go
// go.mod
module enterprise.example.com/auth-service

go 1.22

require (
    golang.org/x/oauth2 v0.21.0
    github.com/coreos/go-oidc/v3 v3.10.0
    github.com/golang-jwt/jwt/v5 v5.2.1
    github.com/go-chi/chi/v5 v5.0.12
    golang.org/x/crypto v0.24.0
)
```

Install dependencies:

```bash
go get golang.org/x/oauth2@latest
go get github.com/coreos/go-oidc/v3@latest
go get github.com/golang-jwt/jwt/v5@latest
go get github.com/go-chi/chi/v5@latest
```

## OIDC Provider Discovery

OIDC providers publish their configuration at a well-known discovery endpoint (`/.well-known/openid-configuration`). The `go-oidc` library handles discovery automatically:

```go
// pkg/auth/provider.go
package auth

import (
    "context"
    "fmt"
    "time"

    "github.com/coreos/go-oidc/v3/oidc"
    "golang.org/x/oauth2"
)

// ProviderConfig holds the OIDC provider configuration.
type ProviderConfig struct {
    // IssuerURL is the base URL of the OIDC provider.
    // Keycloak: https://keycloak.example.com/realms/myrealm
    // Auth0:    https://your-tenant.auth0.com/
    // Okta:     https://your-org.okta.com
    IssuerURL    string
    ClientID     string
    ClientSecret string
    RedirectURL  string
    Scopes       []string
}

// Provider wraps the OIDC provider and OAuth2 config.
type Provider struct {
    oidcProvider *oidc.Provider
    oauth2Config oauth2.Config
    verifier     *oidc.IDTokenVerifier
    config       ProviderConfig
}

// NewProvider creates a new OIDC provider, performing discovery.
func NewProvider(ctx context.Context, cfg ProviderConfig) (*Provider, error) {
    if cfg.IssuerURL == "" {
        return nil, fmt.Errorf("issuer URL must not be empty")
    }

    // Discovery: fetches /.well-known/openid-configuration
    // Retries with backoff for transient failures at startup
    var oidcProvider *oidc.Provider
    var err error
    for attempt := 0; attempt < 5; attempt++ {
        oidcProvider, err = oidc.NewProvider(ctx, cfg.IssuerURL)
        if err == nil {
            break
        }
        if attempt < 4 {
            sleepDur := time.Duration(1<<attempt) * time.Second
            time.Sleep(sleepDur)
        }
    }
    if err != nil {
        return nil, fmt.Errorf("OIDC discovery failed for %s: %w", cfg.IssuerURL, err)
    }

    scopes := cfg.Scopes
    if len(scopes) == 0 {
        scopes = []string{oidc.ScopeOpenID, "profile", "email", "offline_access"}
    }

    oauth2Config := oauth2.Config{
        ClientID:     cfg.ClientID,
        ClientSecret: cfg.ClientSecret,
        RedirectURL:  cfg.RedirectURL,
        Endpoint:     oidcProvider.Endpoint(),
        Scopes:       scopes,
    }

    verifier := oidcProvider.Verifier(&oidc.Config{
        ClientID: cfg.ClientID,
    })

    return &Provider{
        oidcProvider: oidcProvider,
        oauth2Config: oauth2Config,
        verifier:     verifier,
        config:       cfg,
    }, nil
}
```

## PKCE Implementation

PKCE requires generating a cryptographically random verifier, deriving a challenge from it, and sending the challenge with the authorization request. The verifier is sent during the token exchange.

```go
// pkg/auth/pkce.go
package auth

import (
    "crypto/rand"
    "crypto/sha256"
    "encoding/base64"
    "fmt"
)

const (
    codeVerifierLength = 64
)

// PKCEChallenge holds the PKCE code verifier and its derived challenge.
type PKCEChallenge struct {
    CodeVerifier  string
    CodeChallenge string
    Method        string
}

// GeneratePKCE creates a new PKCE code verifier and challenge.
// The verifier must be stored in the user's session and sent during token exchange.
func GeneratePKCE() (*PKCEChallenge, error) {
    verifierBytes := make([]byte, codeVerifierLength)
    if _, err := rand.Read(verifierBytes); err != nil {
        return nil, fmt.Errorf("failed to generate PKCE verifier: %w", err)
    }

    // Base64url encode without padding
    verifier := base64.RawURLEncoding.EncodeToString(verifierBytes)

    // Derive challenge: SHA256(verifier) base64url encoded
    h := sha256.New()
    h.Write([]byte(verifier))
    challenge := base64.RawURLEncoding.EncodeToString(h.Sum(nil))

    return &PKCEChallenge{
        CodeVerifier:  verifier,
        CodeChallenge: challenge,
        Method:        "S256",
    }, nil
}

// GenerateState creates a cryptographically random state parameter
// to prevent CSRF attacks.
func GenerateState() (string, error) {
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", fmt.Errorf("failed to generate state: %w", err)
    }
    return base64.RawURLEncoding.EncodeToString(b), nil
}
```

## Authorization URL Generation

```go
// pkg/auth/flow.go
package auth

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "golang.org/x/oauth2"
)

// AuthorizationRequest encapsulates a pending authorization flow.
type AuthorizationRequest struct {
    State        string
    Nonce        string
    PKCEVerifier string
    RedirectURL  string
    CreatedAt    time.Time
}

// AuthorizationURL generates the URL to redirect the user to for authentication.
// The returned AuthorizationRequest must be stored in the session keyed by State.
func (p *Provider) AuthorizationURL(ctx context.Context) (url string, req *AuthorizationRequest, err error) {
    state, err := GenerateState()
    if err != nil {
        return "", nil, fmt.Errorf("state generation: %w", err)
    }

    nonce, err := GenerateState() // reuse the same random generation
    if err != nil {
        return "", nil, fmt.Errorf("nonce generation: %w", err)
    }

    pkce, err := GeneratePKCE()
    if err != nil {
        return "", nil, fmt.Errorf("PKCE generation: %w", err)
    }

    authURL := p.oauth2Config.AuthCodeURL(
        state,
        oauth2.AccessTypeOffline, // request refresh token
        oauth2.SetAuthURLParam("nonce", nonce),
        oauth2.SetAuthURLParam("code_challenge", pkce.CodeChallenge),
        oauth2.SetAuthURLParam("code_challenge_method", pkce.Method),
    )

    return authURL, &AuthorizationRequest{
        State:        state,
        Nonce:        nonce,
        PKCEVerifier: pkce.CodeVerifier,
        CreatedAt:    time.Now(),
    }, nil
}

// Exchange exchanges an authorization code for tokens.
// pendingReq must be the AuthorizationRequest stored when the flow was initiated.
func (p *Provider) Exchange(
    ctx context.Context,
    r *http.Request,
    pendingReq *AuthorizationRequest,
) (*TokenSet, error) {
    // Validate state to prevent CSRF
    state := r.URL.Query().Get("state")
    if state != pendingReq.State {
        return nil, fmt.Errorf("state mismatch: potential CSRF attack")
    }

    // Check for authorization errors from the IdP
    if errParam := r.URL.Query().Get("error"); errParam != "" {
        desc := r.URL.Query().Get("error_description")
        return nil, fmt.Errorf("authorization error %s: %s", errParam, desc)
    }

    code := r.URL.Query().Get("code")
    if code == "" {
        return nil, fmt.Errorf("missing authorization code")
    }

    // Exchange code for tokens, sending the PKCE verifier
    token, err := p.oauth2Config.Exchange(
        ctx,
        code,
        oauth2.SetAuthURLParam("code_verifier", pendingReq.PKCEVerifier),
    )
    if err != nil {
        return nil, fmt.Errorf("token exchange failed: %w", err)
    }

    // Extract and validate the ID token
    rawIDToken, ok := token.Extra("id_token").(string)
    if !ok {
        return nil, fmt.Errorf("ID token missing from token response")
    }

    idToken, err := p.verifier.Verify(ctx, rawIDToken)
    if err != nil {
        return nil, fmt.Errorf("ID token verification failed: %w", err)
    }

    // Validate nonce
    var claims struct {
        Nonce string `json:"nonce"`
    }
    if err := idToken.Claims(&claims); err != nil {
        return nil, fmt.Errorf("failed to parse ID token claims: %w", err)
    }
    if claims.Nonce != pendingReq.Nonce {
        return nil, fmt.Errorf("nonce mismatch: potential replay attack")
    }

    return newTokenSet(token, idToken, rawIDToken)
}
```

## TokenSet and Claims Extraction

```go
// pkg/auth/tokens.go
package auth

import (
    "context"
    "fmt"
    "time"

    "github.com/coreos/go-oidc/v3/oidc"
    "golang.org/x/oauth2"
)

// StandardClaims represents the standard OIDC claims found in an ID token.
type StandardClaims struct {
    Subject       string   `json:"sub"`
    Email         string   `json:"email"`
    EmailVerified bool     `json:"email_verified"`
    Name          string   `json:"name"`
    GivenName     string   `json:"given_name"`
    FamilyName    string   `json:"family_name"`
    Groups        []string `json:"groups"`
    Roles         []string `json:"roles"`
    // Keycloak-specific
    RealmAccess   *RealmAccess `json:"realm_access,omitempty"`
}

// RealmAccess is a Keycloak-specific claim containing realm roles.
type RealmAccess struct {
    Roles []string `json:"roles"`
}

// TokenSet holds all tokens returned from an OAuth2/OIDC exchange.
type TokenSet struct {
    AccessToken  string
    RefreshToken string
    IDToken      string
    Expiry       time.Time
    Claims       *StandardClaims
}

func newTokenSet(token *oauth2.Token, idToken *oidc.IDToken, rawIDToken string) (*TokenSet, error) {
    claims := &StandardClaims{}
    if err := idToken.Claims(claims); err != nil {
        return nil, fmt.Errorf("claim extraction: %w", err)
    }

    ts := &TokenSet{
        AccessToken:  token.AccessToken,
        RefreshToken: token.RefreshToken,
        IDToken:      rawIDToken,
        Expiry:       token.Expiry,
        Claims:       claims,
    }
    return ts, nil
}

// IsExpired returns true if the access token has expired with a 30-second buffer.
func (ts *TokenSet) IsExpired() bool {
    return time.Now().After(ts.Expiry.Add(-30 * time.Second))
}

// Refresh exchanges the refresh token for a new token set.
func (p *Provider) Refresh(ctx context.Context, refreshToken string) (*TokenSet, error) {
    tokenSource := p.oauth2Config.TokenSource(ctx, &oauth2.Token{
        RefreshToken: refreshToken,
    })

    newToken, err := tokenSource.Token()
    if err != nil {
        return nil, fmt.Errorf("token refresh failed: %w", err)
    }

    rawIDToken, ok := newToken.Extra("id_token").(string)
    if !ok {
        // Some providers do not return a new ID token on refresh.
        // Fall back to access token validation.
        return &TokenSet{
            AccessToken:  newToken.AccessToken,
            RefreshToken: newToken.RefreshToken,
            Expiry:       newToken.Expiry,
        }, nil
    }

    idToken, err := p.verifier.Verify(ctx, rawIDToken)
    if err != nil {
        return nil, fmt.Errorf("ID token verification after refresh: %w", err)
    }

    return newTokenSet(newToken, idToken, rawIDToken)
}
```

## Session Store for Token Persistence

Tokens must be stored securely between requests. Using encrypted cookies backed by AES-GCM is a common pattern for stateless servers:

```go
// pkg/auth/session.go
package auth

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"
)

const (
    sessionCookieName = "auth_session"
    sessionCookiePath = "/"
    maxCookieAge      = 8 * 60 * 60 // 8 hours
)

// SessionData holds the serialized token set stored in the encrypted cookie.
type SessionData struct {
    AccessToken  string          `json:"at"`
    RefreshToken string          `json:"rt"`
    IDToken      string          `json:"idt"`
    Expiry       time.Time       `json:"exp"`
    Claims       *StandardClaims `json:"claims"`

    // Pending auth request (during the authorization flow)
    PendingState  string `json:"ps,omitempty"`
    PendingNonce  string `json:"pn,omitempty"`
    PendingPKCE   string `json:"ppkce,omitempty"`
    OriginalURL   string `json:"orig_url,omitempty"`
}

// SessionStore encrypts and decrypts session data in cookies.
type SessionStore struct {
    gcm    cipher.AEAD
    secure bool // set true in production (HTTPS only)
}

// NewSessionStore creates a session store from a 32-byte AES key.
func NewSessionStore(key []byte, secure bool) (*SessionStore, error) {
    if len(key) != 32 {
        return nil, fmt.Errorf("session key must be exactly 32 bytes, got %d", len(key))
    }
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, fmt.Errorf("AES cipher: %w", err)
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, fmt.Errorf("GCM: %w", err)
    }
    return &SessionStore{gcm: gcm, secure: secure}, nil
}

// Save encrypts and writes session data to an HTTP cookie.
func (s *SessionStore) Save(w http.ResponseWriter, data *SessionData) error {
    plaintext, err := json.Marshal(data)
    if err != nil {
        return fmt.Errorf("session marshal: %w", err)
    }

    nonce := make([]byte, s.gcm.NonceSize())
    if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
        return fmt.Errorf("nonce generation: %w", err)
    }

    ciphertext := s.gcm.Seal(nonce, nonce, plaintext, nil)
    encoded := base64.RawURLEncoding.EncodeToString(ciphertext)

    http.SetCookie(w, &http.Cookie{
        Name:     sessionCookieName,
        Value:    encoded,
        Path:     sessionCookiePath,
        MaxAge:   maxCookieAge,
        HttpOnly: true,
        Secure:   s.secure,
        SameSite: http.SameSiteLaxMode,
    })
    return nil
}

// Load decrypts and reads session data from an HTTP cookie.
func (s *SessionStore) Load(r *http.Request) (*SessionData, error) {
    cookie, err := r.Cookie(sessionCookieName)
    if err != nil {
        return nil, nil // no session, not an error
    }

    ciphertext, err := base64.RawURLEncoding.DecodeString(cookie.Value)
    if err != nil {
        return nil, fmt.Errorf("session decode: %w", err)
    }

    nonceSize := s.gcm.NonceSize()
    if len(ciphertext) < nonceSize {
        return nil, fmt.Errorf("ciphertext too short")
    }

    nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
    plaintext, err := s.gcm.Open(nil, nonce, ciphertext, nil)
    if err != nil {
        return nil, fmt.Errorf("session decryption failed (tampered?): %w", err)
    }

    data := &SessionData{}
    if err := json.Unmarshal(plaintext, data); err != nil {
        return nil, fmt.Errorf("session unmarshal: %w", err)
    }
    return data, nil
}

// Clear removes the session cookie.
func (s *SessionStore) Clear(w http.ResponseWriter) {
    http.SetCookie(w, &http.Cookie{
        Name:     sessionCookieName,
        Value:    "",
        Path:     sessionCookiePath,
        MaxAge:   -1,
        HttpOnly: true,
        Secure:   s.secure,
    })
}
```

## HTTP Handlers for OAuth2 Flow

```go
// pkg/auth/handlers.go
package auth

import (
    "context"
    "log/slog"
    "net/http"
    "net/url"
)

// Handler implements the HTTP endpoints for the OAuth2/OIDC flow.
type Handler struct {
    provider *Provider
    sessions *SessionStore
    logger   *slog.Logger
}

// NewHandler creates a new auth handler.
func NewHandler(provider *Provider, sessions *SessionStore, logger *slog.Logger) *Handler {
    return &Handler{
        provider: provider,
        sessions: sessions,
        logger:   logger,
    }
}

// Login initiates the OAuth2 authorization flow.
// GET /auth/login?return_to=/dashboard
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
    returnTo := r.URL.Query().Get("return_to")
    if returnTo == "" {
        returnTo = "/"
    }
    // Validate returnTo to prevent open redirect
    if !isLocalURL(returnTo) {
        returnTo = "/"
    }

    authURL, pendingReq, err := h.provider.AuthorizationURL(r.Context())
    if err != nil {
        h.logger.ErrorContext(r.Context(), "failed to generate authorization URL", "error", err)
        http.Error(w, "authentication initialization failed", http.StatusInternalServerError)
        return
    }

    // Store pending auth request in session
    session := &SessionData{
        PendingState: pendingReq.State,
        PendingNonce: pendingReq.Nonce,
        PendingPKCE:  pendingReq.PKCEVerifier,
        OriginalURL:  returnTo,
    }
    if err := h.sessions.Save(w, session); err != nil {
        h.logger.ErrorContext(r.Context(), "failed to save session", "error", err)
        http.Error(w, "session error", http.StatusInternalServerError)
        return
    }

    http.Redirect(w, r, authURL, http.StatusFound)
}

// Callback handles the OAuth2 authorization code callback.
// GET /auth/callback?code=...&state=...
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
    session, err := h.sessions.Load(r)
    if err != nil || session == nil {
        h.logger.WarnContext(r.Context(), "callback with missing or invalid session")
        http.Redirect(w, r, "/auth/login", http.StatusFound)
        return
    }

    pendingReq := &AuthorizationRequest{
        State:        session.PendingState,
        Nonce:        session.PendingNonce,
        PKCEVerifier: session.PendingPKCE,
    }

    tokenSet, err := h.provider.Exchange(r.Context(), r, pendingReq)
    if err != nil {
        h.logger.ErrorContext(r.Context(), "token exchange failed",
            "error", err,
            "remote_addr", r.RemoteAddr,
        )
        http.Error(w, "authentication failed", http.StatusUnauthorized)
        return
    }

    originalURL := session.OriginalURL
    if originalURL == "" {
        originalURL = "/"
    }

    // Replace the pending session with the authenticated session
    authenticatedSession := &SessionData{
        AccessToken:  tokenSet.AccessToken,
        RefreshToken: tokenSet.RefreshToken,
        IDToken:      tokenSet.IDToken,
        Expiry:       tokenSet.Expiry,
        Claims:       tokenSet.Claims,
    }
    if err := h.sessions.Save(w, authenticatedSession); err != nil {
        h.logger.ErrorContext(r.Context(), "failed to save authenticated session", "error", err)
        http.Error(w, "session error", http.StatusInternalServerError)
        return
    }

    h.logger.InfoContext(r.Context(), "user authenticated",
        "subject", tokenSet.Claims.Subject,
        "email", tokenSet.Claims.Email,
    )
    http.Redirect(w, r, originalURL, http.StatusFound)
}

// Logout clears the session and optionally redirects to the IdP end-session endpoint.
// GET /auth/logout
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
    session, _ := h.sessions.Load(r)
    h.sessions.Clear(w)

    if session != nil && session.IDToken != "" {
        // Build the end-session URL (OIDC RP-initiated logout)
        endSessionURL := h.provider.EndSessionURL(session.IDToken, "https://app.example.com")
        if endSessionURL != "" {
            http.Redirect(w, r, endSessionURL, http.StatusFound)
            return
        }
    }
    http.Redirect(w, r, "/", http.StatusFound)
}

// EndSessionURL returns the IdP's end-session URL if supported.
func (p *Provider) EndSessionURL(idTokenHint, postLogoutRedirectURI string) string {
    // The end_session_endpoint is available via discovery claims
    var providerClaims struct {
        EndSessionEndpoint string `json:"end_session_endpoint"`
    }
    if err := p.oidcProvider.Claims(&providerClaims); err != nil {
        return ""
    }
    if providerClaims.EndSessionEndpoint == "" {
        return ""
    }
    params := url.Values{
        "id_token_hint":            {idTokenHint},
        "post_logout_redirect_uri": {postLogoutRedirectURI},
    }
    return providerClaims.EndSessionEndpoint + "?" + params.Encode()
}

func isLocalURL(u string) bool {
    parsed, err := url.Parse(u)
    if err != nil {
        return false
    }
    return parsed.Host == "" && !parsed.IsAbs()
}
```

## Authentication Middleware

```go
// pkg/auth/middleware.go
package auth

import (
    "context"
    "log/slog"
    "net/http"
    "strings"
)

type contextKey string

const (
    contextKeySession = contextKey("auth_session")
    contextKeyClaims  = contextKey("auth_claims")
)

// Middleware provides HTTP middleware for authentication enforcement.
type Middleware struct {
    provider *Provider
    sessions *SessionStore
    logger   *slog.Logger
}

// NewMiddleware creates authentication middleware.
func NewMiddleware(provider *Provider, sessions *SessionStore, logger *slog.Logger) *Middleware {
    return &Middleware{
        provider: provider,
        sessions: sessions,
        logger:   logger,
    }
}

// RequireAuth enforces authentication on HTTP routes.
// Unauthenticated requests are redirected to /auth/login.
// If the access token is expired and a refresh token exists, it is refreshed transparently.
func (m *Middleware) RequireAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        session, err := m.sessions.Load(r)
        if err != nil {
            m.logger.WarnContext(r.Context(), "invalid session cookie",
                "error", err,
                "path", r.URL.Path,
            )
            m.redirectToLogin(w, r)
            return
        }

        if session == nil || session.AccessToken == "" {
            m.redirectToLogin(w, r)
            return
        }

        // Check token expiry and refresh if needed
        if session.Expiry.IsZero() || isTokenExpired(session.Expiry) {
            if session.RefreshToken == "" {
                m.logger.InfoContext(r.Context(), "session expired, no refresh token",
                    "subject", sessionSubject(session),
                )
                m.sessions.Clear(w)
                m.redirectToLogin(w, r)
                return
            }

            newTokenSet, err := m.provider.Refresh(r.Context(), session.RefreshToken)
            if err != nil {
                m.logger.WarnContext(r.Context(), "token refresh failed",
                    "error", err,
                    "subject", sessionSubject(session),
                )
                m.sessions.Clear(w)
                m.redirectToLogin(w, r)
                return
            }

            // Update the session with new tokens
            session.AccessToken = newTokenSet.AccessToken
            if newTokenSet.RefreshToken != "" {
                session.RefreshToken = newTokenSet.RefreshToken
            }
            session.Expiry = newTokenSet.Expiry
            if newTokenSet.IDToken != "" {
                session.IDToken = newTokenSet.IDToken
            }
            if newTokenSet.Claims != nil {
                session.Claims = newTokenSet.Claims
            }

            if err := m.sessions.Save(w, session); err != nil {
                m.logger.ErrorContext(r.Context(), "failed to save refreshed session", "error", err)
                http.Error(w, "session error", http.StatusInternalServerError)
                return
            }
        }

        // Inject session and claims into context
        ctx := context.WithValue(r.Context(), contextKeySession, session)
        if session.Claims != nil {
            ctx = context.WithValue(ctx, contextKeyClaims, session.Claims)
        }

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// RequireRole enforces that the authenticated user has a specific role.
func (m *Middleware) RequireRole(role string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            claims := ClaimsFromContext(r.Context())
            if claims == nil {
                http.Error(w, "unauthorized", http.StatusUnauthorized)
                return
            }

            if !hasRole(claims, role) {
                m.logger.WarnContext(r.Context(), "access denied: missing role",
                    "subject", claims.Subject,
                    "required_role", role,
                    "path", r.URL.Path,
                )
                http.Error(w, "forbidden", http.StatusForbidden)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// BearerTokenAuth validates a Bearer token in the Authorization header.
// Used for API endpoints (not browser flows).
func (m *Middleware) BearerTokenAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        authHeader := r.Header.Get("Authorization")
        if !strings.HasPrefix(authHeader, "Bearer ") {
            http.Error(w, "missing Bearer token", http.StatusUnauthorized)
            return
        }
        rawToken := strings.TrimPrefix(authHeader, "Bearer ")

        idToken, err := m.provider.verifier.Verify(r.Context(), rawToken)
        if err != nil {
            m.logger.WarnContext(r.Context(), "invalid Bearer token",
                "error", err,
                "remote_addr", r.RemoteAddr,
            )
            http.Error(w, "invalid token", http.StatusUnauthorized)
            return
        }

        claims := &StandardClaims{}
        if err := idToken.Claims(claims); err != nil {
            http.Error(w, "failed to parse token claims", http.StatusUnauthorized)
            return
        }

        ctx := context.WithValue(r.Context(), contextKeyClaims, claims)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// ClaimsFromContext extracts StandardClaims from the request context.
func ClaimsFromContext(ctx context.Context) *StandardClaims {
    claims, _ := ctx.Value(contextKeyClaims).(*StandardClaims)
    return claims
}

func (m *Middleware) redirectToLogin(w http.ResponseWriter, r *http.Request) {
    loginURL := "/auth/login?return_to=" + url.QueryEscape(r.URL.RequestURI())
    http.Redirect(w, r, loginURL, http.StatusFound)
}

func hasRole(claims *StandardClaims, role string) bool {
    for _, r := range claims.Roles {
        if r == role {
            return true
        }
    }
    if claims.RealmAccess != nil {
        for _, r := range claims.RealmAccess.Roles {
            if r == role {
                return true
            }
        }
    }
    return false
}

func isTokenExpired(expiry time.Time) bool {
    return time.Now().After(expiry.Add(-30 * time.Second))
}

func sessionSubject(s *SessionData) string {
    if s.Claims != nil {
        return s.Claims.Subject
    }
    return "unknown"
}
```

## Provider-Specific Configuration

### Keycloak

```go
// config/keycloak.go
package config

const (
    // Keycloak issuer format:
    // https://<host>/realms/<realm>
    KeycloakIssuer = "https://keycloak.example.com/realms/production"
)

// KeycloakScopes returns the recommended scopes for Keycloak.
// "roles" is a custom scope that includes realm and client roles in the token.
func KeycloakScopes() []string {
    return []string{"openid", "profile", "email", "roles", "offline_access"}
}
```

### Auth0

```go
// config/auth0.go
package config

// Auth0 issuer is always https://<tenant>.auth0.com/
// Note the trailing slash — required by Auth0.
const (
    Auth0Issuer = "https://your-tenant.auth0.com/"
)

// Auth0 does not include a "roles" claim by default.
// Roles must be added via an Auth0 Action or Rule that populates
// a custom namespace claim.
func Auth0Scopes() []string {
    return []string{"openid", "profile", "email", "offline_access"}
}
```

### Okta

```go
// config/okta.go
package config

// Okta issuer for default authorization server:
// https://<org>.okta.com (groups claims included by default)
// For custom auth servers:
// https://<org>.okta.com/oauth2/<auth-server-id>
const (
    OktaIssuer = "https://your-org.okta.com"
)

func OktaScopes() []string {
    return []string{"openid", "profile", "email", "groups", "offline_access"}
}
```

## Wiring It Together with chi

```go
// main.go
package main

import (
    "context"
    "crypto/rand"
    "log/slog"
    "net/http"
    "os"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    authpkg "enterprise.example.com/auth-service/pkg/auth"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    ctx := context.Background()

    provider, err := authpkg.NewProvider(ctx, authpkg.ProviderConfig{
        IssuerURL:    os.Getenv("OIDC_ISSUER"),
        ClientID:     os.Getenv("OIDC_CLIENT_ID"),
        ClientSecret: os.Getenv("OIDC_CLIENT_SECRET"),
        RedirectURL:  "https://app.example.com/auth/callback",
    })
    if err != nil {
        logger.Error("OIDC provider initialization failed", "error", err)
        os.Exit(1)
    }

    // Generate or load session key from environment
    sessionKeyHex := os.Getenv("SESSION_ENCRYPTION_KEY")
    sessionKey := make([]byte, 32)
    if sessionKeyHex == "" {
        rand.Read(sessionKey) // ephemeral key (sessions lost on restart)
        logger.Warn("using ephemeral session key — set SESSION_ENCRYPTION_KEY in production")
    } else {
        // In production, decode from hex or base64
        copy(sessionKey, []byte(sessionKeyHex)[:32])
    }

    sessions, err := authpkg.NewSessionStore(sessionKey, true)
    if err != nil {
        logger.Error("session store initialization failed", "error", err)
        os.Exit(1)
    }

    authHandler := authpkg.NewHandler(provider, sessions, logger)
    authMiddleware := authpkg.NewMiddleware(provider, sessions, logger)

    r := chi.NewRouter()
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)

    // Public auth routes
    r.Get("/auth/login", authHandler.Login)
    r.Get("/auth/callback", authHandler.Callback)
    r.Get("/auth/logout", authHandler.Logout)

    // Protected application routes
    r.Group(func(r chi.Router) {
        r.Use(authMiddleware.RequireAuth)
        r.Get("/", dashboardHandler)
        r.Get("/profile", profileHandler)

        // Admin-only routes
        r.Group(func(r chi.Router) {
            r.Use(authMiddleware.RequireRole("admin"))
            r.Get("/admin", adminHandler)
        })
    })

    // API routes using Bearer token
    r.Group(func(r chi.Router) {
        r.Use(authMiddleware.BearerTokenAuth)
        r.Get("/api/v1/data", apiDataHandler)
    })

    logger.Info("starting server", "addr", ":8080")
    if err := http.ListenAndServe(":8080", r); err != nil {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}

func dashboardHandler(w http.ResponseWriter, r *http.Request) {
    claims := authpkg.ClaimsFromContext(r.Context())
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintf(w, `{"user": %q, "email": %q}`, claims.Name, claims.Email)
}

func profileHandler(w http.ResponseWriter, r *http.Request) {
    claims := authpkg.ClaimsFromContext(r.Context())
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintf(w, `{"subject": %q, "groups": %v}`, claims.Subject, claims.Groups)
}

func adminHandler(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte(`{"admin": true}`))
}

func apiDataHandler(w http.ResponseWriter, r *http.Request) {
    claims := authpkg.ClaimsFromContext(r.Context())
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintf(w, `{"subject": %q}`, claims.Subject)
}
```

## Refresh Token Rotation Security

OIDC refresh token rotation means that each use of a refresh token invalidates it and issues a new one. This provides defense against token theft — if an attacker uses a stolen refresh token, the legitimate user's next refresh will fail, alerting to the compromise.

Enable this in your identity provider:

**Keycloak**: In Realm Settings → Sessions → Revoke Refresh Token → Enable. Set Refresh Token Max Reuse to 0.

**Auth0**: In Dashboard → Applications → Your Application → Refresh Token Rotation → Enable Rotation.

**Okta**: In Security → API → Authorization Servers → Edit → Access Policies → Enable Refresh Token Rotation.

On the Go side, always persist the new refresh token returned during a refresh:

```go
newTokenSet, err := provider.Refresh(ctx, oldRefreshToken)
if err != nil {
    // Refresh token is invalid/expired — require re-authentication
    return err
}
// CRITICAL: use newTokenSet.RefreshToken, not oldRefreshToken
session.RefreshToken = newTokenSet.RefreshToken
```

## Testing the Authentication Flow

```go
// pkg/auth/provider_test.go
package auth_test

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"

    "enterprise.example.com/auth-service/pkg/auth"
)

func TestPKCEGeneration(t *testing.T) {
    pkce1, err := auth.GeneratePKCE()
    if err != nil {
        t.Fatalf("GeneratePKCE() error: %v", err)
    }
    pkce2, err := auth.GeneratePKCE()
    if err != nil {
        t.Fatalf("GeneratePKCE() error: %v", err)
    }

    // Verifiers must be unique
    if pkce1.CodeVerifier == pkce2.CodeVerifier {
        t.Error("PKCE verifiers must be unique across generations")
    }

    // Challenge must not equal verifier
    if pkce1.CodeChallenge == pkce1.CodeVerifier {
        t.Error("PKCE challenge must differ from verifier")
    }
}

func TestSessionEncryptionRoundtrip(t *testing.T) {
    key := make([]byte, 32)
    for i := range key {
        key[i] = byte(i)
    }

    store, err := auth.NewSessionStore(key, false)
    if err != nil {
        t.Fatalf("NewSessionStore: %v", err)
    }

    original := &auth.SessionData{
        AccessToken: "test-access-token",
        Claims: &auth.StandardClaims{
            Subject: "user-123",
            Email:   "user@example.com",
        },
    }

    w := httptest.NewRecorder()
    if err := store.Save(w, original); err != nil {
        t.Fatalf("Save: %v", err)
    }

    req := &http.Request{Header: http.Header{"Cookie": w.Result().Header["Set-Cookie"]}}
    loaded, err := store.Load(req)
    if err != nil {
        t.Fatalf("Load: %v", err)
    }
    if loaded == nil {
        t.Fatal("loaded session is nil")
    }
    if loaded.AccessToken != original.AccessToken {
        t.Errorf("access token mismatch: got %q, want %q", loaded.AccessToken, original.AccessToken)
    }
    if loaded.Claims.Subject != original.Claims.Subject {
        t.Errorf("subject mismatch: got %q, want %q", loaded.Claims.Subject, original.Claims.Subject)
    }
}
```

## Troubleshooting Common Issues

**Token verification fails with "oidc: issuer did not match"**: The `iss` claim in the JWT does not match the IssuerURL configured in `NewProvider`. Verify the exact issuer URL including trailing slash differences (Auth0 requires a trailing slash).

**PKCE code_challenge_method not supported**: Older identity providers may not support S256. Downgrade to plain method only in non-production test environments.

**Refresh token not returned**: Ensure `offline_access` scope is requested and that the client in the IdP is configured to allow refresh tokens.

**Cookie not set in browser**: Verify `Secure: true` is set and the application is served over HTTPS. SameSite=Lax prevents cookies from being sent on cross-site requests, which is usually the desired behavior.

**Claims missing expected fields**: Different providers populate different default claims. Use the provider's claim mapping configuration to include groups, roles, and custom attributes.
