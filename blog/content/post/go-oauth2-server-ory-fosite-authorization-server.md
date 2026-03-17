---
title: "Go OAuth2 Server: Building an Authorization Server with ory/fosite"
date: 2029-11-14T00:00:00-05:00
draft: false
tags: ["Go", "OAuth2", "OIDC", "Security", "Authentication", "fosite", "JWT", "PKCE"]
categories:
- Go
- Security
- Authentication
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to building an OAuth2/OIDC authorization server in Go using ory/fosite: grant type implementation, token introspection, PKCE enforcement, JWT signing, and dynamic client registration."
more_link: "yes"
url: "/go-oauth2-server-ory-fosite-authorization-server/"
---

Building a production-grade OAuth2 authorization server requires correct implementation of numerous RFCs: OAuth 2.0 (RFC 6749), JWT Bearer Tokens (RFC 7519), PKCE (RFC 7636), Token Introspection (RFC 7662), Dynamic Client Registration (RFC 7591), and OpenID Connect Core 1.0. The `ory/fosite` library implements all of these correctly and is battle-tested in Ory Hydra, a production OAuth2 server. This post shows how to build a custom authorization server on top of fosite.

<!--more-->

# Go OAuth2 Server: Building an Authorization Server with ory/fosite

## OAuth2 Flow Overview

Before diving into implementation, understanding the grant types is essential:

| Grant Type | Use Case | Security Level |
|-----------|----------|----------------|
| Authorization Code + PKCE | Web apps, SPAs, mobile | Highest |
| Client Credentials | Machine-to-machine | High (no user) |
| Refresh Token | Long-lived sessions | Requires secure storage |
| Device Code | CLI tools, smart TVs | Good for constrained devices |
| ~~Implicit~~ | Deprecated | Not recommended |
| ~~Resource Owner Password~~ | Legacy only | Not recommended |

The authorization code flow with PKCE:

```
Client                    Authorization Server          Resource Server
   │                              │                           │
   │  1. Generate PKCE:           │                           │
   │    code_verifier = random    │                           │
   │    code_challenge = SHA256   │                           │
   │    (code_verifier)           │                           │
   │                              │                           │
   │  2. Authorization Request    │                           │
   │  GET /oauth2/auth?           │                           │
   │    client_id=abc             │                           │
   │    code_challenge=xyz        │                           │
   │    code_challenge_method=S256│                           │
   │─────────────────────────────►│                           │
   │                              │                           │
   │  3. User authenticates       │                           │
   │  4. Authorization Code       │                           │
   │◄─────────────────────────────│                           │
   │                              │                           │
   │  5. Token Request            │                           │
   │  POST /oauth2/token          │                           │
   │    code=xyz                  │                           │
   │    code_verifier=abc         │                           │
   │─────────────────────────────►│                           │
   │                              │                           │
   │  6. Access Token             │                           │
   │◄─────────────────────────────│                           │
   │                              │                           │
   │  7. API Request              │                           │
   │  Bearer <token>              │                           │
   │──────────────────────────────│──────────────────────────►│
   │                              │ 8. Introspect or verify   │
```

## Project Setup

```bash
# Initialize the project
mkdir oauth2-server && cd oauth2-server
go mod init github.com/myorg/oauth2-server

# Install fosite and dependencies
go get github.com/ory/fosite
go get github.com/ory/fosite/compose
go get github.com/ory/fosite/storage
go get github.com/go-jose/go-jose/v3
go get github.com/gorilla/mux
go get go.uber.org/zap
go get github.com/jackc/pgx/v5
```

### Project Structure

```
oauth2-server/
├── main.go
├── config/
│   └── config.go
├── server/
│   ├── server.go
│   ├── handlers.go
│   └── middleware.go
├── store/
│   ├── client_store.go
│   ├── token_store.go
│   └── user_store.go
├── provider/
│   └── provider.go
└── keys/
    └── jwks.go
```

## Implementing the Storage Layer

fosite requires a `Storage` interface implementation. We'll build a production-ready PostgreSQL-backed store:

