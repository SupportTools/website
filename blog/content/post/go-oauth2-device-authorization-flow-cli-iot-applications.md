---
title: "Go: Implementing OAuth2 Device Authorization Flow for CLI and IoT Applications"
date: 2031-07-22T00:00:00-05:00
draft: false
tags: ["Go", "OAuth2", "Device Flow", "CLI", "IoT", "Authentication", "Security"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to implementing the OAuth2 Device Authorization Grant (RFC 8628) in Go for CLI tools and IoT devices that cannot open a browser, including token refresh, PKCE considerations, and integration with major identity providers."
more_link: "yes"
url: "/go-oauth2-device-authorization-flow-cli-iot-applications/"
---

CLI tools and IoT devices face a fundamental problem with OAuth2: the standard Authorization Code flow assumes the user can open a browser on the same device they're authenticating from. A headless Raspberry Pi, a server-side CLI tool, or an embedded device running a Go binary cannot do this. The Device Authorization Grant (RFC 8628) solves this elegantly — the device displays a short code and a URL, the user authenticates on any capable device, and the CLI or IoT device polls until authentication completes. This guide builds a complete, production-ready implementation in Go.

<!--more-->

# Go: Implementing OAuth2 Device Authorization Flow for CLI and IoT Applications

## Understanding the Device Authorization Flow

The RFC 8628 Device Authorization Grant works as follows:

```
Device/CLI                    Authorization Server           User's Phone/Browser
─────────                    ────────────────────           ────────────────────
  │                                   │                              │
  │  POST /device_authorization       │                              │
  │  (client_id, scope)               │                              │
  │──────────────────────────────────▶│                              │
  │                                   │                              │
  │  {device_code, user_code,         │                              │
  │   verification_uri,               │                              │
  │   expires_in, interval}           │                              │
  │◀──────────────────────────────────│                              │
  │                                   │                              │
  │  Display: "Visit example.com/activate"                           │
  │  Display: "Enter code: WDJB-MJHT"                               │
  │                                   │                              │
  │  [poll every interval seconds]    │                              │
  │  POST /token                      │                              │
  │  (device_code, grant_type)        │                              │
  │──────────────────────────────────▶│                              │
  │                                   │                              │
  │  {error: authorization_pending}   │   User visits URL,           │
  │◀──────────────────────────────────│   enters user_code           │
  │                                   │◀─────────────────────────────│
  │  [continues polling]              │                              │
  │                                   │   User approves scopes       │
  │                                   │◀─────────────────────────────│
  │  POST /token (device_code)        │                              │
  │──────────────────────────────────▶│                              │
  │                                   │                              │
  │  {access_token, refresh_token,    │                              │
  │   expires_in, token_type}         │                              │
  │◀──────────────────────────────────│                              │
```

The key properties that make this flow suitable for constrained clients:
- The device never handles user credentials
- No redirect URI is required
- Works in headless environments
- Short codes (WDJB-MJHT style) are easy for users to type on a phone
- Polling is bounded by `expires_in` and `interval` from the server

## Project Structure

```
device-auth/
├── cmd/
│   └── mycli/
│       └── main.go
├── pkg/
│   └── auth/
│       ├── device.go        # Device authorization flow
│       ├── token.go         # Token storage and refresh
│       ├── providers.go     # Provider configurations
│       └── token_test.go
├── go.mod
└── go.sum
```

## Core Implementation

### Provider Configuration

Different identity providers implement the device flow with slightly different endpoint paths and behaviors. Define a provider abstraction:

```go
// pkg/auth/providers.go
package auth

import (
	"fmt"
	"net/url"
)

// ProviderConfig holds the OAuth2 provider endpoints and metadata.
type ProviderConfig struct {
	// Name is a human-readable identifier for the provider.
	Name string

	// DeviceAuthorizationEndpoint is the URL for device authorization requests.
	DeviceAuthorizationEndpoint string

	// TokenEndpoint is the URL for token exchange requests.
	TokenEndpoint string

	// ClientID is the public OAuth2 client identifier.
	// For public clients (CLIs, devices), there is no client secret.
	ClientID string

	// Scopes is the list of OAuth2 scopes to request.
	Scopes []string

	// AdditionalParams are extra parameters added to the device auth request.
	// Some providers require tenant IDs, resource URIs, etc.
	AdditionalParams url.Values
}

// Predefined provider configurations. Users should configure ClientID.

// GitHubProvider returns a ProviderConfig for GitHub OAuth Apps.
func GitHubProvider(clientID string) ProviderConfig {
	return ProviderConfig{
		Name:                        "GitHub",
		DeviceAuthorizationEndpoint: "https://github.com/login/device/code",
		TokenEndpoint:               "https://github.com/login/oauth/access_token",
		ClientID:                    clientID,
		Scopes:                      []string{"repo", "read:org"},
	}
}

// MicrosoftProvider returns a ProviderConfig for Azure AD / Entra ID.
func MicrosoftProvider(clientID, tenantID string) ProviderConfig {
	return ProviderConfig{
		Name: "Microsoft",
		DeviceAuthorizationEndpoint: fmt.Sprintf(
			"https://login.microsoftonline.com/%s/oauth2/v2.0/devicecode", tenantID),
		TokenEndpoint: fmt.Sprintf(
			"https://login.microsoftonline.com/%s/oauth2/v2.0/token", tenantID),
		ClientID: clientID,
		Scopes:   []string{"openid", "profile", "email", "offline_access"},
	}
}

// GoogleProvider returns a ProviderConfig for Google OAuth2.
func GoogleProvider(clientID string) ProviderConfig {
	return ProviderConfig{
		Name:                        "Google",
		DeviceAuthorizationEndpoint: "https://oauth2.googleapis.com/device/code",
		TokenEndpoint:               "https://oauth2.googleapis.com/token",
		ClientID:                    clientID,
		Scopes:                      []string{"openid", "email", "profile"},
	}
}

// KeycloakProvider returns a ProviderConfig for a Keycloak realm.
func KeycloakProvider(baseURL, realm, clientID string) ProviderConfig {
	return ProviderConfig{
		Name: "Keycloak",
		DeviceAuthorizationEndpoint: fmt.Sprintf(
			"%s/realms/%s/protocol/openid-connect/auth/device", baseURL, realm),
		TokenEndpoint: fmt.Sprintf(
			"%s/realms/%s/protocol/openid-connect/token", baseURL, realm),
		ClientID: clientID,
		Scopes:   []string{"openid", "profile", "email", "offline_access"},
	}
}
```

### Device Authorization Flow

```go
// pkg/auth/device.go
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DeviceAuthResponse is the response from the device authorization endpoint.
type DeviceAuthResponse struct {
	// DeviceCode is the opaque device code, sent in polling requests.
	DeviceCode string `json:"device_code"`

	// UserCode is the short, human-readable code shown to the user.
	UserCode string `json:"user_code"`

	// VerificationURI is where the user should navigate to enter the code.
	VerificationURI string `json:"verification_uri"`

	// VerificationURIComplete is the verification URI with the code pre-filled
	// (e.g., for QR code display).
	VerificationURIComplete string `json:"verification_uri_complete"`

	// ExpiresIn is the number of seconds the device code is valid.
	ExpiresIn int `json:"expires_in"`

	// Interval is the minimum polling interval in seconds.
	// The client MUST wait at least this long between token requests.
	Interval int `json:"interval"`
}

// TokenResponse is the OAuth2 token response.
type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token,omitempty"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
}

// tokenErrorResponse is the error body from the token endpoint.
type tokenErrorResponse struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// Sentinel errors for polling control flow.
var (
	// ErrAuthorizationPending means the user hasn't approved yet.
	// The caller should continue polling.
	ErrAuthorizationPending = errors.New("authorization_pending")

	// ErrSlowDown means the polling interval should be increased.
	ErrSlowDown = errors.New("slow_down")

	// ErrAccessDenied means the user explicitly denied the authorization request.
	ErrAccessDenied = errors.New("access_denied")

	// ErrExpiredToken means the device code has expired.
	ErrExpiredToken = errors.New("expired_token")
)

// DeviceFlow implements the OAuth2 Device Authorization Grant (RFC 8628).
type DeviceFlow struct {
	provider   ProviderConfig
	httpClient *http.Client
}

// NewDeviceFlow creates a new DeviceFlow client.
func NewDeviceFlow(provider ProviderConfig) *DeviceFlow {
	return &DeviceFlow{
		provider: provider,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Authorize initiates the device authorization request.
// Returns the DeviceAuthResponse which contains the user code and verification URI.
func (d *DeviceFlow) Authorize(ctx context.Context) (*DeviceAuthResponse, error) {
	params := url.Values{
		"client_id": {d.provider.ClientID},
		"scope":     {strings.Join(d.provider.Scopes, " ")},
	}

	// Merge additional provider-specific parameters
	for k, v := range d.provider.AdditionalParams {
		params[k] = v
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		d.provider.DeviceAuthorizationEndpoint,
		strings.NewReader(params.Encode()),
	)
	if err != nil {
		return nil, fmt.Errorf("create device auth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("device auth request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read device auth response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("device auth endpoint returned %d: %s",
			resp.StatusCode, string(body))
	}

	// Some providers (notably GitHub) return form-encoded responses
	// rather than JSON even when Accept: application/json is set.
	// Try JSON first, fall back to form encoding.
	var authResp DeviceAuthResponse
	if err := json.Unmarshal(body, &authResp); err != nil {
		// Try URL-encoded format (GitHub legacy behavior)
		values, parseErr := url.ParseQuery(string(body))
		if parseErr != nil {
			return nil, fmt.Errorf("parse device auth response: %w", err)
		}
		authResp.DeviceCode = values.Get("device_code")
		authResp.UserCode = values.Get("user_code")
		authResp.VerificationURI = values.Get("verification_uri")
		authResp.VerificationURIComplete = values.Get("verification_uri_complete")
		if v := values.Get("expires_in"); v != "" {
			fmt.Sscan(v, &authResp.ExpiresIn)
		}
		if v := values.Get("interval"); v != "" {
			fmt.Sscan(v, &authResp.Interval)
		}
	}

	if authResp.DeviceCode == "" {
		return nil, errors.New("device authorization response missing device_code")
	}
	if authResp.UserCode == "" {
		return nil, errors.New("device authorization response missing user_code")
	}

	// Default interval per RFC 8628
	if authResp.Interval == 0 {
		authResp.Interval = 5
	}

	return &authResp, nil
}

// PollForToken polls the token endpoint until the user approves the request,
// the device code expires, or the context is cancelled.
//
// The poll interval respects the server's specified interval and implements
// the slow_down backoff as required by RFC 8628.
func (d *DeviceFlow) PollForToken(
	ctx context.Context,
	deviceCode string,
	interval time.Duration,
	expiry time.Time,
) (*TokenResponse, error) {
	params := url.Values{
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		"device_code": {deviceCode},
		"client_id":   {d.provider.ClientID},
	}

	currentInterval := interval

	for {
		// Check if device code has expired
		if time.Now().After(expiry) {
			return nil, ErrExpiredToken
		}

		// Wait for the polling interval before the next request
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(currentInterval):
		}

		token, err := d.pollOnce(ctx, params)
		if err == nil {
			return token, nil
		}

		switch {
		case errors.Is(err, ErrAuthorizationPending):
			// Normal state — user hasn't approved yet, continue polling
			continue

		case errors.Is(err, ErrSlowDown):
			// Server is asking us to back off — increase interval by 5s
			currentInterval += 5 * time.Second
			continue

		case errors.Is(err, ErrAccessDenied):
			return nil, fmt.Errorf("user denied authorization: %w", err)

		case errors.Is(err, ErrExpiredToken):
			return nil, fmt.Errorf("device code expired: %w", err)

		default:
			return nil, err
		}
	}
}

func (d *DeviceFlow) pollOnce(ctx context.Context, params url.Values) (*TokenResponse, error) {
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		d.provider.TokenEndpoint,
		strings.NewReader(params.Encode()),
	)
	if err != nil {
		return nil, fmt.Errorf("create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read token response: %w", err)
	}

	// Try to parse as error first
	var errResp tokenErrorResponse
	if resp.StatusCode != http.StatusOK {
		if err := json.Unmarshal(body, &errResp); err != nil {
			// Try form-encoded
			values, _ := url.ParseQuery(string(body))
			errResp.Error = values.Get("error")
			errResp.ErrorDescription = values.Get("error_description")
		}

		switch errResp.Error {
		case "authorization_pending":
			return nil, ErrAuthorizationPending
		case "slow_down":
			return nil, ErrSlowDown
		case "access_denied":
			return nil, ErrAccessDenied
		case "expired_token":
			return nil, ErrExpiredToken
		default:
			return nil, fmt.Errorf("token endpoint error %q: %s",
				errResp.Error, errResp.ErrorDescription)
		}
	}

	var tokenResp TokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		// Try form-encoded (GitHub)
		values, parseErr := url.ParseQuery(string(body))
		if parseErr != nil {
			return nil, fmt.Errorf("parse token response: %w", err)
		}
		if errVal := values.Get("error"); errVal != "" {
			return nil, fmt.Errorf("token error: %s - %s",
				errVal, values.Get("error_description"))
		}
		tokenResp.AccessToken = values.Get("access_token")
		tokenResp.RefreshToken = values.Get("refresh_token")
		tokenResp.TokenType = values.Get("token_type")
		tokenResp.Scope = values.Get("scope")
	}

	if tokenResp.AccessToken == "" {
		return nil, errors.New("token response missing access_token")
	}

	return &tokenResp, nil
}
```

### Token Storage and Refresh

```go
// pkg/auth/token.go
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// StoredToken contains both the OAuth2 tokens and metadata for refresh.
type StoredToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	IDToken      string    `json:"id_token,omitempty"`
	TokenType    string    `json:"token_type"`
	ExpiresAt    time.Time `json:"expires_at"`
	Scopes       []string  `json:"scopes"`
	Provider     string    `json:"provider"`
}

// IsExpired returns true if the access token has expired or will expire
// within the given grace period.
func (t *StoredToken) IsExpired(grace time.Duration) bool {
	return time.Now().After(t.ExpiresAt.Add(-grace))
}

// TokenStore persists tokens to disk in the user's config directory.
type TokenStore struct {
	path string
	mu   sync.RWMutex
}

// NewTokenStore creates a TokenStore that persists to the default config directory.
func NewTokenStore(appName string) (*TokenStore, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("get config dir: %w", err)
	}

	dir := filepath.Join(configDir, appName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create config dir: %w", err)
	}

	path := filepath.Join(dir, "credentials.json")
	return &TokenStore{path: path}, nil
}

// Save writes the token to disk with restrictive permissions.
func (s *TokenStore) Save(token *StoredToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.MarshalIndent(token, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal token: %w", err)
	}

	// Write with owner-only permissions (0600)
	if err := os.WriteFile(s.path, data, 0600); err != nil {
		return fmt.Errorf("write token file: %w", err)
	}

	return nil
}

// Load reads the stored token from disk.
func (s *TokenStore) Load() (*StoredToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read token file: %w", err)
	}

	var token StoredToken
	if err := json.Unmarshal(data, &token); err != nil {
		return nil, fmt.Errorf("parse token file: %w", err)
	}

	return &token, nil
}

// Delete removes the stored token (logout).
func (s *TokenStore) Delete() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove token file: %w", err)
	}
	return nil
}

// TokenManager handles token lifecycle including refresh.
type TokenManager struct {
	provider   ProviderConfig
	store      *TokenStore
	httpClient *http.Client
	mu         sync.Mutex
}

// NewTokenManager creates a TokenManager for the given provider.
func NewTokenManager(provider ProviderConfig, store *TokenStore) *TokenManager {
	return &TokenManager{
		provider: provider,
		store:    store,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// GetValidToken returns a valid access token, refreshing if necessary.
// This is the primary method callers should use.
func (m *TokenManager) GetValidToken(ctx context.Context) (*StoredToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	token, err := m.store.Load()
	if err != nil {
		return nil, fmt.Errorf("load token: %w", err)
	}
	if token == nil {
		return nil, errors.New("not authenticated: run 'login' first")
	}

	// Return if token is still valid (with 5-minute grace period)
	if !token.IsExpired(5 * time.Minute) {
		return token, nil
	}

	// Attempt to refresh
	if token.RefreshToken == "" {
		return nil, errors.New("access token expired and no refresh token available: re-authenticate")
	}

	refreshed, err := m.refreshToken(ctx, token.RefreshToken)
	if err != nil {
		return nil, fmt.Errorf("refresh token: %w", err)
	}

	if err := m.store.Save(refreshed); err != nil {
		return nil, fmt.Errorf("save refreshed token: %w", err)
	}

	return refreshed, nil
}

func (m *TokenManager) refreshToken(ctx context.Context, refreshToken string) (*StoredToken, error) {
	params := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {m.provider.ClientID},
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		m.provider.TokenEndpoint,
		strings.NewReader(params.Encode()),
	)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var tokenResp TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, fmt.Errorf("decode refresh response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("refresh failed with status %d", resp.StatusCode)
	}

	if tokenResp.AccessToken == "" {
		return nil, errors.New("refresh response missing access_token")
	}

	expiry := time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	if tokenResp.ExpiresIn == 0 {
		expiry = time.Now().Add(1 * time.Hour)
	}

	// Preserve old refresh token if none returned
	if tokenResp.RefreshToken == "" {
		tokenResp.RefreshToken = refreshToken
	}

	return &StoredToken{
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		IDToken:      tokenResp.IDToken,
		TokenType:    tokenResp.TokenType,
		ExpiresAt:    expiry,
		Provider:     m.provider.Name,
		Scopes:       m.provider.Scopes,
	}, nil
}

// SaveFromResponse converts a TokenResponse and saves it.
func (m *TokenManager) SaveFromResponse(resp *TokenResponse) error {
	expiry := time.Now().Add(time.Duration(resp.ExpiresIn) * time.Second)
	if resp.ExpiresIn == 0 {
		expiry = time.Now().Add(1 * time.Hour)
	}

	token := &StoredToken{
		AccessToken:  resp.AccessToken,
		RefreshToken: resp.RefreshToken,
		IDToken:      resp.IDToken,
		TokenType:    resp.TokenType,
		ExpiresAt:    expiry,
		Provider:     m.provider.Name,
		Scopes:       m.provider.Scopes,
	}

	return m.store.Save(token)
}
```

### CLI Integration

```go
// cmd/mycli/main.go
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/yourorg/mycli/pkg/auth"
)

func main() {
	rootCmd := &cobra.Command{
		Use:   "mycli",
		Short: "An example CLI using OAuth2 Device Authorization Flow",
	}

	rootCmd.AddCommand(loginCmd())
	rootCmd.AddCommand(logoutCmd())
	rootCmd.AddCommand(statusCmd())
	rootCmd.AddCommand(whoamiCmd())

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func newProviderAndManager() (auth.ProviderConfig, *auth.TokenManager, error) {
	// Configure from environment or config file
	clientID := os.Getenv("MYCLI_CLIENT_ID")
	if clientID == "" {
		// Embedded default client ID for the CLI app
		clientID = "<your-public-client-id>"
	}

	provider := auth.KeycloakProvider(
		"https://auth.example.com",
		"myrealm",
		clientID,
	)

	store, err := auth.NewTokenStore("mycli")
	if err != nil {
		return auth.ProviderConfig{}, nil, fmt.Errorf("init token store: %w", err)
	}

	manager := auth.NewTokenManager(provider, store)
	return provider, manager, nil
}

func loginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Authenticate with the service",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := signal.NotifyContext(context.Background(),
				os.Interrupt, syscall.SIGTERM)
			defer cancel()

			provider, manager, err := newProviderAndManager()
			if err != nil {
				return err
			}

			flow := auth.NewDeviceFlow(provider)

			// Step 1: Initiate device authorization
			fmt.Fprintf(os.Stderr, "Initiating device authorization...\n")
			authResp, err := flow.Authorize(ctx)
			if err != nil {
				return fmt.Errorf("device authorization failed: %w", err)
			}

			// Step 2: Display instructions to the user
			fmt.Printf("\nTo authenticate, visit the following URL:\n\n")
			fmt.Printf("  %s\n\n", authResp.VerificationURI)
			fmt.Printf("Then enter the code:\n\n")
			fmt.Printf("  %s\n\n", authResp.UserCode)

			// If a complete URI is available (with code pre-filled), show it too
			if authResp.VerificationURIComplete != "" {
				fmt.Printf("Or visit this URL directly:\n\n")
				fmt.Printf("  %s\n\n", authResp.VerificationURIComplete)
			}

			expiresAt := time.Now().Add(time.Duration(authResp.ExpiresIn) * time.Second)
			fmt.Printf("This code expires in %d minutes.\n\n",
				authResp.ExpiresIn/60)

			fmt.Fprintf(os.Stderr, "Waiting for authentication...")

			// Step 3: Poll for the token
			interval := time.Duration(authResp.Interval) * time.Second
			tokenResp, err := flow.PollForToken(ctx, authResp.DeviceCode, interval, expiresAt)
			if err != nil {
				fmt.Fprintln(os.Stderr, " failed.")
				return fmt.Errorf("authentication failed: %w", err)
			}

			fmt.Fprintln(os.Stderr, " success!")

			// Step 4: Save the token
			if err := manager.SaveFromResponse(tokenResp); err != nil {
				return fmt.Errorf("save token: %w", err)
			}

			fmt.Println("Successfully authenticated.")
			return nil
		},
	}
}

func logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove stored credentials",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := auth.NewTokenStore("mycli")
			if err != nil {
				return err
			}
			if err := store.Delete(); err != nil {
				return fmt.Errorf("logout failed: %w", err)
			}
			fmt.Println("Logged out successfully.")
			return nil
		},
	}
}

func statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show authentication status",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := auth.NewTokenStore("mycli")
			if err != nil {
				return err
			}

			token, err := store.Load()
			if err != nil {
				return err
			}
			if token == nil {
				fmt.Println("Not authenticated. Run 'mycli login' to authenticate.")
				return nil
			}

			if token.IsExpired(0) {
				if token.RefreshToken != "" {
					fmt.Println("Authenticated (token expired, will auto-refresh on next use)")
				} else {
					fmt.Println("Authentication expired. Run 'mycli login' to re-authenticate.")
				}
			} else {
				fmt.Printf("Authenticated (expires %s)\n",
					token.ExpiresAt.Format(time.RFC3339))
			}
			return nil
		},
	}
}

func whoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show current user information",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := signal.NotifyContext(context.Background(),
				os.Interrupt, syscall.SIGTERM)
			defer cancel()

			_, manager, err := newProviderAndManager()
			if err != nil {
				return err
			}

			token, err := manager.GetValidToken(ctx)
			if err != nil {
				return fmt.Errorf("get token: %w", err)
			}

			// Use the token to call an API
			// This demonstrates how downstream commands use the token
			fmt.Printf("Provider: %s\n", token.Provider)
			fmt.Printf("Token type: %s\n", token.TokenType)
			fmt.Printf("Scopes: %v\n", token.Scopes)
			fmt.Printf("Expires at: %s\n", token.ExpiresAt.Format(time.RFC3339))
			return nil
		},
	}
}
```

## IoT Device Pattern

For IoT devices, the flow is similar but the output channel differs:

```go
// iot/device_auth.go - IoT-specific display patterns
package iot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/skip2/go-qrcode"
	"github.com/yourorg/mycli/pkg/auth"
)

// IoTDeviceLogin handles device authorization for headless IoT devices.
// Outputs the user code to a small display, LED indicator, or log file.
func IoTDeviceLogin(ctx context.Context, provider auth.ProviderConfig, outputPath string) (*auth.StoredToken, error) {
	flow := auth.NewDeviceFlow(provider)

	authResp, err := flow.Authorize(ctx)
	if err != nil {
		return nil, fmt.Errorf("initiate device auth: %w", err)
	}

	// Write the auth info to a JSON file for the device's display controller
	displayData := map[string]string{
		"user_code":        authResp.UserCode,
		"verification_uri": authResp.VerificationURI,
		"expires_in":       fmt.Sprintf("%d", authResp.ExpiresIn),
	}

	displayJSON, _ := json.MarshalIndent(displayData, "", "  ")
	if err := os.WriteFile(outputPath, displayJSON, 0644); err != nil {
		return nil, fmt.Errorf("write display data: %w", err)
	}

	// Generate QR code if a complete URI is available
	if authResp.VerificationURIComplete != "" {
		qrData, err := qrcode.Encode(authResp.VerificationURIComplete,
			qrcode.Medium, 256)
		if err == nil {
			os.WriteFile(outputPath+".qr.png", qrData, 0644)
		}
	}

	// Log to system journal/console
	fmt.Printf("[DEVICE AUTH] Visit: %s\n", authResp.VerificationURI)
	fmt.Printf("[DEVICE AUTH] Code: %s\n", authResp.UserCode)
	fmt.Printf("[DEVICE AUTH] Expires in: %ds\n", authResp.ExpiresIn)

	expiresAt := time.Now().Add(time.Duration(authResp.ExpiresIn) * time.Second)
	interval := time.Duration(authResp.Interval) * time.Second

	tokenResp, err := flow.PollForToken(ctx, authResp.DeviceCode, interval, expiresAt)
	if err != nil {
		return nil, fmt.Errorf("poll for token: %w", err)
	}

	expiry := time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	return &auth.StoredToken{
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		ExpiresAt:    expiry,
		Provider:     provider.Name,
		Scopes:       provider.Scopes,
	}, nil
}
```

## Testing

```go
// pkg/auth/device_test.go
package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/yourorg/mycli/pkg/auth"
)

func TestDeviceFlow_Authorize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "application/x-www-form-urlencoded", r.Header.Get("Content-Type"))

		r.ParseForm()
		assert.Equal(t, "test-client-id", r.Form.Get("client_id"))

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(auth.DeviceAuthResponse{
			DeviceCode:      "device-code-abc123",
			UserCode:        "WDJB-MJHT",
			VerificationURI: server.URL + "/activate",
			ExpiresIn:       1800,
			Interval:        5,
		})
	}))
	defer server.Close()

	provider := auth.ProviderConfig{
		Name:                        "Test",
		DeviceAuthorizationEndpoint: server.URL + "/device/code",
		TokenEndpoint:               server.URL + "/token",
		ClientID:                    "test-client-id",
		Scopes:                      []string{"openid"},
	}

	flow := auth.NewDeviceFlow(provider)
	resp, err := flow.Authorize(context.Background())

	require.NoError(t, err)
	assert.Equal(t, "device-code-abc123", resp.DeviceCode)
	assert.Equal(t, "WDJB-MJHT", resp.UserCode)
	assert.Equal(t, 1800, resp.ExpiresIn)
	assert.Equal(t, 5, resp.Interval)
}

func TestDeviceFlow_PollForToken_EventualSuccess(t *testing.T) {
	callCount := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")

		if callCount < 3 {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "authorization_pending",
			})
			return
		}

		json.NewEncoder(w).Encode(auth.TokenResponse{
			AccessToken:  "access-token-xyz",
			RefreshToken: "refresh-token-abc",
			TokenType:    "Bearer",
			ExpiresIn:    3600,
		})
	}))
	defer server.Close()

	provider := auth.ProviderConfig{
		Name:          "Test",
		TokenEndpoint: server.URL + "/token",
		ClientID:      "test-client-id",
	}

	flow := auth.NewDeviceFlow(provider)
	token, err := flow.PollForToken(
		context.Background(),
		"device-code",
		10*time.Millisecond, // Fast interval for testing
		time.Now().Add(1*time.Minute),
	)

	require.NoError(t, err)
	assert.Equal(t, "access-token-xyz", token.AccessToken)
	assert.Equal(t, 3, callCount)
}
```

## Security Considerations

### Public Client Security

The device authorization flow is designed for public clients (no client secret). Key security properties:

- **Device code entropy**: Must be ≥128 bits; use `crypto/rand` for generation
- **User code entropy**: Must be ≥10 bits; short codes sacrifice entropy for usability
- **Short expiry**: Device codes should expire in ≤30 minutes; set `ExpiresIn` conservatively
- **Single use**: Device codes must be invalidated after use
- **Polling rate limiting**: Servers enforce the `interval`; clients must respect `slow_down`

### Token Storage Security

```go
// Verify token file permissions are correct
func verifyTokenFilePermissions(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}

	mode := info.Mode().Perm()
	if mode & 0o077 != 0 {
		return fmt.Errorf("token file %s has insecure permissions %o — should be 0600",
			path, mode)
	}
	return nil
}
```

For highly sensitive CLI tools, consider OS keychain integration:

```go
import "github.com/zalando/go-keyring"

func saveToKeyring(service, username, token string) error {
	return keyring.Set(service, username, token)
}

func loadFromKeyring(service, username string) (string, error) {
	return keyring.Get(service, username)
}
```

## Summary

The OAuth2 Device Authorization Grant is the correct pattern for any Go application that cannot open a browser on the authentication device. The implementation above provides:

- **Correct polling behavior** per RFC 8628, including `slow_down` backoff
- **Robust token storage** with restrictive file permissions
- **Automatic token refresh** with mutex protection against concurrent refresh races
- **Provider abstraction** supporting GitHub, Microsoft, Google, Keycloak, and any RFC 8628-compliant IdP
- **IoT adaptation** for headless devices with QR code generation

The key implementation detail to get right is the polling loop's error handling. Many implementations incorrectly retry on `access_denied` or `expired_token` — these are terminal errors that require re-initiating the entire flow, not just retrying the poll.
