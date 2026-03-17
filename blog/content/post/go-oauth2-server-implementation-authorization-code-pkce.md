---
title: "Go OAuth2 Server Implementation: Authorization Code Flow with PKCE"
date: 2031-04-07T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "OAuth2", "OIDC", "Security", "Authentication", "API Security"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing an OAuth2/OIDC authorization server in Go. Covers authorization code with PKCE, token introspection, refresh token rotation, client credentials flow, and JWT vs opaque token trade-offs."
more_link: "yes"
url: "/go-oauth2-server-implementation-authorization-code-pkce/"
---

Building a correct OAuth2 authorization server is one of the more challenging tasks in backend development. The specification is broad, the security requirements are exacting, and the attack surface is significant. This guide implements a production-grade OAuth2 server in Go using the fosite library, covering the authorization code + PKCE flow, token introspection, refresh token rotation, and client credentials for service-to-service authentication.

<!--more-->

# Go OAuth2 Server Implementation: Authorization Code Flow with PKCE

## Library Selection

### fosite vs ory-hydra vs Building from Scratch

**fosite** (`github.com/ory/fosite`) is the low-level OAuth2/OpenID Connect framework. It handles the specification-compliant request/response handling but requires you to implement the storage backends. fosite is the right choice when you need to embed OAuth2 capability in your own application.

**ory-hydra** is a complete OAuth2/OIDC server built on fosite. It runs as a standalone service and communicates with your application through a login/consent API. Choose Hydra when you want a managed OAuth2 server with minimal implementation effort.

**Building from scratch** is almost never appropriate. The OAuth2 specification has numerous security subtleties that are easy to get wrong.

This guide uses fosite for full control over the implementation.

## Section 1: Project Setup and fosite Configuration

```bash
go mod init github.com/example/oauth2-server
go get github.com/ory/fosite
go get github.com/ory/fosite/compose
go get github.com/ory/x/errorsx
go get github.com/go-jose/go-jose/v3
go get github.com/google/uuid
go get github.com/redis/go-redis/v9
go get github.com/jackc/pgx/v5
```

### Configuration and Key Management

```go
// config/config.go
package config

import (
    "crypto/rand"
    "crypto/rsa"
    "encoding/json"
    "fmt"
    "os"
    "time"

    "github.com/go-jose/go-jose/v3"
)

type Config struct {
    // Server
    HTTPAddr string
    TLSCert  string
    TLSKey   string
    Issuer   string

    // Database
    DatabaseDSN string

    // Redis
    RedisAddr     string
    RedisPassword string

    // Token settings
    AccessTokenLifespan    time.Duration
    RefreshTokenLifespan   time.Duration
    AuthCodeLifespan       time.Duration
    IDTokenLifespan        time.Duration

    // Keys
    JWTSigningKey    *rsa.PrivateKey
    TokenHashSecret  []byte
}

func Load() (*Config, error) {
    // In production, load signing key from a secret manager
    // For this example, we generate or load from environment
    signingKey, err := loadOrGenerateRSAKey()
    if err != nil {
        return nil, fmt.Errorf("loading signing key: %w", err)
    }

    tokenSecret := make([]byte, 32)
    if secretEnv := os.Getenv("TOKEN_HASH_SECRET"); secretEnv != "" {
        tokenSecret = []byte(secretEnv)
    } else {
        if _, err := rand.Read(tokenSecret); err != nil {
            return nil, fmt.Errorf("generating token secret: %w", err)
        }
    }

    return &Config{
        HTTPAddr:               getEnv("HTTP_ADDR", ":8443"),
        TLSCert:                getEnv("TLS_CERT", "/tls/tls.crt"),
        TLSKey:                 getEnv("TLS_KEY", "/tls/tls.key"),
        Issuer:                 getEnv("ISSUER", "https://auth.example.com"),
        DatabaseDSN:            requireEnv("DATABASE_DSN"),
        RedisAddr:              getEnv("REDIS_ADDR", "localhost:6379"),
        AccessTokenLifespan:    5 * time.Minute,
        RefreshTokenLifespan:   30 * 24 * time.Hour,
        AuthCodeLifespan:       10 * time.Minute,
        IDTokenLifespan:        1 * time.Hour,
        JWTSigningKey:          signingKey,
        TokenHashSecret:        tokenSecret,
    }, nil
}

func loadOrGenerateRSAKey() (*rsa.PrivateKey, error) {
    keyPath := os.Getenv("JWT_SIGNING_KEY_FILE")
    if keyPath != "" {
        // Load from PEM file (in production, use Vault or AWS KMS)
        data, err := os.ReadFile(keyPath)
        if err != nil {
            return nil, err
        }
        // Parse PEM - in production use a proper parser
        _ = data
    }
    // Generate for development
    return rsa.GenerateKey(rand.Reader, 2048)
}

func getEnv(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}

func requireEnv(key string) string {
    v := os.Getenv(key)
    if v == "" {
        panic(fmt.Sprintf("required environment variable %s is not set", key))
    }
    return v
}
```