```go
// store/client_store.go
package store

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/ory/fosite"
    "go.uber.org/zap"
)

// Client represents an OAuth2 client registration
type Client struct {
    ID                string            `json:"id"`
    HashedSecret      []byte            `json:"hashed_secret,omitempty"`
    RedirectURIs      []string          `json:"redirect_uris"`
    GrantTypes        []string          `json:"grant_types"`
    ResponseTypes     []string          `json:"response_types"`
    Scopes            []string          `json:"scopes"`
    Audience          []string          `json:"audience"`
    Public            bool              `json:"public"` // No secret (PKCE required)
    TokenEndpointAuth string            `json:"token_endpoint_auth_method"`
    Metadata          map[string]interface{} `json:"metadata,omitempty"`
    CreatedAt         time.Time         `json:"created_at"`
}

// fosite.Client interface implementation
func (c *Client) GetID() string                            { return c.ID }
func (c *Client) GetHashedSecret() []byte                  { return c.HashedSecret }
func (c *Client) GetRedirectURIs() []string                { return c.RedirectURIs }
func (c *Client) GetGrantTypes() fosite.Arguments          { return c.GrantTypes }
func (c *Client) GetResponseTypes() fosite.Arguments       { return c.ResponseTypes }
func (c *Client) GetScopes() fosite.Arguments              { return c.Scopes }
func (c *Client) GetAudience() fosite.Arguments            { return c.Audience }
func (c *Client) IsPublic() bool                           { return c.Public }
func (c *Client) GetOwner() string                         { return "" }

// ClientStore manages OAuth2 client registrations in PostgreSQL
type ClientStore struct {
    db  *pgxpool.Pool
    log *zap.Logger
}

func NewClientStore(db *pgxpool.Pool, log *zap.Logger) *ClientStore {
    return &ClientStore{db: db, log: log}
}

func (s *ClientStore) GetClient(ctx context.Context, id string) (fosite.Client, error) {
    row := s.db.QueryRow(ctx,
        `SELECT id, hashed_secret, redirect_uris, grant_types, response_types,
                scopes, audience, public, token_endpoint_auth_method, metadata
         FROM oauth2_clients WHERE id = $1 AND deleted_at IS NULL`,
        id)

    var c Client
    var metaJSON []byte

    err := row.Scan(
        &c.ID, &c.HashedSecret,
        &c.RedirectURIs, &c.GrantTypes, &c.ResponseTypes,
        &c.Scopes, &c.Audience, &c.Public, &c.TokenEndpointAuth, &metaJSON,
    )
    if err != nil {
        return nil, fmt.Errorf("client %s not found: %w", id, fosite.ErrNotFound)
    }

    if metaJSON != nil {
        json.Unmarshal(metaJSON, &c.Metadata)
    }

    return &c, nil
}

func (s *ClientStore) CreateClient(ctx context.Context, c *Client) error {
    metaJSON, _ := json.Marshal(c.Metadata)

    _, err := s.db.Exec(ctx,
        `INSERT INTO oauth2_clients
         (id, hashed_secret, redirect_uris, grant_types, response_types,
          scopes, audience, public, token_endpoint_auth_method, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        c.ID, c.HashedSecret,
        c.RedirectURIs, c.GrantTypes, c.ResponseTypes,
        c.Scopes, c.Audience, c.Public, c.TokenEndpointAuth, metaJSON,
    )
    return err
}
```

### Token Store

```go
// store/token_store.go
package store

import (
    "context"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/ory/fosite"
    "go.uber.org/zap"
)

// TokenStore implements fosite storage interfaces for tokens
type TokenStore struct {
    db  *pgxpool.Pool
    log *zap.Logger
}

func NewTokenStore(db *pgxpool.Pool, log *zap.Logger) *TokenStore {
    return &TokenStore{db: db, log: log}
}

// CreateAuthorizeCodeSession stores an authorization code
func (s *TokenStore) CreateAuthorizeCodeSession(ctx context.Context, code string, request fosite.Requester) error {
    return s.createToken(ctx, "auth_code", code, request)
}

// GetAuthorizeCodeSession retrieves an authorization code session
func (s *TokenStore) GetAuthorizeCodeSession(ctx context.Context, code string, session fosite.Session) (fosite.Requester, error) {
    return s.getToken(ctx, "auth_code", code, session)
}

// InvalidateAuthorizeCodeSession marks an auth code as used (codes are single-use)
func (s *TokenStore) InvalidateAuthorizeCodeSession(ctx context.Context, code string) error {
    _, err := s.db.Exec(ctx,
        `UPDATE oauth2_tokens SET used_at = NOW(), expires_at = NOW()
         WHERE token_type = 'auth_code' AND signature = $1`,
        code)
    return err
}

// CreateAccessTokenSession stores an access token
func (s *TokenStore) CreateAccessTokenSession(ctx context.Context, signature string, request fosite.Requester) error {
    return s.createToken(ctx, "access_token", signature, request)
}

// GetAccessTokenSession retrieves an access token
func (s *TokenStore) GetAccessTokenSession(ctx context.Context, signature string, session fosite.Session) (fosite.Requester, error) {
    return s.getToken(ctx, "access_token", signature, session)
}

// DeleteAccessTokenSession revokes an access token
func (s *TokenStore) DeleteAccessTokenSession(ctx context.Context, signature string) error {
    return s.deleteToken(ctx, "access_token", signature)
}

// CreateRefreshTokenSession stores a refresh token
func (s *TokenStore) CreateRefreshTokenSession(ctx context.Context, signature string, request fosite.Requester) error {
    return s.createToken(ctx, "refresh_token", signature, request)
}

// GetRefreshTokenSession retrieves a refresh token
func (s *TokenStore) GetRefreshTokenSession(ctx context.Context, signature string, session fosite.Session) (fosite.Requester, error) {
    return s.getToken(ctx, "refresh_token", signature, session)
}

// RevokeRefreshToken invalidates a refresh token and its access tokens
func (s *TokenStore) RevokeRefreshToken(ctx context.Context, requestID string) error {
    _, err := s.db.Exec(ctx,
        `UPDATE oauth2_tokens SET revoked_at = NOW()
         WHERE request_id = $1`,
        requestID)
    return err
}

// RevokeRefreshTokenMaybeGracePeriod same as RevokeRefreshToken (no grace period in this impl)
func (s *TokenStore) RevokeRefreshTokenMaybeGracePeriod(ctx context.Context, requestID string, signature string) error {
    return s.RevokeRefreshToken(ctx, requestID)
}

