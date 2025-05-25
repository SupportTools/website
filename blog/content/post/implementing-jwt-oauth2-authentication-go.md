---
title: "Implementing JWT and OAuth2 Authentication in Go Applications: A Comprehensive Guide"
date: 2026-09-01T09:00:00-05:00
draft: false
tags: ["go", "golang", "security", "jwt", "oauth2", "authentication", "authorization"]
categories: ["Programming", "Go", "Security"]
---

Security is a critical concern for modern web applications. Authentication and authorization mechanisms ensure that your application's resources are accessible only to legitimate users with appropriate permissions. This guide explores how to implement two popular authentication methods in Go applications: JWT (JSON Web Tokens) and OAuth2.

## Understanding Authentication Concepts

Before diving into the implementation details, let's clarify some key concepts:

- **Authentication**: Verifying the identity of users (who they are)
- **Authorization**: Determining what resources a user can access (what they can do)
- **JWT (JSON Web Tokens)**: A compact, self-contained way to securely transmit information between parties as a JSON object
- **OAuth2**: An authorization framework that enables third-party applications to obtain limited access to a user's account on another service

## JWT Authentication in Go

JWT is particularly well-suited for stateless authentication in web services. The token contains all necessary information about the user, eliminating the need to query a database on every request.

### How JWT Works

1. A user logs in with credentials
2. The server validates credentials and creates a JWT
3. The JWT is sent to the client
4. On subsequent requests, the client sends the JWT in the Authorization header
5. The server validates the JWT and grants access if valid

### Setting Up JWT in Go

To implement JWT authentication, we'll use the `github.com/golang-jwt/jwt/v5` package:

```bash
go get github.com/golang-jwt/jwt/v5
```

Let's also use Echo as our web framework for this example:

```bash
go get github.com/labstack/echo/v4
```

### Creating a Basic JWT Authentication System

First, let's define our application structure:

```go
package main

import (
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// User represents the user model
type User struct {
	ID       int    `json:"id"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// LoginRequest contains login credentials
type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// JWTCustomClaims are custom claims extending default ones
type JWTCustomClaims struct {
	UserID int    `json:"user_id"`
	Name   string `json:"name"`
	jwt.RegisteredClaims
}

// Mock user database for simplicity
var users = map[string]User{
	"john": {
		ID:       1,
		Username: "john",
		Password: "password", // In a real application, store hashed passwords!
	},
}

const jwtSecret = "your-secret-key" // Use environment variables in production

func main() {
	e := echo.New()

	// Middleware
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())

	// Routes
	e.POST("/login", login)
	
	// Restricted group
	r := e.Group("/restricted")
	
	// Configure middleware with the custom claims type
	config := middleware.JWTConfig{
		Claims:     &JWTCustomClaims{},
		SigningKey: []byte(jwtSecret),
	}
	r.Use(middleware.JWTWithConfig(config))
	r.GET("", restricted)

	// Start server
	e.Logger.Fatal(e.Start(":1323"))
}

// Login handler
func login(c echo.Context) error {
	var loginReq LoginRequest
	if err := c.Bind(&loginReq); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "Invalid request body")
	}

	// Check if user exists and password is correct
	user, exists := users[loginReq.Username]
	if !exists || user.Password != loginReq.Password {
		return echo.NewHTTPError(http.StatusUnauthorized, "Invalid credentials")
	}

	// Set custom claims
	claims := &JWTCustomClaims{
		UserID: user.ID,
		Name:   user.Username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour * 72)),
		},
	}

	// Create token with claims
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)

	// Generate encoded token
	tokenString, err := token.SignedString([]byte(jwtSecret))
	if err != nil {
		return err
	}

	return c.JSON(http.StatusOK, map[string]string{
		"token": tokenString,
	})
}

// Restricted handler
func restricted(c echo.Context) error {
	user := c.Get("user").(*jwt.Token)
	claims := user.Claims.(*JWTCustomClaims)
	name := claims.Name
	return c.String(http.StatusOK, "Welcome "+name+"!")
}
```

### Testing JWT Authentication

You can test this with `curl` or any API testing tool:

```bash
# Login to get token
curl -X POST -H "Content-Type: application/json" -d '{"username":"john","password":"password"}' http://localhost:1323/login