### fosite Compose Setup

```go
// server/fosite.go
package server

import (
    "crypto/rsa"
    "time"

    "github.com/go-jose/go-jose/v3"
    "github.com/ory/fosite"
    "github.com/ory/fosite/compose"
    "github.com/ory/fosite/handler/openid"
    "github.com/ory/fosite/token/jwt"

    "github.com/example/oauth2-server/config"
    "github.com/example/oauth2-server/store"
)

func NewFositeProvider(cfg *config.Config, storage store.Storage) fosite.OAuth2Provider {
    fositeConfig := &fosite.Config{
        AccessTokenLifespan:            cfg.AccessTokenLifespan,
        RefreshTokenLifespan:           cfg.RefreshTokenLifespan,
        AuthorizeCodeLifespan:          cfg.AuthCodeLifespan,
        IDTokenLifespan:                cfg.IDTokenLifespan,
        IDTokenIssuer:                  cfg.Issuer,
        HashCost:                       12,
        SendDebugMessagesToClients:     false,
        DisableRefreshTokenValidation:  false,
        // Enforce PKCE for public clients
        EnforcePKCE:                    true,
        EnforcePKCEForPublicClients:    true,
        // Allow all scopes by default (override per client in storage)
        ScopeStrategy:                  fosite.HierarchicScopeStrategy,
        AudienceMatchingStrategy:       fosite.DefaultAudienceMatchingStrategy,
        TokenURL:                       cfg.Issuer + "/oauth2/token",
        RedirectSecureChecker:          fosite.IsRedirectURISecureStrict,
        RefreshTokenScopes:             []string{"offline_access"},
        TokenEntropy:                   32,
        RotatedEncryptionKeys:          nil,
    }

    // Build JWKS from the signing key
    jwk := jose.JSONWebKey{
        Key:       cfg.JWTSigningKey,
        KeyID:     "primary",
        Algorithm: "RS256",
        Use:       "sig",
    }
    jwks := &jose.JSONWebKeySet{Keys: []jose.JSONWebKey{jwk}}

    jwtStrategy := &jwt.DefaultSigner{
        GetPrivateKey: func(ctx context.Context) (interface{}, error) {
            return cfg.JWTSigningKey, nil
        },
    }

    // Use compose to assemble the OAuth2 provider with desired grant types
    return compose.Compose(
        fositeConfig,
        storage,
        jwtStrategy,

        // Core OAuth2 flows
        compose.OAuth2AuthorizeExplicitFactory,       // Authorization code
        compose.OAuth2PKCEFactory,                    // PKCE
        compose.OAuth2ClientCredentialsGrantFactory,  // Client credentials
        compose.OAuth2RefreshTokenGrantFactory,       // Refresh tokens
        compose.OAuth2TokenRevocationFactory,         // Token revocation
        compose.OAuth2TokenIntrospectionFactory,      // Token introspection

        // OpenID Connect
        compose.OpenIDConnectExplicitFactory,         // OIDC auth code
        compose.OpenIDConnectRefreshFactory,          // OIDC refresh
        compose.OpenIDConnectHybridFactory,           // OIDC hybrid

        // Implicit flow (disabled for security - use PKCE instead)
        // compose.OAuth2AuthorizeImplicitFactory,
    )
}
```

## Section 2: Storage Implementation

```go
// store/store.go
package store

import (
    "context"
    "time"

    "github.com/ory/fosite"
    "github.com/ory/fosite/handler/openid"
    "github.com/ory/fosite/handler/pkce"
)

// Storage combines all fosite storage interfaces.
type Storage interface {
    fosite.ClientManager
    fosite.Storage
    openid.OpenIDConnectRequestStorage
    pkce.PKCERequestStorage

    // Custom methods
    CreateClient(ctx context.Context, client *Client) error
    GetClient(ctx context.Context, id string) (*Client, error)
    ListClients(ctx context.Context) ([]*Client, error)
}
```

