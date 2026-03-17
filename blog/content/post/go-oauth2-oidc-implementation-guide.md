---
title: "Go OAuth2/OIDC Implementation: Authorization Code Flow, PKCE, Token Refresh, and Introspection"
date: 2028-07-26T00:00:00-05:00
draft: false
tags: ["Go", "OAuth2", "OIDC", "Authentication", "Security", "JWT"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to implementing OAuth2 and OpenID Connect in Go, covering the authorization code flow with PKCE, secure token storage, refresh token rotation, introspection, and multi-provider support."
more_link: "yes"
url: "/go-oauth2-oidc-implementation-guide/"
---

OAuth2 and OpenID Connect are the foundation of modern authentication and authorization on the web, but implementing them correctly from scratch is surprisingly difficult. The specifications are large, the security considerations are numerous, and the gap between "it works in development" and "it is secure in production" is wide. Go's standard library and ecosystem provide excellent building blocks, but assembling them correctly requires understanding both the protocol and the common attack vectors.

This guide implements a complete OAuth2/OIDC stack in Go: the authorization code flow with PKCE, secure state and nonce handling, token validation and parsing, refresh token rotation, token introspection, and a multi-provider architecture that works with any compliant identity provider.

<!--more-->

# Go OAuth2/OIDC Implementation: Production Patterns

## Understanding the Flows

This guide focuses on three flows:

1. **Authorization Code + PKCE**: The standard browser-based flow for web applications. PKCE (Proof Key for Code Exchange) is required for public clients and recommended for all clients to prevent authorization code interception attacks.

2. **Client Credentials**: For machine-to-machine (M2M) communication where no user is involved.

3. **Token Introspection**: For resource servers that need to validate tokens issued by a third-party authorization server without maintaining a local validation key.

## Dependencies

```bash
go mod init github.com/example/auth

# OIDC client library (wraps golang.org/x/oauth2)
go get github.com/coreos/go-oidc/v3/oidc@latest

# OAuth2 base library
go get golang.org/x/oauth2@latest

# JWT parsing (for manual token inspection)
go get github.com/golang-jwt/jwt/v5@latest

# Secure random tokens and session management
go get github.com/gorilla/sessions@latest
go get github.com/gorilla/securecookie@latest

# HTTP router
go get github.com/go-chi/chi/v5@latest

# Structured logging
go get go.uber.org/zap@latest
```

## Section 1: Provider Configuration

A provider abstraction allows the application to work with any OIDC-compliant identity provider (Keycloak, Auth0, Google, Okta, Dex, etc.).

```go
// pkg/auth/provider.go
package auth

import (
	"context"
	"fmt"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// ProviderConfig holds the configuration for an OIDC provider.
type ProviderConfig struct {
	// IssuerURL is the OIDC issuer URL.
	// The provider will fetch its configuration from {IssuerURL}/.well-known/openid-configuration.
	IssuerURL string

	ClientID     string
	ClientSecret string

	// RedirectURL is the URL the authorization server redirects to after
	// the user grants permission.
	RedirectURL string

	// Scopes to request in addition to "openid".
	AdditionalScopes []string
}

// Provider wraps an OIDC provider with our application's configuration.
type Provider struct {
	config   ProviderConfig
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth2   oauth2.Config
}

// NewProvider creates a new provider by fetching the OIDC discovery document.
func NewProvider(ctx context.Context, cfg ProviderConfig) (*Provider, error) {
	provider, err := oidc.NewProvider(ctx, cfg.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("fetch OIDC discovery for %s: %w", cfg.IssuerURL, err)
	}

	scopes := []string{oidc.ScopeOpenID, "profile", "email"}
	scopes = append(scopes, cfg.AdditionalScopes...)

	oauth2Config := oauth2.Config{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		RedirectURL:  cfg.RedirectURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       scopes,
	}

	verifier := provider.Verifier(&oidc.Config{
		ClientID: cfg.ClientID,
	})

	return &Provider{
		config:   cfg,
		provider: provider,
		verifier: verifier,
		oauth2:   oauth2Config,
	}, nil
}

// AuthCodeURL generates the authorization URL with PKCE parameters.
func (p *Provider) AuthCodeURL(state, nonce, codeVerifier string) string {
	// Generate PKCE code challenge.
	challenge := oauth2.S256ChallengeFromVerifier(codeVerifier)

	return p.oauth2.AuthCodeURL(
		state,
		oauth2.SetAuthURLParam("nonce", nonce),
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
}

// Exchange exchanges the authorization code for tokens.
func (p *Provider) Exchange(
	ctx context.Context,
	code, codeVerifier string,
) (*oauth2.Token, error) {
	return p.oauth2.Exchange(
		ctx,
		code,
		oauth2.SetAuthURLParam("code_verifier", codeVerifier),
	)
}

// VerifyIDToken validates the ID token and returns the parsed claims.
func (p *Provider) VerifyIDToken(
	ctx context.Context,
	rawIDToken string,
	expectedNonce string,
) (*oidc.IDToken, error) {
	idToken, err := p.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("verify id token: %w", err)
	}

	// Verify the nonce to prevent replay attacks.
	var claims struct {
		Nonce string `json:"nonce"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("parse nonce claim: %w", err)
	}
	if claims.Nonce != expectedNonce {
		return nil, fmt.Errorf("nonce mismatch: expected %s, got %s",
			expectedNonce, claims.Nonce)
	}

	return idToken, nil
}