# Access restricted endpoint with token
curl -X GET -H "Authorization: Bearer <your-token>" http://localhost:1323/restricted
```

### JWT Best Practices

1. **Store JWT Secret Securely**: Use environment variables or a secure vault
2. **Set Appropriate Expiration**: Short-lived tokens reduce the risk of token theft
3. **Use HTTPS**: Always transmit tokens over secure connections
4. **Add Necessary Claims**: Include only the required information in tokens
5. **Consider Refresh Tokens**: Implement refresh tokens for longer sessions

## Adding Refresh Tokens

Refresh tokens allow users to obtain a new access token without re-entering credentials. Here's how to implement them:

```go
// Add refresh token to our login response
type LoginResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"` // in seconds
}

// Generate a refresh token
func generateRefreshToken(userID int) (string, error) {
	claims := jwt.MapClaims{
		"user_id": userID,
		"exp":     time.Now().Add(time.Hour * 24 * 7).Unix(), // 1 week
	}
	
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(jwtSecret + "-refresh")) // Use a different secret
}

// Update login handler to include refresh token
func login(c echo.Context) error {
	// ... existing login code ...

	// Generate access token
	tokenString, err := token.SignedString([]byte(jwtSecret))
	if err != nil {
		return err
	}

	// Generate refresh token
	refreshToken, err := generateRefreshToken(user.ID)
	if err != nil {
		return err
	}

	return c.JSON(http.StatusOK, LoginResponse{
		AccessToken:  tokenString,
		RefreshToken: refreshToken,
		ExpiresIn:    60 * 60 * 72, // 72 hours in seconds
	})
}

// Add refresh token endpoint
func refreshAccessToken(c echo.Context) error {
	type RefreshRequest struct {
		RefreshToken string `json:"refresh_token"`
	}

	var req RefreshRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "Invalid request body")
	}

	// Parse the refresh token
	token, err := jwt.Parse(req.RefreshToken, func(token *jwt.Token) (interface{}, error) {
		// Validate the signing method
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, echo.NewHTTPError(http.StatusUnauthorized, "Unexpected signing method")
		}
		return []byte(jwtSecret + "-refresh"), nil
	})

	if err != nil || !token.Valid {
		return echo.NewHTTPError(http.StatusUnauthorized, "Invalid refresh token")
	}

	// Extract user ID from claims
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to parse claims")
	}

	userID, ok := claims["user_id"].(float64)
	if !ok {
		return echo.NewHTTPError(http.StatusInternalServerError, "Invalid user ID in token")
	}

	// Create new access token
	newClaims := &JWTCustomClaims{
		UserID: int(userID),
		Name:   getUsernameByID(int(userID)), // You need to implement this function
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour * 72)),
		},
	}

	newToken := jwt.NewWithClaims(jwt.SigningMethodHS256, newClaims)
	tokenString, err := newToken.SignedString([]byte(jwtSecret))
	if err != nil {
		return err
	}

	return c.JSON(http.StatusOK, map[string]string{
		"access_token": tokenString,
		"expires_in":   "259200", // 72 hours in seconds
	})
}

// Implement in main()
e.POST("/refresh", refreshAccessToken)
```

## OAuth2 Authentication in Go

OAuth2 enables your application to authenticate users through third-party providers like Google, GitHub, or Facebook.

### Setting Up OAuth2 in Go

First, install the OAuth2 package:

```bash
go get golang.org/x/oauth2
```

For this example, we'll implement Google OAuth2 authentication:

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// Define OAuth2 configuration
var googleOauthConfig = &oauth2.Config{
	ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),     // Use environment variables
	ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"), // Use environment variables
	RedirectURL:  "http://localhost:1323/auth/google/callback",
	Scopes:       []string{"https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"},
	Endpoint:     google.Endpoint,
}

// Define JWT settings
const jwtSecret = "your-secret-key" // Use environment variables in production

// User represents the user model
type User struct {
	ID       int    `json:"id"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	GoogleID string `json:"google_id"`
}