func (s *TokenStore) createToken(ctx context.Context, tokenType, signature string, req fosite.Requester) error {
    sessionJSON, err := json.Marshal(req.GetSession())
    if err != nil {
        return fmt.Errorf("serializing session: %w", err)
    }

    requestJSON, err := json.Marshal(req)
    if err != nil {
        return fmt.Errorf("serializing request: %w", err)
    }

    _, err = s.db.Exec(ctx,
        `INSERT INTO oauth2_tokens
         (token_type, signature, request_id, client_id, subject, scopes,
          session_data, request_data, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (token_type, signature) DO UPDATE
         SET request_data = EXCLUDED.request_data`,
        tokenType,
        signature,
        req.GetID(),
        req.GetClient().GetID(),
        req.GetSession().GetSubject(),
        req.GetGrantedScopes(),
        sessionJSON,
        requestJSON,
        req.GetSession().GetExpiresAt(fosite.AccessToken),
    )
    return err
}

func (s *TokenStore) getToken(ctx context.Context, tokenType, signature string, session fosite.Session) (fosite.Requester, error) {
    row := s.db.QueryRow(ctx,
        `SELECT request_data, session_data, revoked_at, used_at
         FROM oauth2_tokens
         WHERE token_type = $1 AND signature = $2 AND expires_at > NOW()`,
        tokenType, signature)

    var requestData, sessionData []byte
    var revokedAt, usedAt *time.Time

    if err := row.Scan(&requestData, &sessionData, &revokedAt, &usedAt); err != nil {
        return nil, fosite.ErrNotFound
    }

    if revokedAt != nil {
        return nil, fosite.ErrTokenRevoked
    }

    if usedAt != nil && tokenType == "auth_code" {
        return nil, fosite.ErrInvalidatedAuthorizeCode
    }

    // Deserialize the session
    if err := json.Unmarshal(sessionData, session); err != nil {
        return nil, fmt.Errorf("deserializing session: %w", err)
    }

    // Deserialize the request
    var request fosite.Request
    if err := json.Unmarshal(requestData, &request); err != nil {
        return nil, fmt.Errorf("deserializing request: %w", err)
    }
    request.SetSession(session)

    return &request, nil
}

func (s *TokenStore) deleteToken(ctx context.Context, tokenType, signature string) error {
    _, err := s.db.Exec(ctx,
        `UPDATE oauth2_tokens SET revoked_at = NOW()
         WHERE token_type = $1 AND signature = $2`,
        tokenType, signature)
    return err
}
```

## JWT Signing Keys and JWKS

```go
// keys/jwks.go
package keys

import (
    "crypto/ecdsa"
    "crypto/elliptic"
    "crypto/rand"
    "crypto/rsa"
    "encoding/json"
    "fmt"
    "os"
    "time"

    "github.com/go-jose/go-jose/v3"
    josejwt "github.com/go-jose/go-jose/v3/jwt"
)

// KeySet manages JWT signing keys
type KeySet struct {
    rsaPrivate  *rsa.PrivateKey
    ecPrivate   *ecdsa.PrivateKey
    keyID       string
    jwks        *jose.JSONWebKeySet
}

func LoadOrGenerateKeys(rsaKeyPath, ecKeyPath string) (*KeySet, error) {
    ks := &KeySet{
        keyID: fmt.Sprintf("key-%d", time.Now().Unix()),
    }

    // Try to load RSA key
    if rsaKeyPath != "" {
        if key, err := loadRSAPrivateKey(rsaKeyPath); err == nil {
            ks.rsaPrivate = key
        }
    }

    // Generate RSA key if not loaded
    if ks.rsaPrivate == nil {
        key, err := rsa.GenerateKey(rand.Reader, 4096)
        if err != nil {
            return nil, fmt.Errorf("generating RSA key: %w", err)
        }
        ks.rsaPrivate = key
    }

    // Generate EC key (for ES256 tokens - faster verification)
    ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
    if err != nil {
        return nil, fmt.Errorf("generating EC key: %w", err)
    }
    ks.ecPrivate = ecKey

    ks.buildJWKS()
    return ks, nil
}

func (ks *KeySet) buildJWKS() {
    ks.jwks = &jose.JSONWebKeySet{
        Keys: []jose.JSONWebKey{
            {
                Key:       ks.rsaPrivate.Public(),
                KeyID:     ks.keyID + "-rsa",
                Algorithm: string(jose.RS256),
                Use:       "sig",
            },
            {
                Key:       ks.ecPrivate.Public(),
                KeyID:     ks.keyID + "-ec",
                Algorithm: string(jose.ES256),
                Use:       "sig",
            },
        },
    }
}

// JWKSHandler returns the public JWKS for JWT verification
func (ks *KeySet) JWKSHandler() []byte {
    b, _ := json.MarshalIndent(ks.jwks, "", "  ")
    return b
}

// RSASigner returns a JWS signer for RS256
func (ks *KeySet) RSASigner() (jose.Signer, error) {
    return jose.NewSigner(
        jose.SigningKey{
            Algorithm: jose.RS256,
            Key: jose.JSONWebKey{
                Key:   ks.rsaPrivate,
                KeyID: ks.keyID + "-rsa",
            },
        },
        (&jose.SignerOptions{}).WithType("JWT"),
    )
}