// Refresh exchanges a refresh token for new tokens.
func (p *Provider) Refresh(ctx context.Context, refreshToken string) (*oauth2.Token, error) {
	token := &oauth2.Token{RefreshToken: refreshToken}
	tokenSource := p.oauth2.TokenSource(ctx, token)
	return tokenSource.Token()
}

// UserInfo fetches user information from the UserInfo endpoint.
func (p *Provider) UserInfo(ctx context.Context, accessToken string) (*oidc.UserInfo, error) {
	tokenSource := oauth2.StaticTokenSource(&oauth2.Token{
		AccessToken: accessToken,
	})
	return p.provider.UserInfo(ctx, tokenSource)
}
```

## Section 2: PKCE and State Management

PKCE (Proof Key for Code Exchange) requires generating a random code verifier before starting the flow and including its hash (the code challenge) in the authorization request. The verifier is sent with the token exchange request, proving that the entity exchanging the code is the same entity that initiated the flow.

```go
// pkg/auth/pkce.go
package auth

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

const (
	// codeVerifierLength is the number of random bytes for the PKCE code verifier.
	// Must generate at least 32 bytes (43 base64url chars) per RFC 7636.
	codeVerifierLength = 48
)

// GenerateCodeVerifier generates a cryptographically secure PKCE code verifier.
func GenerateCodeVerifier() (string, error) {
	b := make([]byte, codeVerifierLength)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate code verifier: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// GenerateState generates a cryptographically secure state parameter.
// The state parameter prevents CSRF attacks by tying the authorization
// request to the user's session.
func GenerateState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// GenerateNonce generates a cryptographically secure nonce for ID token replay prevention.
func GenerateNonce() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
```

## Section 3: Secure Session Management

OAuth2 flows require storing transient data (state, nonce, code verifier) between the initial redirect and the callback. Sessions must be encrypted and CSRF-protected.

```go
// pkg/auth/session.go
package auth

import (
	"encoding/gob"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/sessions"
)

func init() {
	// Register types that will be stored in sessions.
	gob.Register(SessionData{})
	gob.Register(UserSession{})
}

// SessionData holds the transient data stored between the auth redirect and callback.
type SessionData struct {
	State        string
	Nonce        string
	CodeVerifier string
	ReturnURL    string
	CreatedAt    time.Time
}

// UserSession holds the authenticated user's session data.
type UserSession struct {
	Sub          string            // Subject (user ID from OIDC)
	Email        string
	Name         string
	AccessToken  string
	RefreshToken string
	Expiry       time.Time
	Claims       map[string]interface{}
}

const (
	sessionNameAuth = "auth_session"
	sessionNameUser = "user_session"
	keyAuthSession  = "auth_data"
	keyUserSession  = "user_data"
)

// SessionStore manages HTTP sessions.
type SessionStore struct {
	store sessions.Store
}

// NewSessionStore creates a new session store with encrypted cookies.
func NewSessionStore(hashKey, encKey []byte) *SessionStore {
	store := sessions.NewCookieStore(hashKey, encKey)
	store.Options = &sessions.Options{
		Path:     "/",
		MaxAge:   86400, // 24 hours
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	}
	return &SessionStore{store: store}
}

// SaveAuthSession stores the transient auth data before redirecting.
func (ss *SessionStore) SaveAuthSession(
	w http.ResponseWriter,
	r *http.Request,
	data SessionData,
) error {
	session, err := ss.store.Get(r, sessionNameAuth)
	if err != nil {
		return fmt.Errorf("get auth session: %w", err)
	}
	session.Values[keyAuthSession] = data
	// Auth sessions expire after 10 minutes to prevent stale state.
	session.Options.MaxAge = 600
	return session.Save(r, w)
}

// GetAuthSession retrieves and deletes the transient auth data.
func (ss *SessionStore) GetAuthSession(
	w http.ResponseWriter,
	r *http.Request,
) (*SessionData, error) {
	session, err := ss.store.Get(r, sessionNameAuth)
	if err != nil {
		return nil, fmt.Errorf("get auth session: %w", err)
	}

	raw, ok := session.Values[keyAuthSession]
	if !ok {
		return nil, fmt.Errorf("no auth session found")
	}

	data, ok := raw.(SessionData)
	if !ok {
		return nil, fmt.Errorf("invalid auth session type")
	}

	// Check for session expiry.
	if time.Since(data.CreatedAt) > 10*time.Minute {
		return nil, fmt.Errorf("auth session expired")
	}

	// Delete the auth session after reading (one-time use).
	delete(session.Values, keyAuthSession)
	session.Options.MaxAge = -1
	_ = session.Save(r, w)

	return &data, nil
}

// SaveUserSession stores the authenticated user's session.
func (ss *SessionStore) SaveUserSession(
	w http.ResponseWriter,
	r *http.Request,
	user UserSession,
) error {
	session, err := ss.store.Get(r, sessionNameUser)
	if err != nil {
		return fmt.Errorf("get user session: %w", err)
	}
	session.Values[keyUserSession] = user
	return session.Save(r, w)
}

// GetUserSession retrieves the authenticated user's session.
func (ss *SessionStore) GetUserSession(r *http.Request) (*UserSession, error) {
	session, err := ss.store.Get(r, sessionNameUser)
	if err != nil {
		return nil, fmt.Errorf("get user session: %w", err)
	}

	raw, ok := session.Values[keyUserSession]
	if !ok {
		return nil, fmt.Errorf("no user session")
	}

	user, ok := raw.(UserSession)
	if !ok {
		return nil, fmt.Errorf("invalid user session type")
	}

	return &user, nil
}

// ClearUserSession removes the user's session (logout).
func (ss *SessionStore) ClearUserSession(
	w http.ResponseWriter,
	r *http.Request,
) error {
	session, err := ss.store.Get(r, sessionNameUser)
	if err != nil {
		return nil
	}
	session.Options.MaxAge = -1
	return session.Save(r, w)
}
```

## Section 4: HTTP Handlers

```go
// pkg/auth/handlers.go
package auth

import (
	"net/http"
	"time"

	"go.uber.org/zap"
	"golang.org/x/oauth2"
)

// Handler provides HTTP handlers for the OAuth2/OIDC flow.
type Handler struct {
	provider *Provider
	sessions *SessionStore
	log      *zap.Logger
}

func NewHandler(provider *Provider, sessions *SessionStore, log *zap.Logger) *Handler {
	return &Handler{
		provider: provider,
		sessions: sessions,
		log:      log,
	}
}

// Login initiates the authorization code flow.
// GET /auth/login
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	state, err := GenerateState()
	if err != nil {
		h.log.Error("generate state", zap.Error(err))
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	nonce, err := GenerateNonce()
	if err != nil {
		h.log.Error("generate nonce", zap.Error(err))
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	codeVerifier, err := GenerateCodeVerifier()
	if err != nil {
		h.log.Error("generate code verifier", zap.Error(err))
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Capture the return URL before redirecting.
	returnURL := r.URL.Query().Get("return_url")
	if returnURL == "" {
		returnURL = "/"
	}

	// Store the PKCE verifier, state, and nonce in the session.
	if err := h.sessions.SaveAuthSession(w, r, SessionData{
		State:        state,
		Nonce:        nonce,
		CodeVerifier: codeVerifier,
		ReturnURL:    returnURL,
		CreatedAt:    time.Now(),
	}); err != nil {
		h.log.Error("save auth session", zap.Error(err))
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	authURL := h.provider.AuthCodeURL(state, nonce, codeVerifier)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// Callback handles the authorization code callback from the identity provider.
// GET /auth/callback
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
	// Retrieve and validate the auth session.
	authSession, err := h.sessions.GetAuthSession(w, r)
	if err != nil {
		h.log.Warn("get auth session", zap.Error(err))
		http.Error(w, "invalid session", http.StatusBadRequest)
		return
	}

	// Check for errors from the authorization server.
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		desc := r.URL.Query().Get("error_description")
		h.log.Warn("authorization error",
			zap.String("error", errParam),
			zap.String("description", desc))
		http.Error(w, "authorization failed: "+errParam, http.StatusUnauthorized)
		return
	}

	// Validate the state parameter.
	state := r.URL.Query().Get("state")
	if state != authSession.State {
		h.log.Warn("state mismatch",
			zap.String("expected", authSession.State),
			zap.String("got", state))
		http.Error(w, "state mismatch", http.StatusBadRequest)
		return
	}

	// Exchange the code for tokens.
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}

	token, err := h.provider.Exchange(r.Context(), code, authSession.CodeVerifier)
	if err != nil {
		h.log.Error("token exchange", zap.Error(err))
		http.Error(w, "token exchange failed", http.StatusInternalServerError)
		return
	}

	// Extract and verify the ID token.
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "missing id_token", http.StatusInternalServerError)
		return
	}

	idToken, err := h.provider.VerifyIDToken(r.Context(), rawIDToken, authSession.Nonce)
	if err != nil {
		h.log.Error("verify id token", zap.Error(err))
		http.Error(w, "invalid id token", http.StatusUnauthorized)
		return
	}

	// Extract claims from the ID token.
	var claims struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil {
		h.log.Error("parse id token claims", zap.Error(err))
		http.Error(w, "invalid claims", http.StatusInternalServerError)
		return
	}

	// Save the user session.
	if err := h.sessions.SaveUserSession(w, r, UserSession{
		Sub:          claims.Sub,
		Email:        claims.Email,
		Name:         claims.Name,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		Expiry:       token.Expiry,
	}); err != nil {
		h.log.Error("save user session", zap.Error(err))
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}

	h.log.Info("user authenticated",
		zap.String("sub", claims.Sub),
		zap.String("email", claims.Email))

	http.Redirect(w, r, authSession.ReturnURL, http.StatusFound)
}