```go
// store/client.go
package store

import (
    "context"
    "crypto/sha256"
    "encoding/base64"
    "fmt"
    "time"

    "github.com/ory/fosite"
    "github.com/ory/herodot"
)

// Client represents an OAuth2 client registration.
type Client struct {
    ID                      string
    Secret                  string // Hashed with bcrypt
    RedirectURIs            []string
    GrantTypes              []string
    ResponseTypes           []string
    Scopes                  []string
    Audience                []string
    Public                  bool   // Public clients (SPAs, mobile) can't keep secrets
    TokenEndpointAuthMethod string // none, client_secret_basic, client_secret_post
    Name                    string
    LogoURI                 string
    ContactEmail            string
    CreatedAt               time.Time
}

// OAuth2Client implements fosite.Client
func (c *Client) GetID() string                            { return c.ID }
func (c *Client) GetHashedSecret() []byte                  { return []byte(c.Secret) }
func (c *Client) GetRedirectURIs() []string                { return c.RedirectURIs }
func (c *Client) GetGrantTypes() fosite.Arguments          { return c.GrantTypes }
func (c *Client) GetResponseTypes() fosite.Arguments       { return c.ResponseTypes }
func (c *Client) GetScopes() fosite.Arguments              { return c.Scopes }
func (c *Client) GetAudience() fosite.Arguments            { return c.Audience }
func (c *Client) IsPublic() bool                           { return c.Public }
func (c *Client) GetTokenEndpointAuthMethod() string       { return c.TokenEndpointAuthMethod }
func (c *Client) GetRequestURIs() []string                 { return nil }

// GetClient implements fosite.ClientManager.
// fosite calls this to look up clients during any OAuth2 flow.
func (s *PostgresStorage) GetClient(ctx context.Context, id string) (fosite.Client, error) {
    client, err := s.getClientByID(ctx, id)
    if err != nil {
        return nil, fosite.ErrNotFound
    }
    return client, nil
}

// ClientAuthenticationMiddleware validates client credentials
func (s *PostgresStorage) AuthenticateClient(ctx context.Context,
    id string, secret []byte) (fosite.Client, error) {
    client, err := s.getClientByID(ctx, id)
    if err != nil {
        return nil, fosite.ErrNotFound
    }

    if client.IsPublic() {
        return client, nil // Public clients don't use secrets
    }

    if err := bcrypt.CompareHashAndPassword([]byte(client.Secret), secret); err != nil {
        return nil, fosite.ErrClientAuthenticationFailed
    }

    return client, nil
}
```

```go
// store/postgres.go
package store

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/ory/fosite"
    "github.com/ory/fosite/handler/openid"
)

type PostgresStorage struct {
    db *pgxpool.Pool
}

func NewPostgresStorage(dsn string) (*PostgresStorage, error) {
    pool, err := pgxpool.New(context.Background(), dsn)
    if err != nil {
        return nil, fmt.Errorf("connecting to postgres: %w", err)
    }
    return &PostgresStorage{db: pool}, nil
}

// CreateAuthorizeCodeSession stores an authorization code session.
func (s *PostgresStorage) CreateAuthorizeCodeSession(ctx context.Context,
    code string, req fosite.Requester) error {
    data, err := json.Marshal(req)
    if err != nil {
        return err
    }
    _, err = s.db.Exec(ctx,
        `INSERT INTO oauth2_auth_codes (code, session_data, client_id, subject,
          requested_scopes, granted_scopes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
        code, data,
        req.GetClient().GetID(),
        req.GetSession().GetSubject(),
        scopesToString(req.GetRequestedScopes()),
        scopesToString(req.GetGrantedScopes()),
        time.Now().Add(10*time.Minute),
    )
    return err
}

// GetAuthorizeCodeSession retrieves and validates an authorization code.
func (s *PostgresStorage) GetAuthorizeCodeSession(ctx context.Context,
    code string, session fosite.Session) (fosite.Requester, error) {
    var sessionData []byte
    var expiresAt time.Time
    err := s.db.QueryRow(ctx,
        `SELECT session_data, expires_at FROM oauth2_auth_codes
         WHERE code = $1 AND used = false`,
        code,
    ).Scan(&sessionData, &expiresAt)
    if err != nil {
        return nil, fosite.ErrNotFound
    }

    if time.Now().After(expiresAt) {
        return nil, fosite.ErrTokenExpired
    }

    var req fosite.Request
    if err := json.Unmarshal(sessionData, &req); err != nil {
        return nil, fmt.Errorf("deserializing session: %w", err)
    }
    req.SetSession(session)
    return &req, nil
}