// ECSigner returns a JWS signer for ES256
func (ks *KeySet) ECSigner() (jose.Signer, error) {
    return jose.NewSigner(
        jose.SigningKey{
            Algorithm: jose.ES256,
            Key: jose.JSONWebKey{
                Key:   ks.ecPrivate,
                KeyID: ks.keyID + "-ec",
            },
        },
        (&jose.SignerOptions{}).WithType("JWT"),
    )
}
```

## Building the fosite OAuth2 Provider

```go
// provider/provider.go
package provider

import (
    "crypto/rsa"
    "crypto/ecdsa"
    "time"

    "github.com/ory/fosite"
    "github.com/ory/fosite/compose"
    "github.com/ory/fosite/handler/openid"
    "github.com/ory/fosite/token/jwt"
    "go.uber.org/zap"

    "github.com/myorg/oauth2-server/store"
    "github.com/myorg/oauth2-server/keys"
)

// BuildOAuth2Provider creates a configured fosite OAuth2 provider
func BuildOAuth2Provider(
    storage *store.Store,
    keySet *keys.KeySet,
    config *fosite.Config,
    log *zap.Logger,
) fosite.OAuth2Provider {

    // JWT strategy for access tokens
    // RS256 for broad compatibility, ES256 for performance
    jwtStrategy := &jwt.DefaultStrategy{
        Signer: &jwt.DefaultSigner{
            GetPrivateKey: func(ctx context.Context) (interface{}, error) {
                return keySet.RSAPrivateKey(), nil
            },
        },
        Config: config,
    }

    // OpenID Connect strategy
    oidcStrategy := &openid.DefaultStrategy{
        Signer: &jwt.DefaultSigner{
            GetPrivateKey: func(ctx context.Context) (interface{}, error) {
                return keySet.ECPrivateKey(), nil
            },
        },
        Config: config,
    }

    // Use compose.ComposeAllEnabled to enable all grant types
    // Or compose specific ones:
    return compose.Compose(
        config,
        storage,

        // OAuth2 grant handlers:
        &compose.OAuth2AuthorizeExplicitFactory{},   // Authorization code
        &compose.OAuth2ClientCredentialsGrantFactory{},
        &compose.OAuth2RefreshTokenGrantFactory{},
        &compose.OAuth2TokenRevocationFactory{},
        &compose.OAuth2TokenIntrospectionFactory{},
        &compose.OAuth2PKCEFactory{},                 // PKCE support

        // OIDC handlers:
        &compose.OpenIDConnectExplicitFactory{},
        &compose.OpenIDConnectRefreshFactory{},
        &compose.OpenIDConnectHybridFactory{},

        // Additional:
        &compose.OAuth2DeviceAuthorizationGrantFactory{},  // Device flow

        // JWT strategy for token generation
        jwtStrategy,
        oidcStrategy,
    )
}

// OAuthConfig returns a configured fosite Config
func OAuthConfig(issuer string) *fosite.Config {
    return &fosite.Config{
        // Token lifetimes
        AccessTokenLifespan:   time.Hour,
        RefreshTokenLifespan:  30 * 24 * time.Hour,
        AuthorizeCodeLifespan: 10 * time.Minute,
        IDTokenLifespan:       time.Hour,

        // PKCE configuration
        EnforcePKCE:           true,   // Require PKCE for all public clients
        EnforcePKCEForPublicClients: true,
        PKCEEnforceForPublicClients: true,

        // General settings
        GlobalSecret: globalSecret,  // Load from env/KMS in production
        SendDebugMessagesToClients: false, // Never in production!

        // Token endpoint auth methods
        TokenURL:      issuer + "/oauth2/token",
        AuthURL:       issuer + "/oauth2/auth",
        IntrospectURL: issuer + "/oauth2/introspect",
        RevocationURL: issuer + "/oauth2/revoke",

        // OIDC
        Issuer: issuer,

        // Minimum entropy for secrets and codes
        MinParameterEntropy: fosite.MinParameterEntropy,

        // Allowed hash algorithms
        JWTScopeClaimKey: fosite.JWTScopeFieldList,

        // Refresh token rotation
        RefreshTokenScopes: []string{"offline_access"},
    }
}
```

## HTTP Handlers

```go
// server/handlers.go
package server

import (
    "encoding/json"
    "net/http"
    "time"

    "github.com/gorilla/mux"
    "github.com/ory/fosite"
    "github.com/ory/fosite/handler/openid"
    "go.uber.org/zap"
)

type OAuthServer struct {
    provider    fosite.OAuth2Provider
    sessions    SessionStore
    userStore   UserStore
    log         *zap.Logger
}

