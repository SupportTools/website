---
title: "Building Secure Go Applications with OAuth 2.0 and JWT"
date: 2027-03-16T09:00:00-05:00
draft: false
tags: ["golang", "oauth2", "jwt", "security", "authentication", "authorization", "web security"]
categories: ["Development", "Go", "Security"]
---

## Introduction

In today's web application landscape, security is non-negotiable. With 74% of data breaches resulting from human error or social engineering according to recent reports, implementing robust authentication and authorization mechanisms is essential. For Go applications, OAuth 2.0 and JSON Web Tokens (JWT) provide powerful tools to create secure, scalable, and modern authentication systems.

This guide will walk through implementing OAuth 2.0 and JWT in Go applications with practical code examples, best practices, and real-world deployment considerations. By the end, you'll have a comprehensive understanding of how to secure your Go applications using these industry-standard protocols.

## Understanding OAuth 2.0 and JWT

### OAuth 2.0: The Authorization Framework

OAuth 2.0 is an authorization framework that enables third-party applications to obtain limited access to a user's account on a server. It works by delegating user authentication to the service that hosts the user account and authorizing third-party applications to access that account.

Key components in OAuth 2.0:

1. **Resource Owner**: The user who owns the data (e.g., a Google account holder)
2. **Client**: The application requesting access to the user's data
3. **Authorization Server**: The server that authenticates the user and issues tokens
4. **Resource Server**: The server hosting the protected resources

### JWT: Secure Token Format

JSON Web Token (JWT) is a compact, self-contained means of representing claims securely between two parties. A JWT consists of three parts:

1. **Header**: Contains the token type and signing algorithm
2. **Payload**: Contains the claims (data) being transmitted
3. **Signature**: Verifies the token hasn't been tampered with

JWTs are often used as the token format within OAuth 2.0 flows, providing a standardized way to transmit user information and permissions.

## Implementing OAuth 2.0 in Go Applications

Let's start by implementing OAuth 2.0 in a Go application. We'll use Google as our OAuth provider since it's widely used.

### Step 1: Setting Up OAuth 2.0 Credentials

First, you need to set up credentials in the Google Developer Console:

1. Go to the [Google Developer Console](https://console.developers.google.com/)
2. Create a new project
3. Enable the Google+ API
4. Create OAuth 2.0 credentials (client ID and client secret)
5. Set authorized redirect URIs (e.g., `http://localhost:8080/callback`)

### Step 2: Implementing OAuth 2.0 Flow in Go

Now let's create a simple Go web server that implements the OAuth 2.0 flow:

```go
package main

import (
    "context"
    "crypto/rand"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "time"
    
    "github.com/gorilla/sessions"
    "golang.org/x/oauth2"
    "golang.org/x/oauth2/google"
)

// SessionStore for storing session data
var sessionStore = sessions.NewCookieStore([]byte(os.Getenv("SESSION_KEY")))

// OAuthConfig holds our OAuth configuration
var oauthConfig = &oauth2.Config{
    RedirectURL:  "http://localhost:8080/callback",
    ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
    ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
    Scopes:       []string{"https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"},
    Endpoint:     google.Endpoint,
}

func main() {
    // Initialize HTTP routes
    http.HandleFunc("/", handleHome)
    http.HandleFunc("/login", handleLogin)
    http.HandleFunc("/callback", handleCallback)
    http.HandleFunc("/profile", handleProfile)
    http.HandleFunc("/logout", handleLogout)
    
    // Start HTTP server
    log.Println("Server started at :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleHome(w http.ResponseWriter, r *http.Request) {
    session, _ := sessionStore.Get(r, "auth-session")
    
    // Check if user is authenticated
    if auth, ok := session.Values["authenticated"].(bool); !ok || !auth {
        fmt.Fprintf(w, `<html><body>
            <h1>Welcome</h1>
            <p>Please <a href="/login">log in</a> to continue.</p>
        </body></html>`)
        return
    }
    
    // User is authenticated, show profile link
    fmt.Fprintf(w, `<html><body>
        <h1>Welcome</h1>
        <p>You are logged in. View your <a href="/profile">profile</a>.</p>
        <p><a href="/logout">Logout</a></p>
    </body></html>`)
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
    // Generate random state
    b := make([]byte, 32)
    _, err := rand.Read(b)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    state := base64.StdEncoding.EncodeToString(b)
    
    // Store state in session
    session, _ := sessionStore.Get(r, "auth-session")
    session.Values["state"] = state
    err = session.Save(r, w)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    // Redirect to Google's OAuth 2.0 server
    url := oauthConfig.AuthCodeURL(state)
    http.Redirect(w, r, url, http.StatusTemporaryRedirect)
}

func handleCallback(w http.ResponseWriter, r *http.Request) {
    // Get the state from the session
    session, err := sessionStore.Get(r, "auth-session")
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    // Verify state parameter
    if r.FormValue("state") != session.Values["state"] {
        http.Error(w, "Invalid state parameter", http.StatusBadRequest)
        return
    }
    
    // Exchange the authorization code for a token
    token, err := oauthConfig.Exchange(context.Background(), r.FormValue("code"))
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    // Get user info
    client := oauthConfig.Client(context.Background(), token)
    resp, err := client.Get("https://www.googleapis.com/oauth2/v2/userinfo")
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    defer resp.Body.Close()
    
    userData, err := io.ReadAll(resp.Body)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    // Store user info and authentication status in session
    var userInfo map[string]interface{}
    if err := json.Unmarshal(userData, &userInfo); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    session.Values["userInfo"] = userInfo
    session.Values["authenticated"] = true
    session.Values["accessToken"] = token.AccessToken
    session.Values["tokenExpiry"] = token.Expiry
    
    // Save the session
    if err := session.Save(r, w); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    // Redirect to profile page
    http.Redirect(w, r, "/profile", http.StatusTemporaryRedirect)
}

func handleProfile(w http.ResponseWriter, r *http.Request) {
    session, err := sessionStore.Get(r, "auth-session")
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    // Check if user is authenticated
    if auth, ok := session.Values["authenticated"].(bool); !ok || !auth {
        http.Redirect(w, r, "/", http.StatusSeeOther)
        return
    }
    
    // Get user info from session
    userInfo, ok := session.Values["userInfo"].(map[string]interface{})
    if !ok {
        http.Error(w, "User info not found in session", http.StatusInternalServerError)
        return
    }
    
    // Display user info
    fmt.Fprintf(w, `<html><body>
        <h1>Profile</h1>
        <img src="%s" alt="Profile picture">
        <p>Name: %s</p>
        <p>Email: %s</p>
        <p><a href="/">Home</a></p>
        <p><a href="/logout">Logout</a></p>
    </body></html>`, 
    userInfo["picture"], userInfo["name"], userInfo["email"])
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
    session, err := sessionStore.Get(r, "auth-session")
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    // Revoke the access token (optional)
    if accessToken, ok := session.Values["accessToken"].(string); ok && accessToken != "" {
        revokeURL := fmt.Sprintf("https://accounts.google.com/o/oauth2/revoke?token=%s", accessToken)
        resp, err := http.Get(revokeURL)
        if err == nil {
            defer resp.Body.Close()
        }
    }
    
    // Clear session
    session.Values["authenticated"] = false
    delete(session.Values, "userInfo")
    delete(session.Values, "accessToken")
    delete(session.Values, "tokenExpiry")
    
    if err := session.Save(r, w); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    http.Redirect(w, r, "/", http.StatusSeeOther)
}
```

This simple implementation:

1. Provides routes for login, callback, profile, and logout
2. Uses the official Go OAuth2 library from Google
3. Implements the OAuth 2.0 authorization code flow
4. Stores user information and authentication status in a session
5. Revokes the token on logout

### Step 3: Security Considerations for OAuth 2.0

When implementing OAuth 2.0, be mindful of these security considerations:

1. **Always use HTTPS** in production
2. **Validate the `state` parameter** to prevent CSRF attacks
3. **Store sensitive values securely** (client secret, session keys)
4. **Implement proper error handling** to avoid leaking sensitive information
5. **Set appropriate token expiration** times

## Implementing JWT in Go Applications

Now, let's implement JWT authentication in a Go application. We'll create a simple API that issues and verifies JWTs.

### Step 1: Creating and Validating JWTs

First, let's create a package to handle JWT operations:

```go
// auth/jwt.go
package auth

import (
    "errors"
    "time"
    
    "github.com/golang-jwt/jwt/v5"
)

var (
    ErrInvalidToken = errors.New("invalid token")
    ErrExpiredToken = errors.New("token expired")
)

// Secret key used to sign tokens
var secretKey = []byte("your-secret-key") // In production, use environment variables

// CustomClaims extends standard JWT claims
type CustomClaims struct {
    UserID    string   `json:"user_id"`
    Email     string   `json:"email"`
    Role      string   `json:"role"`
    Permissions []string `json:"permissions"`
    jwt.RegisteredClaims
}

// GenerateToken creates a new JWT token for a user
func GenerateToken(userID, email, role string, permissions []string, duration time.Duration) (string, error) {
    // Create claims with user information
    claims := CustomClaims{
        UserID:    userID,
        Email:     email,
        Role:      role,
        Permissions: permissions,
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(duration)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
            NotBefore: jwt.NewNumericDate(time.Now()),
            Issuer:    "your-application",
            Subject:   userID,
        },
    }
    
    // Create token with claims
    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    
    // Sign the token with the secret key
    tokenString, err := token.SignedString(secretKey)
    if err != nil {
        return "", err
    }
    
    return tokenString, nil
}

// ValidateToken checks if a token is valid and returns its claims
func ValidateToken(tokenString string) (*CustomClaims, error) {
    // Parse the token
    token, err := jwt.ParseWithClaims(tokenString, &CustomClaims{}, func(token *jwt.Token) (interface{}, error) {
        // Validate the signing method
        if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, errors.New("unexpected signing method")
        }
        return secretKey, nil
    })
    
    if err != nil {
        if errors.Is(err, jwt.ErrTokenExpired) {
            return nil, ErrExpiredToken
        }
        return nil, err
    }
    
    // Check if the token is valid
    if !token.Valid {
        return nil, ErrInvalidToken
    }
    
    // Get claims from token
    claims, ok := token.Claims.(*CustomClaims)
    if !ok {
        return nil, ErrInvalidToken
    }
    
    return claims, nil
}
```

### Step 2: Creating a JWT-based API

Now, let's create a simple API that uses JWT for authentication:

```go
// main.go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "strings"
    "time"
    
    "github.com/yourusername/yourapp/auth"
)

// User represents the user for authentication purposes
type User struct {
    ID          string   `json:"id"`
    Email       string   `json:"email"`
    Password    string   `json:"password,omitempty"`
    Role        string   `json:"role"`
    Permissions []string `json:"permissions"`
}

// In a real application, these would come from a database
var users = map[string]User{
    "user@example.com": {
        ID:          "1",
        Email:       "user@example.com",
        Password:    "password123", // In production, store hashed passwords
        Role:        "user",
        Permissions: []string{"read"},
    },
    "admin@example.com": {
        ID:          "2",
        Email:       "admin@example.com",
        Password:    "admin123",
        Role:        "admin",
        Permissions: []string{"read", "write", "delete"},
    },
}

type LoginRequest struct {
    Email    string `json:"email"`
    Password string `json:"password"`
}

type LoginResponse struct {
    Token        string `json:"token"`
    RefreshToken string `json:"refresh_token"`
    ExpiresIn    int    `json:"expires_in"`
}

func main() {
    // Define routes
    http.HandleFunc("/login", handleLogin)
    http.HandleFunc("/refresh", handleRefresh)
    http.HandleFunc("/protected", authMiddleware(handleProtected))
    http.HandleFunc("/admin", authMiddleware(adminOnly(handleAdmin)))
    
    // Start server
    log.Println("Server started at :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
    // Only allow POST requests
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    
    // Parse request body
    var req LoginRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }
    
    // Check if user exists
    user, exists := users[req.Email]
    if !exists || user.Password != req.Password {
        http.Error(w, "Invalid credentials", http.StatusUnauthorized)
        return
    }
    
    // Generate access token (short-lived)
    accessToken, err := auth.GenerateToken(user.ID, user.Email, user.Role, user.Permissions, 15*time.Minute)
    if err != nil {
        http.Error(w, "Failed to generate token", http.StatusInternalServerError)
        return
    }
    
    // Generate refresh token (long-lived)
    refreshToken, err := auth.GenerateToken(user.ID, user.Email, user.Role, nil, 7*24*time.Hour)
    if err != nil {
        http.Error(w, "Failed to generate refresh token", http.StatusInternalServerError)
        return
    }
    
    // Respond with tokens
    resp := LoginResponse{
        Token:        accessToken,
        RefreshToken: refreshToken,
        ExpiresIn:    15 * 60, // 15 minutes in seconds
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

func handleRefresh(w http.ResponseWriter, r *http.Request) {
    // Only allow POST requests
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    
    // Get refresh token from Authorization header
    authHeader := r.Header.Get("Authorization")
    if authHeader == "" {
        http.Error(w, "Authorization header required", http.StatusUnauthorized)
        return
    }
    
    // Extract token from "Bearer <token>"
    parts := strings.Split(authHeader, " ")
    if len(parts) != 2 || parts[0] != "Bearer" {
        http.Error(w, "Invalid authorization header", http.StatusUnauthorized)
        return
    }
    refreshToken := parts[1]
    
    // Validate refresh token
    claims, err := auth.ValidateToken(refreshToken)
    if err != nil {
        http.Error(w, "Invalid refresh token", http.StatusUnauthorized)
        return
    }
    
    // Find user by ID to get the latest permissions
    var user User
    for _, u := range users {
        if u.ID == claims.UserID {
            user = u
            break
        }
    }
    
    // Generate new access token
    accessToken, err := auth.GenerateToken(user.ID, user.Email, user.Role, user.Permissions, 15*time.Minute)
    if err != nil {
        http.Error(w, "Failed to generate token", http.StatusInternalServerError)
        return
    }
    
    // Respond with new access token
    resp := LoginResponse{
        Token:        accessToken,
        RefreshToken: refreshToken, // Keep the same refresh token
        ExpiresIn:    15 * 60,      // 15 minutes in seconds
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Get token from Authorization header
        authHeader := r.Header.Get("Authorization")
        if authHeader == "" {
            http.Error(w, "Authorization header required", http.StatusUnauthorized)
            return
        }
        
        // Extract token from "Bearer <token>"
        parts := strings.Split(authHeader, " ")
        if len(parts) != 2 || parts[0] != "Bearer" {
            http.Error(w, "Invalid authorization header", http.StatusUnauthorized)
            return
        }
        tokenString := parts[1]
        
        // Validate token
        claims, err := auth.ValidateToken(tokenString)
        if err != nil {
            http.Error(w, "Invalid token: "+err.Error(), http.StatusUnauthorized)
            return
        }
        
        // Add claims to request context
        ctx := r.Context()
        ctx = context.WithValue(ctx, "claims", claims)
        r = r.WithContext(ctx)
        
        // Call the next handler
        next(w, r)
    }
}

func adminOnly(next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Get claims from context
        claims, ok := r.Context().Value("claims").(*auth.CustomClaims)
        if !ok {
            http.Error(w, "No authentication claims found", http.StatusInternalServerError)
            return
        }
        
        // Check if user is an admin
        if claims.Role != "admin" {
            http.Error(w, "Unauthorized: Admin access required", http.StatusForbidden)
            return
        }
        
        // Call the next handler
        next(w, r)
    }
}

func handleProtected(w http.ResponseWriter, r *http.Request) {
    // Get claims from context
    claims, ok := r.Context().Value("claims").(*auth.CustomClaims)
    if !ok {
        http.Error(w, "No authentication claims found", http.StatusInternalServerError)
        return
    }
    
    // Respond with user info
    response := map[string]interface{}{
        "message":     "This is a protected endpoint",
        "user_id":     claims.UserID,
        "email":       claims.Email,
        "role":        claims.Role,
        "permissions": claims.Permissions,
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

func handleAdmin(w http.ResponseWriter, r *http.Request) {
    // This endpoint is protected by the adminOnly middleware
    response := map[string]string{
        "message": "This is an admin endpoint",
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}
```

This implementation:

1. Provides endpoints for login, token refresh, and protected resources
2. Uses JWT for authentication and authorization
3. Implements role-based access control
4. Uses middleware to check for valid tokens and roles

### Step 3: Best Practices for JWT Security

When implementing JWT authentication, follow these best practices:

1. **Use a Strong Secret Key**: In production, use a strong, randomly generated key stored securely
2. **Set Short Expiration Times**: Access tokens should expire quickly (15-30 minutes)
3. **Implement Token Refresh**: Use refresh tokens for obtaining new access tokens without re-authentication
4. **Include Only Necessary Claims**: Keep tokens small by including only required information
5. **Validate Tokens Properly**: Check signature, expiration, and issuer
6. **Store Tokens Securely**: Client-side tokens should be in HttpOnly cookies or secure storage
7. **Implement Token Revocation**: Have a strategy for invalidating tokens when needed

## Integrating OAuth 2.0 and JWT

In many applications, it makes sense to combine OAuth 2.0 and JWT for a comprehensive authentication and authorization solution.

### Approach 1: OAuth 2.0 for Authentication, JWT for API Access

In this approach:

1. Use OAuth 2.0 for user authentication (login)
2. After successful authentication, generate a JWT with user claims
3. Use the JWT for subsequent API requests

Here's how this might look in a Go application:

```go
func handleOAuthCallback(w http.ResponseWriter, r *http.Request) {
    // ... OAuth 2.0 callback logic (as shown earlier)
    
    // After successful OAuth authentication, generate a JWT
    userInfo := getUserInfoFromOAuth(token)
    
    jwtToken, err := auth.GenerateToken(
        userInfo.ID,
        userInfo.Email,
        userInfo.Role,
        userInfo.Permissions,
        15*time.Minute,
    )
    
    if err != nil {
        http.Error(w, "Failed to generate token", http.StatusInternalServerError)
        return
    }
    
    // Return the JWT to the client (in a secure cookie or response)
    http.SetCookie(w, &http.Cookie{
        Name:     "access_token",
        Value:    jwtToken,
        Path:     "/",
        HttpOnly: true,
        Secure:   true, // For HTTPS
        SameSite: http.SameSiteStrictMode,
        MaxAge:   15 * 60, // 15 minutes
    })
    
    // Redirect to the application
    http.Redirect(w, r, "/app", http.StatusTemporaryRedirect)
}
```

### Approach 2: Using JWT as OAuth 2.0 Access Tokens

OAuth 2.0 doesn't specify a format for access tokens, so you can use JWTs as OAuth 2.0 access tokens. This approach gives you the benefits of both:

1. Standard OAuth 2.0 flows for authentication
2. Self-contained, verifiable JWTs for API access

Here's a simplified implementation:

```go
func handleTokenEndpoint(w http.ResponseWriter, r *http.Request) {
    // Validate OAuth 2.0 token request (grant type, client credentials, etc.)
    // ...
    
    // After validation, generate a JWT as the access token
    accessToken, err := auth.GenerateToken(
        userID,
        email,
        role,
        permissions,
        time.Hour,
    )
    
    if err != nil {
        http.Error(w, "Failed to generate token", http.StatusInternalServerError)
        return
    }
    
    // Generate refresh token
    refreshToken, err := auth.GenerateToken(
        userID,
        email,
        role,
        nil,
        7*24*time.Hour,
    )
    
    if err != nil {
        http.Error(w, "Failed to generate refresh token", http.StatusInternalServerError)
        return
    }
    
    // Respond with OAuth 2.0 token response format
    response := map[string]interface{}{
        "access_token":  accessToken,
        "token_type":    "Bearer",
        "expires_in":    3600,
        "refresh_token": refreshToken,
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}
```

## Advanced Security Considerations

### 1. Using Public Key Infrastructure (PKI) for JWT Signing

Instead of using a shared secret for JWT signing, you can use asymmetric keys:

```go
package auth

import (
    "crypto/rsa"
    "errors"
    "io/ioutil"
    "time"
    
    "github.com/golang-jwt/jwt/v5"
)

// Load RSA keys
var (
    privateKey *rsa.PrivateKey
    publicKey  *rsa.PublicKey
)

func init() {
    // Load private key
    privateKeyBytes, err := ioutil.ReadFile("private.pem")
    if err != nil {
        panic(err)
    }
    
    privateKey, err = jwt.ParseRSAPrivateKeyFromPEM(privateKeyBytes)
    if err != nil {
        panic(err)
    }
    
    // Load public key
    publicKeyBytes, err := ioutil.ReadFile("public.pem")
    if err != nil {
        panic(err)
    }
    
    publicKey, err = jwt.ParseRSAPublicKeyFromPEM(publicKeyBytes)
    if err != nil {
        panic(err)
    }
}

// GenerateToken creates a new JWT token signed with RSA
func GenerateToken(userID, email, role string, permissions []string, duration time.Duration) (string, error) {
    // Create claims
    claims := CustomClaims{
        UserID:      userID,
        Email:       email,
        Role:        role,
        Permissions: permissions,
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(duration)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
            NotBefore: jwt.NewNumericDate(time.Now()),
            Issuer:    "your-application",
            Subject:   userID,
        },
    }
    
    // Create token with claims
    token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
    
    // Sign the token with the private key
    tokenString, err := token.SignedString(privateKey)
    if err != nil {
        return "", err
    }
    
    return tokenString, nil
}

// ValidateToken validates a JWT token signed with RSA
func ValidateToken(tokenString string) (*CustomClaims, error) {
    // Parse the token
    token, err := jwt.ParseWithClaims(tokenString, &CustomClaims{}, func(token *jwt.Token) (interface{}, error) {
        // Validate the signing method
        if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
            return nil, errors.New("unexpected signing method")
        }
        return publicKey, nil
    })
    
    // Handle parsing errors
    if err != nil {
        if errors.Is(err, jwt.ErrTokenExpired) {
            return nil, ErrExpiredToken
        }
        return nil, err
    }
    
    // Check if the token is valid
    if !token.Valid {
        return nil, ErrInvalidToken
    }
    
    // Get claims from token
    claims, ok := token.Claims.(*CustomClaims)
    if !ok {
        return nil, ErrInvalidToken
    }
    
    return claims, nil
}
```

This approach has several advantages:

1. The private key (used for signing) can be kept separate from the public key (used for verification)
2. Resource servers only need the public key to verify tokens
3. Better security for distributed systems

### 2. Implementing Token Revocation

JWTs are stateless by design, which makes revocation challenging. Here's a strategy using a token blacklist:

```go
package auth

import (
    "sync"
    "time"
)

// TokenBlacklist stores revoked tokens
type TokenBlacklist struct {
    blacklist map[string]time.Time
    mu        sync.RWMutex
}

// NewTokenBlacklist creates a new token blacklist
func NewTokenBlacklist() *TokenBlacklist {
    bl := &TokenBlacklist{
        blacklist: make(map[string]time.Time),
    }
    
    // Start a goroutine to clean up expired tokens
    go bl.cleanup()
    
    return bl
}

// Revoke adds a token to the blacklist
func (bl *TokenBlacklist) Revoke(tokenID string, expiry time.Time) {
    bl.mu.Lock()
    defer bl.mu.Unlock()
    
    bl.blacklist[tokenID] = expiry
}

// IsRevoked checks if a token is revoked
func (bl *TokenBlacklist) IsRevoked(tokenID string) bool {
    bl.mu.RLock()
    defer bl.mu.RUnlock()
    
    _, exists := bl.blacklist[tokenID]
    return exists
}

// cleanup removes expired tokens from the blacklist
func (bl *TokenBlacklist) cleanup() {
    ticker := time.NewTicker(time.Hour)
    defer ticker.Stop()
    
    for range ticker.C {
        bl.mu.Lock()
        
        now := time.Now()
        for id, expiry := range bl.blacklist {
            if now.After(expiry) {
                delete(bl.blacklist, id)
            }
        }
        
        bl.mu.Unlock()
    }
}

// Global blacklist instance
var Blacklist = NewTokenBlacklist()
```

Then modify the token validation to check the blacklist:

```go
func ValidateToken(tokenString string) (*CustomClaims, error) {
    // Parse and validate the token
    claims, err := parseAndValidate(tokenString)
    if err != nil {
        return nil, err
    }
    
    // Check if the token is blacklisted
    if Blacklist.IsRevoked(claims.ID) {
        return nil, ErrRevokedToken
    }
    
    return claims, nil
}
```

### 3. Implementing Rate Limiting for Authentication Endpoints

To prevent brute force attacks, implement rate limiting:

```go
package middleware

import (
    "net/http"
    "sync"
    "time"
)

// RateLimiter implements a simple in-memory rate limiter
type RateLimiter struct {
    limits      map[string][]time.Time
    mu          sync.Mutex
    maxRequests int
    duration    time.Duration
}

// NewRateLimiter creates a new rate limiter
func NewRateLimiter(maxRequests int, duration time.Duration) *RateLimiter {
    return &RateLimiter{
        limits:      make(map[string][]time.Time),
        maxRequests: maxRequests,
        duration:    duration,
    }
}

// Limit is a middleware that limits the number of requests from an IP
func (rl *RateLimiter) Limit(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ip := getClientIP(r)
        
        rl.mu.Lock()
        
        // Initialize if this is a new IP
        if _, exists := rl.limits[ip]; !exists {
            rl.limits[ip] = []time.Time{}
        }
        
        // Clean up old timestamps
        now := time.Now()
        cutoff := now.Add(-rl.duration)
        newList := []time.Time{}
        
        for _, timestamp := range rl.limits[ip] {
            if timestamp.After(cutoff) {
                newList = append(newList, timestamp)
            }
        }
        
        rl.limits[ip] = newList
        
        // Check if the IP has reached the limit
        if len(rl.limits[ip]) >= rl.maxRequests {
            rl.mu.Unlock()
            http.Error(w, "Too many requests", http.StatusTooManyRequests)
            return
        }
        
        // Add current timestamp
        rl.limits[ip] = append(rl.limits[ip], now)
        rl.mu.Unlock()
        
        // Call the next handler
        next.ServeHTTP(w, r)
    })
}

// getClientIP extracts the client IP from the request
func getClientIP(r *http.Request) string {
    // Check for X-Forwarded-For header
    ip := r.Header.Get("X-Forwarded-For")
    if ip != "" {
        return ip
    }
    
    // Check for X-Real-IP header
    ip = r.Header.Get("X-Real-IP")
    if ip != "" {
        return ip
    }
    
    // Use RemoteAddr
    return r.RemoteAddr
}
```

Apply this middleware to your authentication endpoints:

```go
// Set up rate limiter (5 requests per minute)
limiter := middleware.NewRateLimiter(5, time.Minute)

// Apply rate limiting to login and token endpoints
http.Handle("/login", limiter.Limit(http.HandlerFunc(handleLogin)))
http.Handle("/refresh", limiter.Limit(http.HandlerFunc(handleRefresh)))
```

## Deploying Secure Authentication in Production

### 1. Environment Configuration

For production deployments, use environment variables for sensitive configuration:

```go
package config

import (
    "crypto/rsa"
    "io/ioutil"
    "os"
    "strconv"
    "time"
    
    "github.com/golang-jwt/jwt/v5"
)

// Configuration holds application configuration
type Configuration struct {
    Server struct {
        Port int
        Host string
    }
    
    JWT struct {
        PrivateKey     *rsa.PrivateKey
        PublicKey      *rsa.PublicKey
        AccessExpiry   time.Duration
        RefreshExpiry  time.Duration
    }
    
    OAuth struct {
        GoogleClientID     string
        GoogleClientSecret string
        RedirectURL        string
    }
}

// LoadConfig loads configuration from environment variables
func LoadConfig() (*Configuration, error) {
    var config Configuration
    
    // Server configuration
    config.Server.Port, _ = strconv.Atoi(getEnvOrDefault("SERVER_PORT", "8080"))
    config.Server.Host = getEnvOrDefault("SERVER_HOST", "localhost")
    
    // JWT configuration
    privateKeyPath := getEnvOrDefault("JWT_PRIVATE_KEY_PATH", "private.pem")
    publicKeyPath := getEnvOrDefault("JWT_PUBLIC_KEY_PATH", "public.pem")
    
    // Load private key
    privateKeyBytes, err := ioutil.ReadFile(privateKeyPath)
    if err != nil {
        return nil, err
    }
    
    config.JWT.PrivateKey, err = jwt.ParseRSAPrivateKeyFromPEM(privateKeyBytes)
    if err != nil {
        return nil, err
    }
    
    // Load public key
    publicKeyBytes, err := ioutil.ReadFile(publicKeyPath)
    if err != nil {
        return nil, err
    }
    
    config.JWT.PublicKey, err = jwt.ParseRSAPublicKeyFromPEM(publicKeyBytes)
    if err != nil {
        return nil, err
    }
    
    // Token expiry
    accessExpiryMinutes, _ := strconv.Atoi(getEnvOrDefault("JWT_ACCESS_EXPIRY_MINUTES", "15"))
    refreshExpiryDays, _ := strconv.Atoi(getEnvOrDefault("JWT_REFRESH_EXPIRY_DAYS", "7"))
    
    config.JWT.AccessExpiry = time.Duration(accessExpiryMinutes) * time.Minute
    config.JWT.RefreshExpiry = time.Duration(refreshExpiryDays) * 24 * time.Hour
    
    // OAuth configuration
    config.OAuth.GoogleClientID = getEnvOrDefault("GOOGLE_CLIENT_ID", "")
    config.OAuth.GoogleClientSecret = getEnvOrDefault("GOOGLE_CLIENT_SECRET", "")
    config.OAuth.RedirectURL = getEnvOrDefault("OAUTH_REDIRECT_URL", "http://localhost:8080/callback")
    
    return &config, nil
}

// getEnvOrDefault gets an environment variable or returns a default value
func getEnvOrDefault(key, defaultValue string) string {
    value, exists := os.LookupEnv(key)
    if !exists {
        return defaultValue
    }
    return value
}
```

### 2. Using a Secure HTTP Server

In production, always use HTTPS:

```go
package main

import (
    "log"
    "net/http"
    
    "github.com/yourusername/yourapp/config"
)

func main() {
    // Load configuration
    cfg, err := config.LoadConfig()
    if err != nil {
        log.Fatalf("Failed to load configuration: %v", err)
    }
    
    // Set up routes
    // ...
    
    // Server configuration
    server := &http.Server{
        Addr:         cfg.Server.Host + ":" + strconv.Itoa(cfg.Server.Port),
        Handler:      nil, // Your router
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  120 * time.Second,
    }
    
    // In production, use TLS
    if os.Getenv("ENVIRONMENT") == "production" {
        log.Printf("Starting HTTPS server on %s:%d", cfg.Server.Host, cfg.Server.Port)
        log.Fatal(server.ListenAndServeTLS("cert.pem", "key.pem"))
    } else {
        log.Printf("Starting HTTP server on %s:%d", cfg.Server.Host, cfg.Server.Port)
        log.Fatal(server.ListenAndServe())
    }
}
```

### 3. Securing JWT Storage on the Client

Advise your clients on how to securely store JWTs:

- **Web Applications**: Store access tokens in memory or HttpOnly cookies with secure flag, store refresh tokens in HttpOnly cookies
- **Mobile Applications**: Store tokens in secure storage (Keychain on iOS, Keystore on Android)
- **Single Page Applications (SPA)**: Use BFF (Backend for Frontend) pattern to handle tokens server-side

### 4. Monitoring and Logging for Security Events

Implement logging for security-related events:

```go
package log

import (
    "os"
    "time"
    
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

var logger *zap.Logger

func init() {
    // Configure logger
    config := zap.NewProductionConfig()
    
    // Set log level based on environment
    if os.Getenv("ENVIRONMENT") == "development" {
        config.Level = zap.NewAtomicLevelAt(zap.DebugLevel)
    }
    
    // Add time encoding
    config.EncoderConfig.TimeKey = "time"
    config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    
    // Create logger
    var err error
    logger, err = config.Build()
    if err != nil {
        panic(err)
    }
}

// SecurityEvent logs a security-related event
func SecurityEvent(event string, userID string, ip string, details map[string]interface{}) {
    fields := []zapcore.Field{
        zap.String("event", event),
        zap.String("user_id", userID),
        zap.String("ip", ip),
        zap.Time("timestamp", time.Now()),
    }
    
    // Add details
    for key, value := range details {
        fields = append(fields, zap.Any(key, value))
    }
    
    logger.Info("security_event", fields...)
}
```

Use this logger to track security events:

```go
func handleLogin(w http.ResponseWriter, r *http.Request) {
    // ... login logic
    
    if err != nil {
        // Log failed login attempt
        log.SecurityEvent(
            "login_failed",
            req.Email,
            getClientIP(r),
            map[string]interface{}{
                "reason": err.Error(),
            },
        )
        
        http.Error(w, "Invalid credentials", http.StatusUnauthorized)
        return
    }
    
    // Log successful login
    log.SecurityEvent(
        "login_success",
        user.ID,
        getClientIP(r),
        map[string]interface{}{
            "email": user.Email,
        },
    )
    
    // ... continue with login logic
}
```

## Conclusion

Implementing OAuth 2.0 and JWT in Go applications provides a robust, industry-standard approach to authentication and authorization. By following the best practices and code examples in this guide, you can create secure, scalable authentication systems that protect your users' data while providing a seamless experience.

Remember these key points:

1. **OAuth 2.0** is ideal for delegated authorization and third-party integrations
2. **JWT** provides a compact, self-contained format for transmitting authentication information
3. **Combining both** gives you the best of both worlds for many applications
4. **Security best practices** are essential for preventing common vulnerabilities
5. **Production deployments** require additional considerations for configuration, monitoring, and client-side security

With these tools and techniques, your Go applications will be well-equipped to handle modern authentication challenges while maintaining the performance and simplicity that Go is known for.