// InvalidateAuthorizeCodeSession marks the code as used (prevent replay).
func (s *PostgresStorage) InvalidateAuthorizeCodeSession(ctx context.Context,
    code string) error {
    _, err := s.db.Exec(ctx,
        `UPDATE oauth2_auth_codes SET used = true WHERE code = $1`,
        code,
    )
    return err
}

// CreateAccessTokenSession stores an access token.
func (s *PostgresStorage) CreateAccessTokenSession(ctx context.Context,
    signature string, req fosite.Requester) error {
    data, err := json.Marshal(req)
    if err != nil {
        return err
    }
    _, err = s.db.Exec(ctx,
        `INSERT INTO oauth2_access_tokens (signature, session_data, client_id,
          subject, granted_scopes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6)
         ON CONFLICT (signature) DO UPDATE SET
           session_data = EXCLUDED.session_data,
           expires_at = EXCLUDED.expires_at`,
        signature, data,
        req.GetClient().GetID(),
        req.GetSession().GetSubject(),
        scopesToString(req.GetGrantedScopes()),
        time.Now().Add(5*time.Minute),
    )
    return err
}

// CreateRefreshTokenSession stores a refresh token with rotation tracking.
func (s *PostgresStorage) CreateRefreshTokenSession(ctx context.Context,
    signature string, req fosite.Requester) error {
    data, err := json.Marshal(req)
    if err != nil {
        return err
    }
    _, err = s.db.Exec(ctx,
        `INSERT INTO oauth2_refresh_tokens (signature, session_data, client_id,
          subject, granted_scopes, created_at, expires_at, family_id)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)`,
        signature, data,
        req.GetClient().GetID(),
        req.GetSession().GetSubject(),
        scopesToString(req.GetGrantedScopes()),
        time.Now().Add(30*24*time.Hour),
        generateFamilyID(), // For refresh token family tracking
    )
    return err
}
```

## Section 3: HTTP Handlers

```go
// server/handlers.go
package server

import (
    "net/http"

    "github.com/ory/fosite"
    "go.uber.org/zap"
)

type Handlers struct {
    provider fosite.OAuth2Provider
    logger   *zap.Logger
}

// AuthorizeHandler handles GET /oauth2/authorize
// The user's browser is redirected here to begin the authorization flow.
func (h *Handlers) AuthorizeHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Parse the authorization request (validates all required parameters)
    ar, err := h.provider.NewAuthorizeRequest(ctx, r)
    if err != nil {
        h.logger.Error("authorize request error", zap.Error(err))
        h.provider.WriteAuthorizeError(ctx, w, ar, err)
        return
    }

    // Check if user is authenticated (session cookie, etc.)
    userID, authenticated := h.getUserFromSession(r)
    if !authenticated {
        // Redirect to login page, preserving the original request
        loginURL := "/login?return_to=" + url.QueryEscape(r.URL.String())
        http.Redirect(w, r, loginURL, http.StatusFound)
        return
    }

    // Check if consent is needed (first time this client requests these scopes)
    consentNeeded, err := h.isConsentNeeded(ctx, userID, ar)
    if err != nil {
        h.provider.WriteAuthorizeError(ctx, w, ar, fosite.ErrServerError.WithDebug(err.Error()))
        return
    }

    if consentNeeded {
        // Show consent page
        h.showConsentPage(w, r, ar, userID)
        return
    }

    // Auto-approve (consent previously given or trusted client)
    h.completeAuthorization(ctx, w, r, ar, userID)
}

// TokenHandler handles POST /oauth2/token
// Exchanges authorization codes, handles refresh, and client credentials.
func (h *Handlers) TokenHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Parse the token request
    accessRequest, err := h.provider.NewAccessRequest(ctx, r, h.newSession(ctx, r))
    if err != nil {
        h.logger.Error("access request error",
            zap.Error(err),
            zap.String("grant_type", r.FormValue("grant_type")),
        )
        h.provider.WriteAccessError(ctx, w, accessRequest, err)
        return
    }

    // For authorization code flow, grant the requested scopes
    // For production, validate scopes against client allowlist
    if accessRequest.GetGrantTypes().ExactOne("authorization_code") {
        for _, scope := range accessRequest.GetRequestedScopes() {
            if h.isScopeAllowed(accessRequest.GetClient(), scope) {
                accessRequest.GrantScope(scope)
            }
        }
    } else if accessRequest.GetGrantTypes().ExactOne("client_credentials") {
        // For client credentials, grant based on client's registered scopes
        for _, scope := range accessRequest.GetRequestedScopes() {
            if h.isScopeAllowedForClient(accessRequest.GetClient(), scope) {
                accessRequest.GrantScope(scope)
            }
        }
    }

    // Generate and store the access token (and refresh token if applicable)
    response, err := h.provider.NewAccessResponse(ctx, accessRequest)
    if err != nil {
        h.logger.Error("creating access response", zap.Error(err))
        h.provider.WriteAccessError(ctx, w, accessRequest, err)
        return
    }

    h.provider.WriteAccessResponse(ctx, w, accessRequest, response)
}