// AuthorizeEndpoint handles the authorization request (GET /oauth2/auth)
func (s *OAuthServer) AuthorizeEndpoint(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Parse and validate the authorization request
    authReq, err := s.provider.NewAuthorizeRequest(ctx, r)
    if err != nil {
        s.log.Warn("invalid authorization request",
            zap.Error(err),
            zap.String("client_id", r.URL.Query().Get("client_id")))
        s.provider.WriteAuthorizeError(ctx, w, authReq, err)
        return
    }

    // Check if user is authenticated
    userID, err := s.getUserFromSession(r)
    if err != nil || userID == "" {
        // Redirect to login page
        loginURL := "/login?return_to=" + r.URL.RequestURI()
        http.Redirect(w, r, loginURL, http.StatusFound)
        return
    }

    // Check if user has approved this client
    if !s.hasUserApproved(ctx, userID, authReq.GetClient().GetID()) {
        // Show consent page
        s.showConsentPage(w, r, authReq, userID)
        return
    }

    // Create session
    mySession := s.buildSession(userID, authReq)

    // Grant requested scopes
    for _, scope := range authReq.GetRequestedScopes() {
        if s.isScopeAllowed(userID, scope) {
            authReq.GrantScope(scope)
        }
    }

    // Create authorization response (code or token)
    response, err := s.provider.NewAuthorizeResponse(ctx, authReq, mySession)
    if err != nil {
        s.log.Error("creating authorization response", zap.Error(err))
        s.provider.WriteAuthorizeError(ctx, w, authReq, err)
        return
    }

    // Write redirect response
    s.provider.WriteAuthorizeResponse(ctx, w, authReq, response)
}

// TokenEndpoint handles token requests (POST /oauth2/token)
func (s *OAuthServer) TokenEndpoint(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    mySession := &MySession{}

    // Parse and validate token request
    accessRequest, err := s.provider.NewAccessRequest(ctx, r, mySession)
    if err != nil {
        s.log.Warn("invalid token request",
            zap.Error(err),
            zap.String("grant_type", r.PostForm.Get("grant_type")))
        s.provider.WriteAccessError(ctx, w, accessRequest, err)
        return
    }

    // Grant scopes based on client permissions
    if accessRequest.GetGrantTypes().ExactOne("client_credentials") {
        // For client credentials, grant all requested scopes the client is allowed
        for _, scope := range accessRequest.GetRequestedScopes() {
            if s.clientAllowedScope(accessRequest.GetClient(), scope) {
                accessRequest.GrantScope(scope)
            }
        }
    }

    // Create token response
    response, err := s.provider.NewAccessResponse(ctx, accessRequest)
    if err != nil {
        s.log.Error("creating token response", zap.Error(err))
        s.provider.WriteAccessError(ctx, w, accessRequest, err)
        return
    }

    // Write token response
    s.provider.WriteAccessResponse(ctx, w, accessRequest, response)
}

// IntrospectEndpoint handles token introspection (POST /oauth2/introspect)
// RFC 7662 - Token Introspection
func (s *OAuthServer) IntrospectEndpoint(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    mySession := &MySession{}

    // Validate the introspection request (caller must be authenticated)
    _, err := s.provider.NewIntrospectionRequest(ctx, r, mySession)
    if err != nil {
        s.log.Warn("introspection error", zap.Error(err))
        // RFC 7662: on error, return {"active": false}
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]interface{}{"active": false})
        return
    }

    // Write introspection response
    // fosite writes {"active": true, "sub": "...", "scope": "...", ...}
    // Or {"active": false} for invalid tokens
    s.provider.WriteIntrospectionResponse(ctx, w, mySession)
}

// RevokeEndpoint handles token revocation (POST /oauth2/revoke)
// RFC 7009 - Token Revocation
func (s *OAuthServer) RevokeEndpoint(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    err := s.provider.NewRevocationRequest(ctx, r)
    s.provider.WriteRevocationResponse(ctx, w, err)
}

// UserInfoEndpoint returns the authenticated user's claims (GET /userinfo)
// OpenID Connect Core 1.0 - UserInfo Endpoint
func (s *OAuthServer) UserInfoEndpoint(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    mySession := &MySession{}
    tokenType, _, err := s.provider.IntrospectToken(
        ctx,
        fosite.AccessTokenFromRequest(r),
        fosite.AccessToken,
        mySession,
    )

    if err != nil || tokenType != fosite.AccessToken {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    // Build claims
    claims := map[string]interface{}{
        "sub":   mySession.Subject,
        "email": mySession.Extra["email"],
        "name":  mySession.Extra["name"],
    }

    if mySession.Claims.Contains("profile") {
        claims["given_name"] = mySession.Extra["given_name"]
        claims["family_name"] = mySession.Extra["family_name"]
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(claims)
}

// JWKSEndpoint returns the public keys for token verification
func (s *OAuthServer) JWKSEndpoint(keySet *keys.KeySet) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        w.Header().Set("Cache-Control", "public, max-age=3600")
        w.Write(keySet.JWKSHandler())
    }
}

// DiscoveryEndpoint serves OpenID Connect Discovery document
func (s *OAuthServer) DiscoveryEndpoint(issuer string) http.HandlerFunc {
    discovery := map[string]interface{}{
        "issuer":                                issuer,
        "authorization_endpoint":               issuer + "/oauth2/auth",
        "token_endpoint":                       issuer + "/oauth2/token",
        "userinfo_endpoint":                    issuer + "/userinfo",
        "jwks_uri":                             issuer + "/.well-known/jwks.json",
        "revocation_endpoint":                  issuer + "/oauth2/revoke",
        "introspection_endpoint":               issuer + "/oauth2/introspect",
        "response_types_supported":             []string{"code", "token", "id_token", "code token", "code id_token"},
        "subject_types_supported":              []string{"public"},
        "id_token_signing_alg_values_supported": []string{"RS256", "ES256"},
        "scopes_supported":                     []string{"openid", "profile", "email", "offline_access"},
        "token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post", "none"},
        "claims_supported":                     []string{"sub", "iss", "aud", "exp", "iat", "name", "email"},
        "grant_types_supported":                []string{"authorization_code", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:device_code"},
        "code_challenge_methods_supported":     []string{"S256"},  // Plain is insecure - don't list it
    }

    b, _ := json.MarshalIndent(discovery, "", "  ")

    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        w.Header().Set("Cache-Control", "public, max-age=3600")
        w.Write(b)
    }
}
```

## Custom Session

```go
// session type - stores user claims in tokens
type MySession struct {
    openid.DefaultSession
    Subject string                 `json:"subject"`
    Extra   map[string]interface{} `json:"extra"`
}

