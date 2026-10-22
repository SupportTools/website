// Package gsc reads Google Search Console search analytics with a service
// account that is a Restricted (read-only) user on the property.
package gsc

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const scope = "https://www.googleapis.com/auth/webmasters.readonly"

// TokenSource mints OAuth access tokens from a service-account JSON key with the
// JWT bearer grant, and reuses each token until 60 s before it expires.
type TokenSource struct {
	email    string
	key      *rsa.PrivateKey
	tokenURL string
	now      func() time.Time
	HTTP     *http.Client

	mu      sync.Mutex
	token   string
	expires time.Time
}

// NewTokenSource parses a service-account key (the JSON Google downloads).
func NewTokenSource(keyJSON []byte, tokenURL string, now func() time.Time) (*TokenSource, error) {
	var k struct {
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
	}
	if err := json.Unmarshal(keyJSON, &k); err != nil {
		return nil, fmt.Errorf("gsc key: %w", err)
	}
	block, _ := pem.Decode([]byte(k.PrivateKey))
	if block == nil || k.ClientEmail == "" {
		return nil, errors.New("gsc key: missing client_email or PEM private_key")
	}
	var rk *rsa.PrivateKey
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		var ok bool
		if rk, ok = parsed.(*rsa.PrivateKey); !ok {
			return nil, errors.New("gsc key: not an RSA key")
		}
	} else if rk, err = x509.ParsePKCS1PrivateKey(block.Bytes); err != nil {
		return nil, fmt.Errorf("gsc key: %w", err)
	}
	return &TokenSource{email: k.ClientEmail, key: rk, tokenURL: tokenURL, now: now, HTTP: http.DefaultClient}, nil
}

// Token returns a cached access token, minting a new one when it is within
// 60 s of expiry.
func (ts *TokenSource) Token(ctx context.Context) (string, error) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	now := ts.now()
	if ts.token != "" && now.Before(ts.expires.Add(-60*time.Second)) {
		return ts.token, nil
	}
	assertion, err := ts.assertion(now)
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ts.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := ts.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("gsc token: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("gsc token: HTTP %d: %.200s", resp.StatusCode, raw)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return "", fmt.Errorf("gsc token: bad response")
	}
	ts.token, ts.expires = out.AccessToken, now.Add(time.Duration(out.ExpiresIn)*time.Second)
	return ts.token, nil
}

// assertion builds the RS256-signed JWT for the token request.
func (ts *TokenSource) assertion(now time.Time) (string, error) {
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"iss": ts.email, "scope": scope, "aud": ts.tokenURL,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	unsigned := header + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(unsigned))
	sig, err := rsa.SignPKCS1v15(rand.Reader, ts.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("gsc token: sign: %w", err)
	}
	return unsigned + "." + enc.EncodeToString(sig), nil
}