// Logout clears the session and redirects to the IdP logout endpoint.
// GET /auth/logout
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	_ = h.sessions.ClearUserSession(w, r)
	// In production, redirect to the IdP's end_session_endpoint.
	http.Redirect(w, r, "/", http.StatusFound)
}

// Middleware returns an HTTP middleware that requires authentication.
func (h *Handler) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := h.sessions.GetUserSession(r)
		if err != nil || user == nil {
			http.Redirect(w, r,
				"/auth/login?return_url="+r.URL.RequestURI(),
				http.StatusFound)
			return
		}

		// Check if the access token needs refreshing.
		if time.Until(user.Expiry) < 5*time.Minute && user.RefreshToken != "" {
			newToken, err := h.provider.Refresh(r.Context(), user.RefreshToken)
			if err != nil {
				h.log.Warn("token refresh failed", zap.Error(err))
				// Redirect to login on refresh failure.
				_ = h.sessions.ClearUserSession(w, r)
				http.Redirect(w, r,
					"/auth/login?return_url="+r.URL.RequestURI(),
					http.StatusFound)
				return
			}
			user.AccessToken = newToken.AccessToken
			if newToken.RefreshToken != "" {
				user.RefreshToken = newToken.RefreshToken
			}
			user.Expiry = newToken.Expiry
			_ = h.sessions.SaveUserSession(w, r, *user)
		}

		// Add the user to the request context.
		ctx := WithUser(r.Context(), user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

## Section 5: Context and User Propagation

```go
// pkg/auth/context.go
package auth

import "context"

type contextKey string

const userContextKey contextKey = "user"

// WithUser adds a UserSession to the context.
func WithUser(ctx context.Context, user *UserSession) context.Context {
	return context.WithValue(ctx, userContextKey, user)
}

// UserFromContext retrieves the UserSession from the context.
func UserFromContext(ctx context.Context) (*UserSession, bool) {
	user, ok := ctx.Value(userContextKey).(*UserSession)
	return user, ok && user != nil
}
```

## Section 6: Token Introspection

Token introspection (RFC 7662) allows a resource server to validate a token by asking the authorization server. This is useful when the resource server does not have the signing keys (e.g., when using opaque tokens).

```go
// pkg/auth/introspection.go
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// IntrospectionResult holds the response from a token introspection endpoint.
type IntrospectionResult struct {
	Active    bool   `json:"active"`
	Sub       string `json:"sub"`
	Username  string `json:"username"`
	Scope     string `json:"scope"`
	ClientID  string `json:"client_id"`
	TokenType string `json:"token_type"`
	Exp       int64  `json:"exp"`
	Iat       int64  `json:"iat"`
	Nbf       int64  `json:"nbf"`
	Jti       string `json:"jti"`
}

// IntrospectionClient performs token introspection against an RFC 7662 endpoint.
type IntrospectionClient struct {
	endpoint     string
	clientID     string
	clientSecret string
	httpClient   *http.Client
}

// NewIntrospectionClient creates a new introspection client.
func NewIntrospectionClient(endpoint, clientID, clientSecret string) *IntrospectionClient {
	return &IntrospectionClient{
		endpoint:     endpoint,
		clientID:     clientID,
		clientSecret: clientSecret,
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

// Introspect validates a token by calling the introspection endpoint.
func (c *IntrospectionClient) Introspect(
	ctx context.Context,
	token string,
) (*IntrospectionResult, error) {
	form := url.Values{
		"token": {token},
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.endpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return nil, fmt.Errorf("create introspect request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.SetBasicAuth(c.clientID, c.clientSecret)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("introspect request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("introspection endpoint returned %d", resp.StatusCode)
	}

	var result IntrospectionResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode introspect response: %w", err)
	}

	return &result, nil
}

// BearerTokenMiddleware validates Bearer tokens using introspection.
func BearerTokenMiddleware(ic *IntrospectionClient, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}

		token := strings.TrimPrefix(authHeader, "Bearer ")

		result, err := ic.Introspect(r.Context(), token)
		if err != nil || !result.Active {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}

		// Check token expiry.
		if result.Exp > 0 && time.Unix(result.Exp, 0).Before(time.Now()) {
			http.Error(w, "token expired", http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}
```

## Section 7: Client Credentials Flow (M2M)

For service-to-service communication, the client credentials flow issues tokens without user involvement.

```go
// pkg/auth/clientcredentials.go
package auth

import (
	"context"
	"fmt"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"
)

// M2MTokenSource provides tokens for machine-to-machine communication.
// It caches the token and only fetches a new one when it is about to expire.
type M2MTokenSource struct {
	mu     sync.Mutex
	config clientcredentials.Config
	token  *oauth2.Token
}

// NewM2MTokenSource creates a new client credentials token source.
func NewM2MTokenSource(
	tokenURL, clientID, clientSecret string,
	scopes []string,
) *M2MTokenSource {
	return &M2MTokenSource{
		config: clientcredentials.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			TokenURL:     tokenURL,
			Scopes:       scopes,
		},
	}
}

// Token returns a valid access token, fetching a new one if necessary.
func (ts *M2MTokenSource) Token(ctx context.Context) (string, error) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	// Use the cached token if it is still valid.
	if ts.token != nil && ts.token.Expiry.After(time.Now().Add(30*time.Second)) {
		return ts.token.AccessToken, nil
	}

	// Fetch a new token.
	tokenSource := ts.config.TokenSource(ctx)
	token, err := tokenSource.Token()
	if err != nil {
		return "", fmt.Errorf("fetch client credentials token: %w", err)
	}

	ts.token = token
	return token.AccessToken, nil
}

// HTTPClient returns an http.Client that automatically injects bearer tokens.
func (ts *M2MTokenSource) HTTPClient(ctx context.Context) (*http.Client, error) {
	token, err := ts.Token(ctx)
	if err != nil {
		return nil, err
	}

	return oauth2.NewClient(ctx, oauth2.StaticTokenSource(&oauth2.Token{
		AccessToken: token,
	})), nil
}
```

## Section 8: JWT Validation (When You Have the Keys)

When your application acts as a resource server for tokens issued by a known provider, you can validate JWTs locally using the provider's public keys fetched from the JWKS endpoint.

```go
// pkg/auth/jwt.go
package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// JWKSKey represents a single key from a JWKS endpoint.
type JWKSKey struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// JWKS represents a JSON Web Key Set.
type JWKS struct {
	Keys []JWKSKey `json:"keys"`
}

// JWTValidator validates JWTs using keys from a JWKS endpoint.
type JWTValidator struct {
	jwksURL    string
	mu         sync.RWMutex
	keys       map[string]*rsa.PublicKey
	lastFetch  time.Time
	ttl        time.Duration
	httpClient *http.Client
}

// NewJWTValidator creates a validator that fetches keys from the given JWKS URL.
func NewJWTValidator(jwksURL string, ttl time.Duration) *JWTValidator {
	return &JWTValidator{
		jwksURL:    jwksURL,
		keys:       make(map[string]*rsa.PublicKey),
		ttl:        ttl,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// fetchKeys retrieves the current key set from the JWKS endpoint.
func (v *JWTValidator) fetchKeys(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}

	resp, err := v.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("fetch JWKS: %w", err)
	}
	defer resp.Body.Close()

	var jwks JWKS
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return fmt.Errorf("decode JWKS: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey, len(jwks.Keys))
	for _, k := range jwks.Keys {
		if k.Kty != "RSA" || k.Use != "sig" {
			continue
		}
		pub, err := parseRSAPublicKey(k)
		if err != nil {
			return fmt.Errorf("parse key %s: %w", k.Kid, err)
		}
		keys[k.Kid] = pub
	}

	v.mu.Lock()
	v.keys = keys
	v.lastFetch = time.Now()
	v.mu.Unlock()

	return nil
}

func (v *JWTValidator) getKey(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	key, ok := v.keys[kid]
	expired := time.Since(v.lastFetch) > v.ttl
	v.mu.RUnlock()

	if ok && !expired {
		return key, nil
	}

	// Refresh keys.
	if err := v.fetchKeys(ctx); err != nil {
		return nil, err
	}

	v.mu.RLock()
	key, ok = v.keys[kid]
	v.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("key %s not found in JWKS", kid)
	}
	return key, nil
}

// ValidateClaims represents the expected claims in a JWT.
type ValidateClaims struct {
	jwt.RegisteredClaims
	Email  string `json:"email"`
	Name   string `json:"name"`
	Scope  string `json:"scope"`
}

// Validate parses and validates a JWT, returning the claims.
func (v *JWTValidator) Validate(ctx context.Context, tokenString string) (*ValidateClaims, error) {
	// Parse without validating first to extract the kid header.
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())
	unverified, _, err := parser.ParseUnverified(tokenString, &ValidateClaims{})
	if err != nil {
		return nil, fmt.Errorf("parse token header: %w", err)
	}

	kid, ok := unverified.Header["kid"].(string)
	if !ok {
		return nil, fmt.Errorf("missing kid in token header")
	}

	key, err := v.getKey(ctx, kid)
	if err != nil {
		return nil, fmt.Errorf("get signing key: %w", err)
	}

	claims := &ValidateClaims{}
	_, err = jwt.ParseWithClaims(
		tokenString,
		claims,
		func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return key, nil
		},
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
	)
	if err != nil {
		return nil, fmt.Errorf("validate token: %w", err)
	}

	return claims, nil
}

func parseRSAPublicKey(k JWKSKey) (*rsa.PublicKey, error) {
	nb, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, fmt.Errorf("decode N: %w", err)
	}
	eb, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, fmt.Errorf("decode E: %w", err)
	}

	n := new(big.Int).SetBytes(nb)
	e := new(big.Int).SetBytes(eb)

	return &rsa.PublicKey{
		N: n,
		E: int(e.Int64()),
	}, nil
}
```

## Section 9: Putting It Together

```go
// cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"go.uber.org/zap"

	"github.com/example/auth/pkg/auth"
)

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	ctx := context.Background()

	// Initialize the OIDC provider.
	provider, err := auth.NewProvider(ctx, auth.ProviderConfig{
		IssuerURL:    os.Getenv("OIDC_ISSUER"),
		ClientID:     os.Getenv("OIDC_CLIENT_ID"),
		ClientSecret: os.Getenv("OIDC_CLIENT_SECRET"),
		RedirectURL:  "https://app.example.com/auth/callback",
		AdditionalScopes: []string{"offline_access"},
	})
	if err != nil {
		log.Fatalf("init OIDC provider: %v", err)
	}

	// Initialize session store.
	hashKey := []byte(os.Getenv("SESSION_HASH_KEY"))   // 32 bytes min
	encKey := []byte(os.Getenv("SESSION_ENC_KEY"))     // 32 bytes
	sessions := auth.NewSessionStore(hashKey, encKey)

	// Initialize auth handler.
	authHandler := auth.NewHandler(provider, sessions, logger)

	// Initialize JWT validator for API endpoints.
	jwtValidator := auth.NewJWTValidator(
		os.Getenv("OIDC_ISSUER")+"/.well-known/jwks.json",
		5*time.Minute,
	)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	// Public routes.
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Auth routes.
	r.Get("/auth/login", authHandler.Login)
	r.Get("/auth/callback", authHandler.Callback)
	r.Get("/auth/logout", authHandler.Logout)

	// Protected browser routes (session-based).
	r.Group(func(r chi.Router) {
		r.Use(authHandler.Middleware)
		r.Get("/dashboard", dashboardHandler)
		r.Get("/profile", profileHandler)
	})

	// Protected API routes (JWT-based).
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return jwtBearerMiddleware(jwtValidator, next, logger)
		})
		r.Get("/api/v1/data", apiDataHandler)
	})

	logger.Info("server starting", zap.String("addr", ":8080"))
	if err := http.ListenAndServe(":8080", r); err != nil {
		log.Fatal(err)
	}
}

func jwtBearerMiddleware(v *auth.JWTValidator, next http.Handler, log *zap.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		claims, err := v.Validate(r.Context(), token)
		if err != nil {
			log.Warn("jwt validation failed", zap.Error(err))
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), "jwt_claims", claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func dashboardHandler(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFromContext(r.Context())
	fmt.Fprintf(w, "Welcome, %s", user.Name)
}

func profileHandler(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFromContext(r.Context())
	json.NewEncoder(w).Encode(user)
}

func apiDataHandler(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
```

## Section 10: Security Hardening Checklist

**State and PKCE**
- Never reuse state values across requests
- Store state, nonce, and code verifier in the session, not in cookies or URL parameters
- Invalidate auth sessions immediately after the callback (single-use)
- Code verifiers must be at least 43 characters (256 bits of entropy)

**Tokens**
- Store access tokens in server-side sessions, never in localStorage
- Use the `Secure`, `HttpOnly`, and `SameSite=Lax` flags on all cookies
- Validate all JWT claims: `iss`, `aud`, `exp`, `iat`, `nbf`
- Always verify the `nonce` in the ID token to prevent replay attacks

**Refresh Token Rotation**
- Use `offline_access` scope sparingly and only when needed
- Implement refresh token rotation: each refresh returns a new refresh token, and the old one is invalidated
- Store refresh tokens encrypted server-side, never in the browser

**PKCE Code Challenge**
- Always use S256 (SHA-256), never `plain`
- Generate code verifiers with `crypto/rand`, not `math/rand`

```go
// Verify that the PKCE verifier generates the correct challenge.
func verifyChallengeMethod(verifier string) bool {
	h := sha256.New()
	h.Write([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(h.Sum(nil))
	return len(challenge) >= 43
}
```

## Conclusion

A correct OAuth2/OIDC implementation requires careful attention to security details at every step. PKCE prevents authorization code interception. Encrypted server-side sessions protect tokens from XSS. State and nonce parameters prevent CSRF and replay attacks. JWT validation with JWKS rotation ensures that compromised keys are rotated without service interruption. Token introspection provides a fallback for opaque tokens and real-time revocation checking.

The patterns in this guide work with any OIDC-compliant identity provider. The `go-oidc` library handles the discovery document and ID token verification. Everything else — session management, PKCE, refresh rotation, and JWT validation — is explicit and under your control, which is exactly where security-critical code should be.