func (s *MySession) SetSubject(subject string) {
    s.Subject = subject
    s.DefaultSession.Subject = subject
}

func (s *MySession) GetSubject() string {
    return s.Subject
}

// Clone creates a copy of the session (required by fosite)
func (s *MySession) Clone() fosite.Session {
    if s == nil {
        return &MySession{}
    }
    clone := *s
    if s.Extra != nil {
        clone.Extra = make(map[string]interface{}, len(s.Extra))
        for k, v := range s.Extra {
            clone.Extra[k] = v
        }
    }
    return &clone
}
```

## PKCE Enforcement

PKCE (Proof Key for Code Exchange, RFC 7636) prevents authorization code interception. fosite enforces it when configured:

```go
// Force PKCE for all public clients
config := &fosite.Config{
    EnforcePKCE: true,
    EnforcePKCEForPublicClients: true,
    // Disable plain method - S256 only
    PKCEVerifier: fosite.DefaultPKCEVerifier{
        AllowedMethods: []string{"S256"}, // Only S256, not plain
    },
}

// Client registration with PKCE enforcement
publicClient := &store.Client{
    ID:             "my-spa-client",
    HashedSecret:   nil,          // No secret for public clients
    Public:         true,         // Mark as public (PKCE required)
    RedirectURIs:   []string{"https://myapp.example.com/callback"},
    GrantTypes:     []string{"authorization_code", "refresh_token"},
    ResponseTypes:  []string{"code"},
    Scopes:         []string{"openid", "profile", "email", "offline_access"},
}
```

Client-side PKCE generation:

```go
// PKCE code generation (client-side, e.g., for testing)
package pkce

import (
    "crypto/rand"
    "crypto/sha256"
    "encoding/base64"
)

// GeneratePKCEPair generates a code_verifier and code_challenge for PKCE
func GeneratePKCEPair() (verifier, challenge string, err error) {
    // Generate random 32-96 byte verifier
    b := make([]byte, 64)
    if _, err = rand.Read(b); err != nil {
        return
    }

    // Base64URL encode (no padding)
    verifier = base64.RawURLEncoding.EncodeToString(b)

    // code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
    h := sha256.Sum256([]byte(verifier))
    challenge = base64.RawURLEncoding.EncodeToString(h[:])

    return
}

// Example authorization URL with PKCE
func BuildAuthURL(baseURL, clientID, redirectURI, state, codeChallenge string) string {
    return fmt.Sprintf(
        "%s/oauth2/auth?client_id=%s&redirect_uri=%s&response_type=code"+
            "&state=%s&code_challenge=%s&code_challenge_method=S256"+
            "&scope=openid%%20profile%%20email",
        baseURL, clientID,
        url.QueryEscape(redirectURI),
        url.QueryEscape(state),
        url.QueryEscape(codeChallenge),
    )
}
```

## Dynamic Client Registration (RFC 7591)

```go
// server/registration.go
package server

import (
    "encoding/json"
    "net/http"
    "time"

    "github.com/ory/fosite"
    "golang.org/x/crypto/bcrypt"
    "go.uber.org/zap"
)

// ClientRegistrationRequest matches RFC 7591
type ClientRegistrationRequest struct {
    ClientName              string   `json:"client_name"`
    ClientURI               string   `json:"client_uri"`
    RedirectURIs            []string `json:"redirect_uris"`
    GrantTypes              []string `json:"grant_types"`
    ResponseTypes           []string `json:"response_types"`
    Scopes                  string   `json:"scope"`
    TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
    LogoURI                 string   `json:"logo_uri"`
    Contacts                []string `json:"contacts"`
}