// IntrospectHandler handles POST /oauth2/introspect
// Allows resource servers to validate tokens.
func (h *Handlers) IntrospectHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // The introspecting client must authenticate
    introspectRequest, err := h.provider.NewIntrospectionRequest(
        ctx, r, h.newSession(ctx, r))
    if err != nil {
        errjson, _ := json.Marshal(map[string]interface{}{
            "active": false,
            "error":  err.Error(),
        })
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusOK) // Introspection always returns 200
        w.Write(errjson)
        return
    }

    h.provider.WriteIntrospectionResponse(ctx, w, introspectRequest)
}

// RevokeHandler handles POST /oauth2/revoke
// Revokes access and refresh tokens.
func (h *Handlers) RevokeHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    err := h.provider.NewRevocationRequest(ctx, r)
    h.provider.WriteRevocationResponse(ctx, w, err)
}

// JWKSHandler handles GET /.well-known/jwks.json
// Exposes the public keys for JWT verification.
func (h *Handlers) JWKSHandler(w http.ResponseWriter, r *http.Request) {
    jwks := h.getPublicJWKS()
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Cache-Control", "public, max-age=3600")
    json.NewEncoder(w).Encode(jwks)
}

// OIDCDiscoveryHandler handles GET /.well-known/openid-configuration
func (h *Handlers) OIDCDiscoveryHandler(w http.ResponseWriter, r *http.Request) {
    issuer := h.cfg.Issuer
    discovery := map[string]interface{}{
        "issuer":                                issuer,
        "authorization_endpoint":                issuer + "/oauth2/authorize",
        "token_endpoint":                        issuer + "/oauth2/token",
        "userinfo_endpoint":                     issuer + "/userinfo",
        "jwks_uri":                              issuer + "/.well-known/jwks.json",
        "revocation_endpoint":                   issuer + "/oauth2/revoke",
        "introspection_endpoint":                issuer + "/oauth2/introspect",
        "response_types_supported":              []string{"code", "token", "id_token"},
        "subject_types_supported":               []string{"public", "pairwise"},
        "id_token_signing_alg_values_supported": []string{"RS256"},
        "scopes_supported":                      []string{"openid", "profile", "email", "offline_access"},
        "token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post", "none"},
        "claims_supported":                      []string{"sub", "email", "name", "given_name", "family_name"},
        "code_challenge_methods_supported":      []string{"S256"},
        "grant_types_supported":                 []string{"authorization_code", "refresh_token", "client_credentials"},
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(discovery)
}
```

## Section 4: PKCE Implementation Details

### PKCE Flow Explained

PKCE (Proof Key for Code Exchange) prevents authorization code interception attacks. The client:
1. Generates a random `code_verifier` (43-128 characters)
2. Computes `code_challenge = BASE64URL(SHA256(code_verifier))`
3. Sends `code_challenge` and `code_challenge_method=S256` in the authorization request
4. Sends `code_verifier` in the token request
5. The server verifies: `SHA256(code_verifier) == code_challenge`

fosite handles this automatically when `EnforcePKCE: true` and `compose.OAuth2PKCEFactory` are configured. Here's a client-side implementation for reference:

```go
// client/pkce.go - How clients should implement PKCE
package client

import (
    "crypto/rand"
    "crypto/sha256"
    "encoding/base64"
    "fmt"
)