// Mock user database for simplicity
var users = map[string]User{} // GoogleID -> User

// GoogleUserInfo represents the user info returned by Google
type GoogleUserInfo struct {
	ID            string `json:"id"`
	Email         string `json:"email"`
	VerifiedEmail bool   `json:"verified_email"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

// JWTCustomClaims are custom claims extending default ones
type JWTCustomClaims struct {
	UserID int    `json:"user_id"`
	Name   string `json:"name"`
	jwt.RegisteredClaims
}

func main() {
	e := echo.New()

	// Middleware
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())

	// Routes
	e.GET("/", home)
	e.GET("/auth/google", googleLogin)
	e.GET("/auth/google/callback", googleCallback)
	
	// Restricted group
	r := e.Group("/restricted")
	config := middleware.JWTConfig{
		Claims:     &JWTCustomClaims{},
		SigningKey: []byte(jwtSecret),
	}
	r.Use(middleware.JWTWithConfig(config))
	r.GET("", restricted)

	// Start server
	e.Logger.Fatal(e.Start(":1323"))
}

// Home handler
func home(c echo.Context) error {
	return c.HTML(http.StatusOK, `
		<html>
			<body>
				<h1>Welcome to OAuth2 Example</h1>
				<a href="/auth/google">Login with Google</a>
			</body>
		</html>
	`)
}

// Google login handler
func googleLogin(c echo.Context) error {
	// Generate a random state
	state := fmt.Sprintf("%d", time.Now().UnixNano())
	
	// Save state to cookie
	cookie := new(http.Cookie)
	cookie.Name = "oauthstate"
	cookie.Value = state
	cookie.Expires = time.Now().Add(5 * time.Minute)
	c.SetCookie(cookie)
	
	// Redirect to Google's consent page
	url := googleOauthConfig.AuthCodeURL(state)
	return c.Redirect(http.StatusTemporaryRedirect, url)
}

// Google callback handler
func googleCallback(c echo.Context) error {
	// Get state from cookie
	cookie, err := c.Cookie("oauthstate")
	if err != nil || cookie.Value != c.QueryParam("state") {
		return echo.NewHTTPError(http.StatusBadRequest, "Invalid OAuth state")
	}
	
	// Exchange the authorization code for a token
	code := c.QueryParam("code")
	token, err := googleOauthConfig.Exchange(context.Background(), code)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Code exchange failed: "+err.Error())
	}
	
	// Get user info
	userInfo, err := getUserInfo(token)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to get user info: "+err.Error())
	}
	
	// Check if user exists in our database, if not create a new one
	user, exists := users[userInfo.ID]
	if !exists {
		// Create a new user
		user = User{
			ID:       len(users) + 1, // Simple ID generation, use UUID in production
			Email:    userInfo.Email,
			Name:     userInfo.Name,
			GoogleID: userInfo.ID,
		}
		users[userInfo.ID] = user
	}
	
	// Create JWT token
	claims := &JWTCustomClaims{
		UserID: user.ID,
		Name:   user.Name,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour * 72)),
		},
	}
	
	token2 := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token2.SignedString([]byte(jwtSecret))
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to generate token: "+err.Error())
	}
	
	// Return token or redirect to frontend with token
	return c.JSON(http.StatusOK, map[string]string{
		"token": tokenString,
	})
}

// Get user info from Google
func getUserInfo(token *oauth2.Token) (*GoogleUserInfo, error) {
	// Create client
	client := googleOauthConfig.Client(context.Background(), token)
	
	// Get user info
	resp, err := client.Get("https://www.googleapis.com/oauth2/v2/userinfo")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	// Read response
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	
	// Parse response
	var userInfo GoogleUserInfo
	err = json.Unmarshal(data, &userInfo)
	if err != nil {
		return nil, err
	}
	
	return &userInfo, nil
}

// Restricted handler
func restricted(c echo.Context) error {
	user := c.Get("user").(*jwt.Token)
	claims := user.Claims.(*JWTCustomClaims)
	name := claims.Name
	return c.String(http.StatusOK, "Welcome "+name+"! You accessed a protected resource.")
}
```

## Combining JWT and OAuth2 into a Complete Authentication System

For a complete authentication system, you might want to support both JWT and OAuth2 authentication. Here's how to structure such a system:

```go
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"golang.org/x/oauth2/github"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// Configuration
type Config struct {
	JWTSecret           string
	JWTExpiration       time.Duration
	RefreshTokenSecret  string
	RefreshTokenExpiry  time.Duration
	GoogleClientID      string
	GoogleClientSecret  string
	GitHubClientID      string
	GitHubClientSecret  string
	BaseURL             string
}

// Load configuration from environment variables
func loadConfig() Config {
	return Config{
		JWTSecret:           getEnv("JWT_SECRET", "your-jwt-secret"),
		JWTExpiration:       time.Hour * 1,  // Short-lived access tokens
		RefreshTokenSecret:  getEnv("REFRESH_TOKEN_SECRET", "your-refresh-token-secret"),
		RefreshTokenExpiry:  time.Hour * 24 * 7, // 7 days
		GoogleClientID:      getEnv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret:  getEnv("GOOGLE_CLIENT_SECRET", ""),
		GitHubClientID:      getEnv("GITHUB_CLIENT_ID", ""),
		GitHubClientSecret:  getEnv("GITHUB_CLIENT_SECRET", ""),
		BaseURL:             getEnv("BASE_URL", "http://localhost:1323"),
	}
}

func getEnv(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}

// OAuth2 Provider Types
type OAuthProviderType string

const (
	GoogleOAuthProvider OAuthProviderType = "google"
	GitHubOAuthProvider OAuthProviderType = "github"
)

// Models
type User struct {
	ID        int       `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Password  string    `json:"-"` // Never return in JSON
	GoogleID  string    `json:"-"`
	GitHubID  string    `json:"-"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"` // in seconds
}