// RegisterClientEndpoint implements RFC 7591 Dynamic Client Registration
func (s *OAuthServer) RegisterClientEndpoint(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Verify initial access token if required
    if s.registrationAccessToken != "" {
        token := fosite.AccessTokenFromRequest(r)
        if !s.validateRegistrationToken(token) {
            http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
            return
        }
    }

    var req ClientRegistrationRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, `{"error":"invalid_request"}`, http.StatusBadRequest)
        return
    }

    // Validate and normalize the request
    if err := s.validateClientRequest(&req); err != nil {
        s.log.Warn("invalid client registration", zap.Error(err))
        http.Error(w, fmt.Sprintf(`{"error":"invalid_request","error_description":"%s"}`, err), http.StatusBadRequest)
        return
    }

    // Generate client credentials
    clientID := generateClientID()
    clientSecret := generateClientSecret()

    hashedSecret, err := bcrypt.GenerateFromPassword([]byte(clientSecret), bcrypt.DefaultCost)
    if err != nil {
        http.Error(w, `{"error":"server_error"}`, http.StatusInternalServerError)
        return
    }

    client := &store.Client{
        ID:              clientID,
        HashedSecret:    hashedSecret,
        RedirectURIs:    req.RedirectURIs,
        GrantTypes:      req.GrantTypes,
        ResponseTypes:   req.ResponseTypes,
        Scopes:          strings.Split(req.Scopes, " "),
        Public:          req.TokenEndpointAuthMethod == "none",
        TokenEndpointAuth: req.TokenEndpointAuthMethod,
        Metadata: map[string]interface{}{
            "client_name": req.ClientName,
            "client_uri":  req.ClientURI,
        },
        CreatedAt: time.Now(),
    }

    if err := s.store.Clients.CreateClient(ctx, client); err != nil {
        s.log.Error("storing client", zap.Error(err))
        http.Error(w, `{"error":"server_error"}`, http.StatusInternalServerError)
        return
    }

    // Return client metadata with credentials
    response := map[string]interface{}{
        "client_id":              clientID,
        "client_secret":          clientSecret, // Only returned at registration time
        "client_id_issued_at":    time.Now().Unix(),
        "client_secret_expires_at": 0, // 0 = never expires
        "redirect_uris":          req.RedirectURIs,
        "grant_types":            req.GrantTypes,
        "response_types":         req.ResponseTypes,
        "scope":                  req.Scopes,
        "token_endpoint_auth_method": req.TokenEndpointAuthMethod,
        "registration_access_token": generateRegistrationToken(clientID),
        "registration_client_uri": s.issuer + "/connect/register/" + clientID,
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(response)
}

func generateClientID() string {
    b := make([]byte, 16)
    rand.Read(b)
    return "client-" + hex.EncodeToString(b)
}

func generateClientSecret() string {
    b := make([]byte, 32)
    rand.Read(b)
    return base64.RawURLEncoding.EncodeToString(b)
}
```

## Server Assembly and Routes

```go
// main.go
package main

import (
    "context"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/gorilla/mux"
    "github.com/jackc/pgx/v5/pgxpool"
    "go.uber.org/zap"

    "github.com/myorg/oauth2-server/keys"
    "github.com/myorg/oauth2-server/provider"
    "github.com/myorg/oauth2-server/server"
    "github.com/myorg/oauth2-server/store"
)

func main() {
    log, _ := zap.NewProduction()
    defer log.Sync()

    issuer := os.Getenv("OAUTH2_ISSUER")
    if issuer == "" {
        issuer = "https://auth.example.com"
    }

    // Connect to PostgreSQL
    db, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatal("connecting to database", zap.Error(err))
    }
    defer db.Close()

    // Initialize storage
    stores := store.New(db, log)

    // Load/generate JWT keys
    keySet, err := keys.LoadOrGenerateKeys(
        os.Getenv("RSA_KEY_PATH"),
        os.Getenv("EC_KEY_PATH"),
    )
    if err != nil {
        log.Fatal("loading keys", zap.Error(err))
    }

    // Build fosite provider
    config := provider.OAuthConfig(issuer)
    oauth2Provider := provider.BuildOAuth2Provider(stores, keySet, config, log)

    // Build HTTP server
    srv := server.New(oauth2Provider, stores, keySet, log)

    r := mux.NewRouter()

    // OpenID Connect Discovery
    r.HandleFunc("/.well-known/openid-configuration", srv.DiscoveryEndpoint(issuer))
    r.HandleFunc("/.well-known/jwks.json", srv.JWKSEndpoint(keySet))

    // OAuth2 endpoints
    r.HandleFunc("/oauth2/auth", srv.AuthorizeEndpoint).Methods("GET", "POST")
    r.HandleFunc("/oauth2/token", srv.TokenEndpoint).Methods("POST")
    r.HandleFunc("/oauth2/introspect", srv.IntrospectEndpoint).Methods("POST")
    r.HandleFunc("/oauth2/revoke", srv.RevokeEndpoint).Methods("POST")

    // OpenID Connect UserInfo
    r.HandleFunc("/userinfo", srv.UserInfoEndpoint).Methods("GET", "POST")

    // Dynamic Client Registration (RFC 7591)
    r.HandleFunc("/connect/register", srv.RegisterClientEndpoint).Methods("POST")

    // Health endpoints
    r.HandleFunc("/health/live", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    r.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
        if err := db.Ping(r.Context()); err != nil {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
    })

    httpSrv := &http.Server{
        Addr:         ":8080",
        Handler:      r,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    // Graceful shutdown
    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    go func() {
        log.Info("OAuth2 server starting",
            zap.String("addr", httpSrv.Addr),
            zap.String("issuer", issuer))
        if err := httpSrv.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatal("server failed", zap.Error(err))
        }
    }()

    <-ctx.Done()

    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    if err := httpSrv.Shutdown(shutdownCtx); err != nil {
        log.Error("shutdown error", zap.Error(err))
    }

    log.Info("server stopped")
}
```

## Database Schema

```sql
-- migrations/001_create_tables.sql

CREATE TABLE oauth2_clients (
    id                          VARCHAR(255) PRIMARY KEY,
    hashed_secret               BYTEA,
    redirect_uris               TEXT[],
    grant_types                 TEXT[],
    response_types              TEXT[],
    scopes                      TEXT[],
    audience                    TEXT[],
    public                      BOOLEAN NOT NULL DEFAULT false,
    token_endpoint_auth_method  VARCHAR(50) DEFAULT 'client_secret_basic',
    metadata                    JSONB,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at                  TIMESTAMPTZ
);