// GeneratePKCEChallenge generates a PKCE code verifier and challenge.
func GeneratePKCEChallenge() (verifier, challenge string, err error) {
    // Generate 32 random bytes = 256 bits of entropy
    verifierBytes := make([]byte, 32)
    if _, err := rand.Read(verifierBytes); err != nil {
        return "", "", fmt.Errorf("generating verifier: %w", err)
    }

    // Encode as base64url without padding (RFC 7636)
    verifier = base64.RawURLEncoding.EncodeToString(verifierBytes)

    // Challenge = BASE64URL(SHA256(verifier))
    h := sha256.New()
    h.Write([]byte(verifier))
    challenge = base64.RawURLEncoding.EncodeToString(h.Sum(nil))

    return verifier, challenge, nil
}

// AuthorizationURL builds the complete authorization URL with PKCE.
func AuthorizationURL(baseURL, clientID, redirectURI, state, challenge string,
    scopes []string) string {
    params := url.Values{
        "response_type":         {"code"},
        "client_id":             {clientID},
        "redirect_uri":          {redirectURI},
        "state":                 {state},
        "code_challenge":        {challenge},
        "code_challenge_method": {"S256"},
        "scope":                 {strings.Join(scopes, " ")},
    }
    return baseURL + "/oauth2/authorize?" + params.Encode()
}

// ExchangeCode exchanges an authorization code for tokens using PKCE.
func ExchangeCode(ctx context.Context, tokenURL, clientID, code, verifier,
    redirectURI string) (*TokenResponse, error) {
    // Public clients use the verifier directly (no client secret)
    params := url.Values{
        "grant_type":    {"authorization_code"},
        "client_id":     {clientID},
        "code":          {code},
        "redirect_uri":  {redirectURI},
        "code_verifier": {verifier},
    }

    resp, err := http.PostForm(tokenURL, params)
    if err != nil {
        return nil, fmt.Errorf("token exchange: %w", err)
    }
    defer resp.Body.Close()

    var tokenResp TokenResponse
    if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
        return nil, fmt.Errorf("decoding token response: %w", err)
    }

    if tokenResp.Error != "" {
        return nil, fmt.Errorf("token error %s: %s", tokenResp.Error,
            tokenResp.ErrorDescription)
    }

    return &tokenResp, nil
}
```

## Section 5: Refresh Token Rotation

Token rotation invalidates the used refresh token and issues a new one with each use. If an old refresh token is presented (indicating theft), the entire token family should be invalidated.

```go
// store/refresh_tokens.go
package store

import (
    "context"
    "fmt"
    "time"

    "github.com/ory/fosite"
)

// DeleteRefreshTokenSession is called by fosite after a refresh token is used.
// We implement rotation: mark the old token as used and issue a new one.
func (s *PostgresStorage) DeleteRefreshTokenSession(ctx context.Context,
    signature string) error {
    // Get the family ID before deleting
    var familyID string
    err := s.db.QueryRow(ctx,
        `SELECT family_id FROM oauth2_refresh_tokens WHERE signature = $1`,
        signature,
    ).Scan(&familyID)

    if err != nil {
        // Token not found - possible replay attack
        return fosite.ErrNotFound
    }

    // Mark as used (don't delete - we need it for replay detection)
    _, err = s.db.Exec(ctx,
        `UPDATE oauth2_refresh_tokens SET used = true, used_at = NOW()
         WHERE signature = $1`,
        signature,
    )
    return err
}

// GetRefreshTokenSession retrieves a refresh token, detecting reuse attacks.
func (s *PostgresStorage) GetRefreshTokenSession(ctx context.Context,
    signature string, session fosite.Session) (fosite.Requester, error) {
    var sessionData []byte
    var used bool
    var expiresAt time.Time
    var familyID string

    err := s.db.QueryRow(ctx,
        `SELECT session_data, used, expires_at, family_id
         FROM oauth2_refresh_tokens WHERE signature = $1`,
        signature,
    ).Scan(&sessionData, &used, &expiresAt, &familyID)

    if err != nil {
        return nil, fosite.ErrNotFound
    }

    // Refresh token reuse detection (RFC 6749 security best practice)
    if used {
        // A previously-used refresh token was presented.
        // This indicates a theft scenario: revoke the entire token family.
        s.revokeTokenFamily(ctx, familyID)
        return nil, fosite.ErrInvalidTokenFormat.WithDebug(
            "refresh token reuse detected; all tokens in family revoked")
    }

    if time.Now().After(expiresAt) {
        return nil, fosite.ErrTokenExpired
    }

    var req fosite.Request
    if err := json.Unmarshal(sessionData, &req); err != nil {
        return nil, fmt.Errorf("deserializing session: %w", err)
    }
    req.SetSession(session)
    return &req, nil
}