// JWT Claims
type JWTCustomClaims struct {
	UserID int    `json:"user_id"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	jwt.RegisteredClaims
}

// Application struct
type Application struct {
	Config      Config
	OAuthConfigs map[OAuthProviderType]*oauth2.Config
	Echo        *echo.Echo
	Users       map[int]*User // Mock database
	EmailIndex  map[string]int // Email to user ID index
}

// Initialize the application
func NewApplication() *Application {
	config := loadConfig()
	app := &Application{
		Config: config,
		OAuthConfigs: make(map[OAuthProviderType]*oauth2.Config),
		Echo:   echo.New(),
		Users:  make(map[int]*User),
		EmailIndex: make(map[string]int),
	}

	// Setup OAuth2 configs
	app.OAuthConfigs[GoogleOAuthProvider] = &oauth2.Config{
		ClientID:     config.GoogleClientID,
		ClientSecret: config.GoogleClientSecret,
		RedirectURL:  fmt.Sprintf("%s/auth/google/callback", config.BaseURL),
		Scopes:       []string{"https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"},
		Endpoint:     google.Endpoint,
	}
	
	app.OAuthConfigs[GitHubOAuthProvider] = &oauth2.Config{
		ClientID:     config.GitHubClientID,
		ClientSecret: config.GitHubClientSecret,
		RedirectURL:  fmt.Sprintf("%s/auth/github/callback", config.BaseURL),
		Scopes:       []string{"user:email"},
		Endpoint:     github.Endpoint,
	}

	// Add mock user for testing
	hashedPassword, _ := bcrypt.GenerateFromPassword([]byte("password123"), bcrypt.DefaultCost)
	user := &User{
		ID:        1,
		Email:     "test@example.com",
		Name:      "Test User",
		Password:  string(hashedPassword),
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	app.Users[1] = user
	app.EmailIndex["test@example.com"] = 1

	return app
}

// Set up routes
func (app *Application) SetupRoutes() {
	e := app.Echo

	// Middleware
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORS())

	// Public routes
	e.GET("/", app.HomePage)
	e.POST("/register", app.Register)
	e.POST("/login", app.Login)
	e.POST("/refresh", app.RefreshToken)
	
	// OAuth routes
	e.GET("/auth/google", app.GoogleLogin)
	e.GET("/auth/google/callback", app.GoogleCallback)
	e.GET("/auth/github", app.GitHubLogin)
	e.GET("/auth/github/callback", app.GitHubCallback)

	// Protected routes
	r := e.Group("/api")
	config := middleware.JWTConfig{
		Claims:     &JWTCustomClaims{},
		SigningKey: []byte(app.Config.JWTSecret),
	}
	r.Use(middleware.JWTWithConfig(config))
	r.GET("/profile", app.Profile)
}

// Route handlers
func (app *Application) HomePage(c echo.Context) error {
	return c.HTML(http.StatusOK, `
		<html>
			<body>
				<h1>Authentication Example</h1>
				<ul>
					<li><a href="/auth/google">Login with Google</a></li>
					<li><a href="/auth/github">Login with GitHub</a></li>
				</ul>
			</body>
		</html>
	`)
}

func (app *Application) Register(c echo.Context) error {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}

	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "Invalid request body")
	}

	// Validate
	if req.Email == "" || req.Password == "" || req.Name == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "Email, password, and name are required")
	}

	// Check if email exists
	if _, exists := app.EmailIndex[req.Email]; exists {
		return echo.NewHTTPError(http.StatusConflict, "Email already exists")
	}

	// Hash password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to hash password")
	}

	// Create user
	userID := len(app.Users) + 1
	user := &User{
		ID:        userID,
		Email:     req.Email,
		Name:      req.Name,
		Password:  string(hashedPassword),
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	app.Users[userID] = user
	app.EmailIndex[req.Email] = userID

	// Create tokens
	accessToken, refreshToken, err := app.GenerateTokens(user)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to generate tokens")
	}

	return c.JSON(http.StatusCreated, TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int(app.Config.JWTExpiration.Seconds()),
	})
}

func (app *Application) Login(c echo.Context) error {
	var req LoginRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "Invalid request body")
	}

	// Find user by email
	userID, exists := app.EmailIndex[req.Email]
	if !exists {
		return echo.NewHTTPError(http.StatusUnauthorized, "Invalid credentials")
	}
	user := app.Users[userID]

	// Check password
	err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password))
	if err != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "Invalid credentials")
	}

	// Generate tokens
	accessToken, refreshToken, err := app.GenerateTokens(user)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to generate tokens")
	}

	return c.JSON(http.StatusOK, TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int(app.Config.JWTExpiration.Seconds()),
	})
}

func (app *Application) RefreshToken(c echo.Context) error {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}

	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "Invalid request body")
	}

	// Validate refresh token
	token, err := jwt.Parse(req.RefreshToken, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(app.Config.RefreshTokenSecret), nil
	})

	if err != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "Invalid refresh token")
	}

	if claims, ok := token.Claims.(jwt.MapClaims); ok && token.Valid {
		// Extract user ID from claims
		userIDFloat, ok := claims["user_id"].(float64)
		if !ok {
			return echo.NewHTTPError(http.StatusInternalServerError, "Invalid user ID in token")
		}
		
		userID := int(userIDFloat)
		user, exists := app.Users[userID]
		if !exists {
			return echo.NewHTTPError(http.StatusUnauthorized, "User not found")
		}

		// Generate new access token
		accessToken, err := app.GenerateAccessToken(user)
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, "Failed to generate access token")
		}

		return c.JSON(http.StatusOK, map[string]interface{}{
			"access_token": accessToken,
			"expires_in":   int(app.Config.JWTExpiration.Seconds()),
		})
	}

	return echo.NewHTTPError(http.StatusUnauthorized, "Invalid refresh token")
}

func (app *Application) GoogleLogin(c echo.Context) error {
	// Generate state for CSRF protection
	state, err := app.GenerateRandomState()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to generate state")
	}

	// Store state in a cookie
	cookie := new(http.Cookie)
	cookie.Name = "oauth_state"
	cookie.Value = state
	cookie.Expires = time.Now().Add(15 * time.Minute)
	c.SetCookie(cookie)

	// Redirect to Google's consent page
	url := app.OAuthConfigs[GoogleOAuthProvider].AuthCodeURL(state)
	return c.Redirect(http.StatusTemporaryRedirect, url)
}

func (app *Application) GoogleCallback(c echo.Context) error {
	return app.handleOAuthCallback(c, GoogleOAuthProvider)
}

func (app *Application) GitHubLogin(c echo.Context) error {
	// Generate state for CSRF protection
	state, err := app.GenerateRandomState()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to generate state")
	}

	// Store state in a cookie
	cookie := new(http.Cookie)
	cookie.Name = "oauth_state"
	cookie.Value = state
	cookie.Expires = time.Now().Add(15 * time.Minute)
	c.SetCookie(cookie)

	// Redirect to GitHub's consent page
	url := app.OAuthConfigs[GitHubOAuthProvider].AuthCodeURL(state)
	return c.Redirect(http.StatusTemporaryRedirect, url)
}

func (app *Application) GitHubCallback(c echo.Context) error {
	return app.handleOAuthCallback(c, GitHubOAuthProvider)
}

func (app *Application) Profile(c echo.Context) error {
	// Get user from JWT token
	token := c.Get("user").(*jwt.Token)
	claims := token.Claims.(*JWTCustomClaims)
	
	user, exists := app.Users[claims.UserID]
	if !exists {
		return echo.NewHTTPError(http.StatusNotFound, "User not found")
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"id":    user.ID,
		"email": user.Email,
		"name":  user.Name,
	})
}

// Helper functions
func (app *Application) GenerateTokens(user *User) (string, string, error) {
	// Generate access token
	accessToken, err := app.GenerateAccessToken(user)
	if err != nil {
		return "", "", err
	}

	// Generate refresh token
	refreshToken, err := app.GenerateRefreshToken(user)
	if err != nil {
		return "", "", err
	}

	return accessToken, refreshToken, nil
}

func (app *Application) GenerateAccessToken(user *User) (string, error) {
	// Create custom claims
	claims := &JWTCustomClaims{
		UserID: user.ID,
		Email:  user.Email,
		Name:   user.Name,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(app.Config.JWTExpiration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	// Create token with claims
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)

	// Generate encoded token
	return token.SignedString([]byte(app.Config.JWTSecret))
}

func (app *Application) GenerateRefreshToken(user *User) (string, error) {
	// Create token with claims
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"user_id":   user.ID,
		"tokenType": "refresh",
		"exp":       time.Now().Add(app.Config.RefreshTokenExpiry).Unix(),
		"iat":       time.Now().Unix(),
	})

	// Generate encoded token
	return token.SignedString([]byte(app.Config.RefreshTokenSecret))
}

func (app *Application) GenerateRandomState() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	if err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

func (app *Application) handleOAuthCallback(c echo.Context, provider OAuthProviderType) error {
	// Verify state to prevent CSRF
	state := c.QueryParam("state")
	cookie, err := c.Cookie("oauth_state")
	if err != nil || cookie.Value != state {
		return echo.NewHTTPError(http.StatusBadRequest, "Invalid OAuth state")
	}

	// Delete state cookie
	cookie.Value = ""
	cookie.Expires = time.Unix(0, 0)
	c.SetCookie(cookie)

	// Exchange authorization code for token
	code := c.QueryParam("code")
	token, err := app.OAuthConfigs[provider].Exchange(context.Background(), code)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to exchange code: "+err.Error())
	}

	// Get user info from provider
	userInfo, err := app.GetUserInfoFromProvider(provider, token)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to get user info: "+err.Error())
	}

	// Find or create user
	user, err := app.FindOrCreateUserFromOAuth(provider, userInfo)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to process user: "+err.Error())
	}

	// Generate tokens
	accessToken, refreshToken, err := app.GenerateTokens(user)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Failed to generate tokens")
	}

	// Return token (or redirect to frontend with token)
	return c.JSON(http.StatusOK, TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int(app.Config.JWTExpiration.Seconds()),
	})
}

func (app *Application) GetUserInfoFromProvider(provider OAuthProviderType, token *oauth2.Token) (map[string]interface{}, error) {
	client := app.OAuthConfigs[provider].Client(context.Background(), token)
	
	var url string
	switch provider {
	case GoogleOAuthProvider:
		url = "https://www.googleapis.com/oauth2/v2/userinfo"
	case GitHubOAuthProvider:
		url = "https://api.github.com/user"
	default:
		return nil, fmt.Errorf("unsupported provider: %s", provider)
	}
	
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	
	var userInfo map[string]interface{}
	err = json.Unmarshal(data, &userInfo)
	if err != nil {
		return nil, err
	}
	
	// For GitHub, we need to fetch emails separately if email is null
	if provider == GitHubOAuthProvider {
		email, ok := userInfo["email"].(string)
		if !ok || email == "" {
			emails, err := app.GetGitHubEmails(client)
			if err == nil && len(emails) > 0 {
				for _, e := range emails {
					if primary, ok := e["primary"].(bool); ok && primary {
						if email, ok := e["email"].(string); ok {
							userInfo["email"] = email
							break
						}
					}
				}
			}
		}
	}
	
	return userInfo, nil
}

func (app *Application) GetGitHubEmails(client *http.Client) ([]map[string]interface{}, error) {
	resp, err := client.Get("https://api.github.com/user/emails")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	
	var emails []map[string]interface{}
	err = json.Unmarshal(data, &emails)
	if err != nil {
		return nil, err
	}
	
	return emails, nil
}

func (app *Application) FindOrCreateUserFromOAuth(provider OAuthProviderType, userInfo map[string]interface{}) (*User, error) {
	var email, name, providerID string
	var ok bool
	
	// Extract common fields with type checking
	if email, ok = userInfo["email"].(string); !ok {
		return nil, fmt.Errorf("email not found or not a string in user info")
	}
	
	// Name might be under "name" or "login" (GitHub)
	if name, ok = userInfo["name"].(string); !ok {
		if name, ok = userInfo["login"].(string); !ok {
			name = email // Fallback to email
		}
	}
	
	// ID might be a string or a float64 depending on the provider
	if id, ok := userInfo["id"].(string); ok {
		providerID = id
	} else if id, ok := userInfo["id"].(float64); ok {
		providerID = fmt.Sprintf("%v", id)
	} else {
		return nil, fmt.Errorf("ID not found in user info")
	}
	
	// Check if user exists by email
	if userID, exists := app.EmailIndex[email]; exists {
		user := app.Users[userID]
		
		// Update provider ID if not set
		switch provider {
		case GoogleOAuthProvider:
			if user.GoogleID == "" {
				user.GoogleID = providerID
				user.UpdatedAt = time.Now()
			}
		case GitHubOAuthProvider:
			if user.GitHubID == "" {
				user.GitHubID = providerID
				user.UpdatedAt = time.Now()
			}
		}
		
		return user, nil
	}
	
	// Create new user
	user := &User{
		ID:        len(app.Users) + 1,
		Email:     email,
		Name:      name,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	
	// Set provider-specific ID
	switch provider {
	case GoogleOAuthProvider:
		user.GoogleID = providerID
	case GitHubOAuthProvider:
		user.GitHubID = providerID
	}
	
	// Save user
	app.Users[user.ID] = user
	app.EmailIndex[email] = user.ID
	
	return user, nil
}

func main() {
	app := NewApplication()
	app.SetupRoutes()

	app.Echo.Logger.Fatal(app.Echo.Start(":1323"))
}
```

## Security Considerations

### Token Security

1. **Use Appropriate Token Expiration**:
   - Access tokens: Short-lived (15-60 minutes)
   - Refresh tokens: Longer-lived (days to weeks)

2. **Secure Token Storage**:
   - Store tokens in HttpOnly cookies or secure local storage
   - Never store in localStorage for production applications

3. **Token Revocation**:
   - Implement a token blacklist for revoked tokens
   - Use Redis or a similar in-memory store to check revoked tokens

### OAuth2 Security

1. **Always Validate the State Parameter**:
   - Use cryptographically secure random values
   - Store state in a server-side session or signed cookie

2. **Use PKCE for Public Clients**:
   - Code Verifier and Code Challenge protect against interception attacks
   
3. **Keep Client Secrets Secure**:
   - Store in environment variables or secret management systems
   - Never commit to version control

### General Security Best Practices

1. **Always Use HTTPS in Production**:
   - All token transmissions should be over TLS

2. **Implement Rate Limiting**:
   - Protect login, refresh, and OAuth endpoints

3. **Include Appropriate Security Headers**:

```go
// Add security headers middleware
func securityHeadersMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
    return func(c echo.Context) error {
        c.Response().Header().Set("X-Content-Type-Options", "nosniff")
        c.Response().Header().Set("X-Frame-Options", "DENY")
        c.Response().Header().Set("Content-Security-Policy", "default-src 'self'")
        c.Response().Header().Set("Referrer-Policy", "no-referrer-when-downgrade")
        c.Response().Header().Set("X-XSS-Protection", "1; mode=block")
        return next(c)
    }
}

// Add to Echo instance
e.Use(securityHeadersMiddleware)
```

## Testing Authentication

### Unit Testing JWT Authentication

```go
func TestGenerateJWT(t *testing.T) {
	app := NewApplication()
	user := app.Users[1] // Get test user
	
	token, _, err := app.GenerateTokens(user)
	if err != nil {
		t.Fatalf("Failed to generate token: %v", err)
	}
	
	// Parse and verify token
	parsedToken, err := jwt.ParseWithClaims(token, &JWTCustomClaims{}, func(token *jwt.Token) (interface{}, error) {
		return []byte(app.Config.JWTSecret), nil
	})
	
	if err != nil {
		t.Fatalf("Failed to parse token: %v", err)
	}
	
	if !parsedToken.Valid {
		t.Fatalf("Token is invalid")
	}
	
	claims, ok := parsedToken.Claims.(*JWTCustomClaims)
	if !ok {
		t.Fatalf("Failed to parse claims")
	}
	
	if claims.UserID != user.ID {
		t.Errorf("Expected user ID %d, got %d", user.ID, claims.UserID)
	}
	
	if claims.Email != user.Email {
		t.Errorf("Expected email %s, got %s", user.Email, claims.Email)
	}
}
```

### Integration Testing with Authenticated Requests

```go
func TestProtectedEndpoint(t *testing.T) {
	app := NewApplication()
	app.SetupRoutes()
	
	// Get token for test user
	user := app.Users[1]
	token, _, err := app.GenerateTokens(user)
	if err != nil {
		t.Fatalf("Failed to generate token: %v", err)
	}
	
	// Create request
	req := httptest.NewRequest(http.MethodGet, "/api/profile", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	
	// Serve the request
	app.Echo.ServeHTTP(rec, req)
	
	// Check response
	if rec.Code != http.StatusOK {
		t.Errorf("Expected status code %d, got %d", http.StatusOK, rec.Code)
	}
	
	// Parse response
	var response map[string]interface{}
	err = json.Unmarshal(rec.Body.Bytes(), &response)
	if err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}
	
	// Check user data
	if int(response["id"].(float64)) != user.ID {
		t.Errorf("Expected user ID %d, got %v", user.ID, response["id"])
	}
	
	if response["email"].(string) != user.Email {
		t.Errorf("Expected email %s, got %s", user.Email, response["email"])
	}
}
```

## Conclusion

Implementing JWT and OAuth2 authentication in Go applications provides robust security while maintaining good user experience. The combination of these authentication methods can meet various requirements:

- JWT for stateless, efficient authentication within your system
- OAuth2 for delegating authentication to trusted providers and simplifying the login process for users

By following security best practices and using the patterns outlined in this guide, you can create a secure, scalable authentication system for your Go applications.

Remember that authentication is just one part of a comprehensive security strategy. Always keep your dependencies updated, follow security best practices, and stay informed about emerging threats and mitigations.

For production applications, consider leveraging established identity providers and authentication libraries when appropriate, as they often incorporate additional security features and have been thoroughly tested in the real world.