CREATE INDEX idx_clients_deleted_at ON oauth2_clients (deleted_at) WHERE deleted_at IS NULL;

CREATE TABLE oauth2_tokens (
    id              BIGSERIAL PRIMARY KEY,
    token_type      VARCHAR(20) NOT NULL,   -- auth_code, access_token, refresh_token
    signature       VARCHAR(255) NOT NULL,
    request_id      VARCHAR(255) NOT NULL,
    client_id       VARCHAR(255) NOT NULL REFERENCES oauth2_clients(id),
    subject         VARCHAR(255),
    scopes          TEXT[],
    session_data    BYTEA NOT NULL,
    request_data    BYTEA NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,           -- For auth codes (single-use)
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_tokens_type_sig ON oauth2_tokens (token_type, signature);
CREATE INDEX idx_tokens_request_id ON oauth2_tokens (request_id);
CREATE INDEX idx_tokens_client_id ON oauth2_tokens (client_id);
CREATE INDEX idx_tokens_expires ON oauth2_tokens (expires_at) WHERE revoked_at IS NULL;

-- Cleanup job for expired tokens
CREATE OR REPLACE FUNCTION cleanup_expired_tokens() RETURNS void AS $$
BEGIN
    DELETE FROM oauth2_tokens
    WHERE expires_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Token cleanup CronJob (pg_cron extension)
SELECT cron.schedule('cleanup-tokens', '0 3 * * *', 'SELECT cleanup_expired_tokens()');
```

## Testing

```go
// integration_test.go
package integration_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "net/url"
    "strings"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestAuthorizationCodeFlow(t *testing.T) {
    srv := setupTestServer(t)
    defer srv.Close()

    // Step 1: Generate PKCE
    verifier, challenge, err := pkce.GeneratePKCEPair()
    require.NoError(t, err)

    // Step 2: Authorization request
    authURL := srv.URL + "/oauth2/auth?" + url.Values{
        "client_id":             {"test-client"},
        "redirect_uri":          {srv.URL + "/callback"},
        "response_type":         {"code"},
        "scope":                 {"openid profile"},
        "state":                 {"random-state"},
        "code_challenge":        {challenge},
        "code_challenge_method": {"S256"},
    }.Encode()

    // Simulate user authentication and consent
    resp, err := http.Get(authURL)
    require.NoError(t, err)
    defer resp.Body.Close()

    // Should redirect with code
    redirectURL, err := url.Parse(resp.Header.Get("Location"))
    require.NoError(t, err)
    code := redirectURL.Query().Get("code")
    require.NotEmpty(t, code)
    assert.Equal(t, "random-state", redirectURL.Query().Get("state"))

    // Step 3: Exchange code for token
    tokenResp, err := http.PostForm(srv.URL+"/oauth2/token", url.Values{
        "grant_type":    {"authorization_code"},
        "client_id":     {"test-client"},
        "code":          {code},
        "redirect_uri":  {srv.URL + "/callback"},
        "code_verifier": {verifier},
    })
    require.NoError(t, err)
    defer tokenResp.Body.Close()

    assert.Equal(t, http.StatusOK, tokenResp.StatusCode)

    var tokenData map[string]interface{}
    json.NewDecoder(tokenResp.Body).Decode(&tokenData)

    assert.NotEmpty(t, tokenData["access_token"])
    assert.Equal(t, "Bearer", tokenData["token_type"])
    assert.NotEmpty(t, tokenData["id_token"])

    // Step 4: Verify token introspection
    introspectResp, err := http.PostForm(srv.URL+"/oauth2/introspect", url.Values{
        "token": {tokenData["access_token"].(string)},
    })
    require.NoError(t, err)

    var introspectData map[string]interface{}
    json.NewDecoder(introspectResp.Body).Decode(&introspectData)

    assert.Equal(t, true, introspectData["active"])
    assert.Equal(t, "test-user", introspectData["sub"])
}
```

## Summary

Building an OAuth2 authorization server with fosite gives you a production-grade implementation with correct handling of all the security-critical edge cases. The key implementation points covered in this post are:

- **fosite compose API**: Use `compose.Compose()` to assemble a provider with exactly the grant types and handlers you need
- **PKCE enforcement**: Set `EnforcePKCE: true` and `EnforcePKCEForPublicClients: true`; only allow S256 challenge method
- **JWT strategy**: Use RSA-4096 or ECDSA-P256 for signing; publish a JWKS endpoint so resource servers can verify tokens without calling your server
- **Token introspection**: Implement the RFC 7662 endpoint for opaque tokens; resource servers call it to validate access tokens
- **Storage interface**: fosite requires a complete storage implementation; use PostgreSQL with proper indexes for production; the in-memory store is only for development
- **Graceful shutdown**: Store all state in PostgreSQL so server restarts don't invalidate tokens
- **Dynamic registration**: RFC 7591 allows clients to register programmatically, reducing operational overhead
- **Discovery document**: The `/.well-known/openid-configuration` endpoint allows clients to auto-configure

Never implement OAuth2 from scratch. fosite has been through extensive security audits and handles dozens of edge cases in the RFC that are easy to miss.