// revokeTokenFamily revokes all tokens in a refresh token family.
func (s *PostgresStorage) revokeTokenFamily(ctx context.Context, familyID string) error {
    // Get all non-expired tokens in the family
    rows, _ := s.db.Query(ctx,
        `SELECT signature, client_id, subject FROM oauth2_refresh_tokens
         WHERE family_id = $1 AND expires_at > NOW()`,
        familyID,
    )
    defer rows.Close()

    // Revoke each token
    _, err := s.db.Exec(ctx,
        `UPDATE oauth2_refresh_tokens
         SET revoked = true, revoked_at = NOW()
         WHERE family_id = $1`,
        familyID,
    )
    return err
}
```

## Section 6: Client Credentials Flow for Service-to-Service Auth

```go
// For machine-to-machine authentication
// The client authenticates with its client_id and client_secret
// No user interaction is needed

// Example: service A calling service B's API
// Service A gets a token from the authorization server
// Service B validates the token using introspection or JWT verification

// Service A: getting a token
func getServiceToken(ctx context.Context, tokenURL, clientID, clientSecret string,
    scopes []string) (string, error) {
    params := url.Values{
        "grant_type": {"client_credentials"},
        "scope":      {strings.Join(scopes, " ")},
    }

    req, err := http.NewRequestWithContext(ctx, "POST", tokenURL,
        strings.NewReader(params.Encode()))
    if err != nil {
        return "", err
    }
    req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
    // Client authentication via HTTP Basic Auth
    req.SetBasicAuth(clientID, clientSecret)

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    var tokenResp struct {
        AccessToken string `json:"access_token"`
        ExpiresIn   int    `json:"expires_in"`
        Error       string `json:"error"`
    }
    json.NewDecoder(resp.Body).Decode(&tokenResp)

    if tokenResp.Error != "" {
        return "", fmt.Errorf("token error: %s", tokenResp.Error)
    }
    return tokenResp.AccessToken, nil
}

// Token caching for client credentials (tokens are longer-lived for M2M)
type TokenCache struct {
    mu          sync.Mutex
    token       string
    expiresAt   time.Time
    tokenURL    string
    clientID    string
    clientSecret string
    scopes      []string
}

func (tc *TokenCache) GetToken(ctx context.Context) (string, error) {
    tc.mu.Lock()
    defer tc.mu.Unlock()

    // Renew if expired or within 30 seconds of expiry
    if time.Now().Before(tc.expiresAt.Add(-30 * time.Second)) {
        return tc.token, nil
    }

    token, err := getServiceToken(ctx, tc.tokenURL, tc.clientID, tc.clientSecret, tc.scopes)
    if err != nil {
        return "", err
    }

    tc.token = token
    tc.expiresAt = time.Now().Add(5 * time.Minute) // Match server's access token lifetime
    return token, nil
}
```

## Section 7: JWT vs Opaque Token Trade-offs

### JWT Access Tokens

JWT tokens are self-contained: resource servers can validate them by verifying the signature against the JWKS endpoint, without calling back to the authorization server.

**Advantages:**
- No database lookup on each request
- Works offline (once JWKS is cached)
- Carries claims inline (user ID, roles, scopes)

**Disadvantages:**
- Cannot be revoked before expiry (mitigated by short lifetimes)
- Larger token size
- Claims are visible to anyone who receives the token
- JWKS key rotation requires careful coordination

### Opaque Access Tokens

Opaque tokens are random strings with no embedded meaning. Validation requires calling the introspection endpoint.

**Advantages:**
- Can be revoked immediately
- Token compromise has limited blast radius
- Claims are not exposed in the token itself

**Disadvantages:**
- Introspection call on every request (latency, availability dependency)
- Introspection endpoint must scale with resource server traffic

### Hybrid Approach: Short-Lived JWTs with Introspection Fallback

```go
// token/validator.go
package token

import (
    "context"
    "sync"
    "time"

    "github.com/go-jose/go-jose/v3/jwt"
)

type Claims struct {
    Subject   string    `json:"sub"`
    Issuer    string    `json:"iss"`
    Audience  []string  `json:"aud"`
    ExpiresAt time.Time `json:"exp"`
    IssuedAt  time.Time `json:"iat"`
    Scope     string    `json:"scope"`
    ClientID  string    `json:"client_id"`
}

type Validator struct {
    jwksURL          string
    issuer           string
    introspectionURL string
    clientID         string
    clientSecret     string

    mu   sync.RWMutex
    jwks *jose.JSONWebKeySet
}

// ValidateToken validates a JWT first (fast path) or falls back to introspection.
func (v *Validator) ValidateToken(ctx context.Context, rawToken string) (*Claims, error) {
    // Try JWT validation first (fast, no network call)
    claims, err := v.validateJWT(ctx, rawToken)
    if err == nil {
        return claims, nil
    }

    // JWT validation failed - it might be an opaque token
    // Fall back to introspection (slower, requires network)
    return v.introspect(ctx, rawToken)
}

func (v *Validator) validateJWT(ctx context.Context, rawToken string) (*Claims, error) {
    v.mu.RLock()
    jwks := v.jwks
    v.mu.RUnlock()

    if jwks == nil {
        if err := v.refreshJWKS(ctx); err != nil {
            return nil, err
        }
        v.mu.RLock()
        jwks = v.jwks
        v.mu.RUnlock()
    }

    token, err := jwt.ParseSigned(rawToken)
    if err != nil {
        return nil, fmt.Errorf("parsing JWT: %w", err)
    }

    var claims Claims
    if err := token.Claims(jwks, &claims); err != nil {
        // Key not found in JWKS - refresh and retry once
        if err := v.refreshJWKS(ctx); err != nil {
            return nil, err
        }
        v.mu.RLock()
        jwks = v.jwks
        v.mu.RUnlock()
        if err := token.Claims(jwks, &claims); err != nil {
            return nil, fmt.Errorf("validating JWT signature: %w", err)
        }
    }

    if claims.Issuer != v.issuer {
        return nil, fmt.Errorf("unexpected issuer: %s", claims.Issuer)
    }
    if time.Now().After(claims.ExpiresAt) {
        return nil, fmt.Errorf("token expired at %v", claims.ExpiresAt)
    }

    return &claims, nil
}

func (v *Validator) introspect(ctx context.Context, rawToken string) (*Claims, error) {
    params := url.Values{
        "token":           {rawToken},
        "token_type_hint": {"access_token"},
    }

    req, err := http.NewRequestWithContext(ctx, "POST", v.introspectionURL,
        strings.NewReader(params.Encode()))
    if err != nil {
        return nil, err
    }
    req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
    req.SetBasicAuth(v.clientID, v.clientSecret)

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("introspection request: %w", err)
    }
    defer resp.Body.Close()

    var result struct {
        Active    bool   `json:"active"`
        Subject   string `json:"sub"`
        Scope     string `json:"scope"`
        ClientID  string `json:"client_id"`
        ExpiresAt int64  `json:"exp"`
    }

    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }

    if !result.Active {
        return nil, fmt.Errorf("token is not active")
    }

    return &Claims{
        Subject:   result.Subject,
        Issuer:    v.issuer,
        Scope:     result.Scope,
        ClientID:  result.ClientID,
        ExpiresAt: time.Unix(result.ExpiresAt, 0),
    }, nil
}
```

## Section 8: Security Hardening Checklist

```bash
# Validate the server's security posture

# 1. Verify PKCE is enforced
curl -s "https://auth.example.com/oauth2/authorize?\
  response_type=code&\
  client_id=my-spa&\
  redirect_uri=https://app.example.com/callback&\
  state=random123"
# Should fail with: error=invalid_request, missing code_challenge

# 2. Verify authorization codes are single-use
# After exchanging a code, attempting to use it again should fail

# 3. Test refresh token rotation
# After using a refresh token, the old token should be invalid

# 4. Verify TLS
openssl s_client -connect auth.example.com:443 -brief
# Should show TLS 1.3, forward secrecy cipher suite

# 5. Check security headers
curl -I https://auth.example.com/oauth2/authorize
# Should include: X-Frame-Options, X-Content-Type-Options, etc.

# 6. Verify short token lifetimes
# Decode access token and check exp claim:
TOKEN="..."
echo "${TOKEN}" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{exp, iat, sub}'
# exp - iat should be 300 (5 minutes)
```

## Conclusion

A production OAuth2 server requires careful attention to security at every layer: PKCE for public clients, refresh token rotation with family-based revocation for theft detection, short-lived JWTs for resource server scalability, and opaque token fallback for immediate revocation capability. The fosite library handles the specification compliance, but the storage layer, session management, and key rotation procedures require careful design. For most organizations, deploying ory-hydra rather than building on fosite directly delivers the same compliance with significantly less implementation burden; this guide's patterns remain relevant for understanding what happens inside any OAuth2 implementation.
