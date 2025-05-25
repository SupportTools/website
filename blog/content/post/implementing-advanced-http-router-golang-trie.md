---
title: "Implementing an Advanced HTTP Router in Go Using Trie Data Structures"
date: 2026-08-25T09:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Router", "Trie", "Data Structures", "Performance", "Algorithms", "Web Development"]
categories:
- Go
- Web Development
- Algorithms
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to designing and implementing a high-performance HTTP router in Go using Trie data structures, with support for path parameters, wildcards, and middleware"
more_link: "yes"
url: "/implementing-advanced-http-router-golang-trie/"
---

As applications grow in complexity, efficient request routing becomes essential. Go's standard library provides a basic router with `http.ServeMux`, but building your own HTTP router unlocks powerful capabilities like method-based routing, path parameters, and middleware chains. This comprehensive guide walks through building an advanced HTTP router using Trie data structures.

<!--more-->

# Implementing an Advanced HTTP Router in Go Using Trie Data Structures

## Understanding HTTP Routing and Its Challenges

HTTP routers are fundamental components in web applications, responsible for directing incoming requests to appropriate handlers. A router parses the request's URL path and HTTP method, matching it against a set of registered routes to determine which handler should process the request.

Go's standard library provides a basic HTTP router with `http.ServeMux`, but it has several limitations:

1. **No HTTP Method Routing**: Cannot route based on HTTP methods (GET, POST, etc.)
2. **No Path Parameters**: Cannot extract variables from URL paths (e.g., `/users/:id`)
3. **No Pattern Matching**: Limited pattern matching capabilities
4. **No Middleware Support**: No built-in concept of middleware chains

Building a custom router addresses these limitations and offers a deeper understanding of HTTP handling in Go.

## Why Use Trie Data Structures for Routing

Trie (prefix tree) data structures are particularly well-suited for HTTP routing for several reasons:

1. **Path-Based Organization**: URLs naturally form a hierarchical structure that maps cleanly to a trie
2. **Efficient Prefix Matching**: Tries excel at matching common prefixes
3. **Fast Lookup**: O(m) lookup time, where m is the path length, not dependent on the number of routes
4. **Compact Representation**: Can efficiently store routes with common prefixes

Let's visualize the trie structure for a set of routes:

```
Routes:
GET  /
GET  /users
POST /users
GET  /users/:id
PUT  /users/:id
GET  /posts
GET  /posts/:id
GET  /posts/:id/comments
```

This would create a trie structure like:

```
                 [root]
                 /    \
               /        \
          [users]      [posts]
           /  \          /  \
         /     \        /    \
   [<empty>]  [:id]  [<empty>] [:id]
   GET/POST    / \     GET     /  \
              /   \           /    \
            GET   PUT     [<empty>] [comments]
                            GET      GET
```

Note that each node in the trie represents a path segment, and each node can have associated HTTP method handlers.

## Design Considerations for Our Router

Before diving into implementation, let's define our requirements:

1. **Method-Based Routing**: Support different handlers for different HTTP methods
2. **Path Parameters**: Extract variables from URL paths (e.g., `/users/:id`)
3. **Wildcards**: Support wildcard matching (e.g., `/static/*`)
4. **Middleware Support**: Allow middleware chains before handler execution
5. **Route Groups**: Support grouping routes with common prefixes
6. **Conflict Detection**: Provide clear errors when conflicting routes are defined

### Router Interface

The router will expose a clean API for registering routes:

```go
// Create a new router
router := httprouter.New()

// Register simple routes
router.GET("/", indexHandler)
router.POST("/users", createUserHandler)

// Route with path parameter
router.GET("/users/:id", getUserHandler)

// Route with middleware
router.GET("/admin", authMiddleware, adminHandler)

// Route group
api := router.Group("/api")
api.GET("/users", listUsersHandler)
```

Let's start implementing our router step-by-step.

## Basic Implementation: Core Trie Structure

First, let's define the basic trie structure for our router:

```go
package httprouter

import (
	"errors"
	"net/http"
	"strings"
)

const (
	// Special node types
	nodeTypeStatic = iota
	nodeTypeParam
	nodeTypeWildcard
)

// Constants for path handling
const (
	PathRoot      = "/"
	PathDelimiter = "/"
)

// Common errors
var (
	ErrNotFound         = errors.New("not found")
	ErrMethodNotAllowed = errors.New("method not allowed")
)

// Node represents a node in the trie
type Node struct {
	// nodeType defines the type of node (static, parameter, wildcard)
	nodeType int

	// path represents the path segment
	path string

	// children contains the child nodes indexed by their first character
	// for fast lookup
	children map[string]*Node

	// handlers contains handlers for different HTTP methods
	handlers map[string]http.Handler

	// wildcard child node, if present
	wildcard *Node

	// param child node, if present
	param *Node
}

// Trie represents the router's trie structure
type Trie struct {
	root *Node
}

// NewTrie creates a new trie for routing
func NewTrie() *Trie {
	return &Trie{
		root: &Node{
			nodeType: nodeTypeStatic,
			path:     PathRoot,
			children: make(map[string]*Node),
			handlers: make(map[string]http.Handler),
		},
	}
}
```

Our trie structure has three types of nodes:
1. **Static nodes**: Match exact path segments
2. **Parameter nodes**: Match any segment and extract it as a parameter (e.g., `:id`)
3. **Wildcard nodes**: Match any remaining part of the path (e.g., `*` or `*filepath`)

### Adding Routes to the Trie

Now let's implement the function to add routes to our trie:

```go
// Insert adds a route to the trie
func (t *Trie) Insert(method, path string, handler http.Handler) error {
	// Ensure path starts with /
	if !strings.HasPrefix(path, PathRoot) {
		path = PathRoot + path
	}
	
	// Handle root path separately
	if path == PathRoot {
		t.root.handlers[method] = handler
		return nil
	}
	
	// Split path into segments
	segments := splitPath(path)
	
	// Start from the root node
	current := t.root
	
	// Process each path segment
	for i, segment := range segments {
		// Check if this is a parameter segment (starts with :)
		if strings.HasPrefix(segment, ":") {
			paramName := segment[1:]
			
			// Create parameter node if it doesn't exist
			if current.param == nil {
				current.param = &Node{
					nodeType: nodeTypeParam,
					path:     paramName,
					children: make(map[string]*Node),
					handlers: make(map[string]http.Handler),
				}
			}
			
			current = current.param
			continue
		}
		
		// Check if this is a wildcard segment
		if segment == "*" || strings.HasPrefix(segment, "*") {
			wildcardName := ""
			if segment != "*" {
				wildcardName = segment[1:]
			}
			
			// Create wildcard node if it doesn't exist
			if current.wildcard == nil {
				current.wildcard = &Node{
					nodeType: nodeTypeWildcard,
					path:     wildcardName,
					children: make(map[string]*Node),
					handlers: make(map[string]http.Handler),
				}
			}
			
			// Wildcard must be the last segment
			if i != len(segments)-1 {
				return errors.New("wildcard must be the last segment in the path")
			}
			
			current = current.wildcard
			break
		}
		
		// Handle static segments
		child, exists := current.children[segment]
		if !exists {
			// Create a new node for this segment
			child = &Node{
				nodeType: nodeTypeStatic,
				path:     segment,
				children: make(map[string]*Node),
				handlers: make(map[string]http.Handler),
			}
			current.children[segment] = child
		}
		
		current = child
	}
	
	// Register the handler for the specified HTTP method
	current.handlers[method] = handler
	
	return nil
}

// Helper function to split a path into segments
func splitPath(path string) []string {
	segments := strings.Split(path, PathDelimiter)
	var result []string
	
	for _, segment := range segments {
		if segment != "" {
			result = append(result, segment)
		}
	}
	
	return result
}
```

### Searching the Trie

Now we need to implement the search function to find the appropriate handler for a given path:

```go
// RouteMatch represents the result of a successful route match
type RouteMatch struct {
	Handler    http.Handler
	Params     map[string]string
	MatchedURL string
}

// Search finds a handler in the trie matching the given method and path
func (t *Trie) Search(method, path string) (*RouteMatch, error) {
	// Ensure path starts with /
	if !strings.HasPrefix(path, PathRoot) {
		path = PathRoot + path
	}
	
	// Handle root path separately
	if path == PathRoot {
		handler, exists := t.root.handlers[method]
		if !exists {
			return nil, ErrMethodNotAllowed
		}
		return &RouteMatch{
			Handler:    handler,
			Params:     make(map[string]string),
			MatchedURL: PathRoot,
		}, nil
	}
	
	// Split path into segments
	segments := splitPath(path)
	
	// Initialize result for collecting path parameters
	params := make(map[string]string)
	
	// Start search from the root
	match, found := searchNode(t.root, segments, method, params, 0)
	
	if !found {
		return nil, ErrNotFound
	}
	
	if match.Handler == nil {
		return nil, ErrMethodNotAllowed
	}
	
	return match, nil
}

// searchNode recursively searches for a matching node in the trie
func searchNode(node *Node, segments []string, method string, params map[string]string, index int) (*RouteMatch, bool) {
	// If we've processed all segments, check if this node has a handler for the requested method
	if index >= len(segments) {
		handler, exists := node.handlers[method]
		if !exists {
			// We found the path but not for this method
			return &RouteMatch{
				Handler:    nil,
				Params:     params,
				MatchedURL: "",
			}, true
		}
		
		return &RouteMatch{
			Handler:    handler,
			Params:     params,
			MatchedURL: "",
		}, true
	}
	
	segment := segments[index]
	
	// Try exact match first (priority order: exact > param > wildcard)
	if child, exists := node.children[segment]; exists {
		if match, found := searchNode(child, segments, method, params, index+1); found {
			return match, true
		}
	}
	
	// Try parameter match
	if node.param != nil {
		// Clone params to avoid modifying the original on backtracking
		paramsCopy := copyParams(params)
		paramsCopy[node.param.path] = segment
		
		if match, found := searchNode(node.param, segments, method, paramsCopy, index+1); found {
			return match, true
		}
	}
	
	// Try wildcard match (must be at the end)
	if node.wildcard != nil {
		// For wildcards, capture all remaining segments
		remaining := strings.Join(segments[index:], PathDelimiter)
		
		// Clone params to avoid modifying the original
		paramsCopy := copyParams(params)
		
		if node.wildcard.path != "" {
			// If wildcard has a name (e.g., *filepath), capture the value
			paramsCopy[node.wildcard.path] = remaining
		}
		
		// Check if wildcard node has the requested method
		handler, exists := node.wildcard.handlers[method]
		if !exists {
			return &RouteMatch{
				Handler:    nil,
				Params:     paramsCopy,
				MatchedURL: "",
			}, true
		}
		
		return &RouteMatch{
			Handler:    handler,
			Params:     paramsCopy,
			MatchedURL: "",
		}, true
	}
	
	// No match found
	return nil, false
}

// Helper function to copy path parameters map
func copyParams(params map[string]string) map[string]string {
	copy := make(map[string]string, len(params))
	for k, v := range params {
		copy[k] = v
	}
	return copy
}
```

## Router Implementation with Method-Based Support

Now that we have our trie data structure, let's implement the actual router:

```go
// Router is the HTTP router
type Router struct {
	trie           *Trie
	notFound       http.Handler
	methodNotAllowed http.Handler
	paramsKey      interface{}
}

// New creates a new Router
func New() *Router {
	return &Router{
		trie:           NewTrie(),
		notFound:       http.NotFoundHandler(),
		methodNotAllowed: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusMethodNotAllowed)
		}),
		paramsKey:      contextKey("params"),
	}
}

// context key type to avoid collisions
type contextKey string

// ServeHTTP implements the http.Handler interface
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Find the handler for this path
	match, err := r.trie.Search(req.Method, req.URL.Path)
	
	if err != nil {
		switch err {
		case ErrNotFound:
			r.notFound.ServeHTTP(w, req)
		case ErrMethodNotAllowed:
			r.methodNotAllowed.ServeHTTP(w, req)
		default:
			// Unexpected error, respond with internal server error
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		}
		return
	}
	
	// If we have path parameters, add them to the request context
	if len(match.Params) > 0 {
		ctx := context.WithValue(req.Context(), r.paramsKey, match.Params)
		req = req.WithContext(ctx)
	}
	
	// Call the handler
	match.Handler.ServeHTTP(w, req)
}

// GET registers a route for GET requests
func (r *Router) GET(path string, handler http.HandlerFunc) {
	r.Handle(http.MethodGet, path, handler)
}

// POST registers a route for POST requests
func (r *Router) POST(path string, handler http.HandlerFunc) {
	r.Handle(http.MethodPost, path, handler)
}

// PUT registers a route for PUT requests
func (r *Router) PUT(path string, handler http.HandlerFunc) {
	r.Handle(http.MethodPut, path, handler)
}

// DELETE registers a route for DELETE requests
func (r *Router) DELETE(path string, handler http.HandlerFunc) {
	r.Handle(http.MethodDelete, path, handler)
}

// PATCH registers a route for PATCH requests
func (r *Router) PATCH(path string, handler http.HandlerFunc) {
	r.Handle(http.MethodPatch, path, handler)
}

// Handle registers a route with a method, path and handler
func (r *Router) Handle(method, path string, handler http.Handler) {
	err := r.trie.Insert(method, path, handler)
	if err != nil {
		panic(err)
	}
}

// NotFound sets the handler for 404 responses
func (r *Router) NotFound(handler http.Handler) {
	r.notFound = handler
}

// MethodNotAllowed sets the handler for 405 responses
func (r *Router) MethodNotAllowed(handler http.Handler) {
	r.methodNotAllowed = handler
}

// Params returns the path parameters from the request context
func Params(r *http.Request) map[string]string {
	// Check if we have any params
	if r == nil || r.Context() == nil {
		return make(map[string]string)
	}
	
	// Try to extract params from context
	if params, ok := r.Context().Value(contextKey("params")).(map[string]string); ok {
		return params
	}
	
	return make(map[string]string)
}

// Param returns a specific path parameter value
func Param(r *http.Request, name string) string {
	return Params(r)[name]
}
```

This implementation provides method-based routing with a clean, intuitive API.

## Adding Middleware Support

Now let's enhance our router with middleware support:

```go
// Middleware represents a handler middleware
type Middleware func(http.Handler) http.Handler

// Router with middleware support
type Router struct {
	trie            *Trie
	notFound        http.Handler
	methodNotAllowed http.Handler
	paramsKey       interface{}
	middleware      []Middleware  // Global middleware
}

// Use adds middleware to the router
func (r *Router) Use(middleware ...Middleware) {
	r.middleware = append(r.middleware, middleware...)
}

// applyMiddleware wraps a handler with all registered middleware
func (r *Router) applyMiddleware(handler http.Handler) http.Handler {
	// Apply middleware in reverse order (last added, first executed)
	for i := len(r.middleware) - 1; i >= 0; i-- {
		handler = r.middleware[i](handler)
	}
	return handler
}

// ServeHTTP with middleware support
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Find the handler for this path
	match, err := r.trie.Search(req.Method, req.URL.Path)
	
	if err != nil {
		switch err {
		case ErrNotFound:
			r.notFound.ServeHTTP(w, req)
		case ErrMethodNotAllowed:
			r.methodNotAllowed.ServeHTTP(w, req)
		default:
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		}
		return
	}
	
	// If we have path parameters, add them to the request context
	if len(match.Params) > 0 {
		ctx := context.WithValue(req.Context(), r.paramsKey, match.Params)
		req = req.WithContext(ctx)
	}
	
	// Apply middleware to the handler
	handler := r.applyMiddleware(match.Handler)
	
	// Call the handler
	handler.ServeHTTP(w, req)
}

// Handle with middleware support
func (r *Router) Handle(method, path string, handler http.Handler, middleware ...Middleware) {
	// Apply route-specific middleware
	for i := len(middleware) - 1; i >= 0; i-- {
		handler = middleware[i](handler)
	}
	
	err := r.trie.Insert(method, path, handler)
	if err != nil {
		panic(err)
	}
}

// GET with middleware support
func (r *Router) GET(path string, handler http.Handler, middleware ...Middleware) {
	r.Handle(http.MethodGet, path, handler, middleware...)
}

// Similar implementation for POST, PUT, DELETE, etc.
```

## Adding Route Groups

Route groups help organize routes with a common prefix and middleware:

```go
// Group represents a group of routes
type Group struct {
	router     *Router
	prefix     string
	middleware []Middleware
}

// Group creates a new route group
func (r *Router) Group(prefix string) *Group {
	return &Group{
		router:     r,
		prefix:     prefix,
		middleware: []Middleware{},
	}
}

// Use adds middleware to the group
func (g *Group) Use(middleware ...Middleware) *Group {
	g.middleware = append(g.middleware, middleware...)
	return g
}

// Handle registers a route with this group
func (g *Group) Handle(method, path string, handler http.Handler, middleware ...Middleware) {
	// Combine group middleware with route middleware
	allMiddleware := append(g.middleware, middleware...)
	
	// Apply the middleware
	for i := len(allMiddleware) - 1; i >= 0; i-- {
		handler = allMiddleware[i](handler)
	}
	
	// Register with the router using the full path
	fullPath := g.prefix + path
	g.router.Handle(method, fullPath, handler)
}

// GET registers a GET route with this group
func (g *Group) GET(path string, handler http.Handler, middleware ...Middleware) {
	g.Handle(http.MethodGet, path, handler, middleware...)
}

// Similar implementation for POST, PUT, DELETE, etc.

// Group creates a sub-group
func (g *Group) Group(prefix string) *Group {
	return &Group{
		router:     g.router,
		prefix:     g.prefix + prefix,
		middleware: append([]Middleware{}, g.middleware...),
	}
}
```

## Performance Optimizations

Our router is functional, but we can make it more efficient with some optimizations:

### 1. Radix Tree Compression

We can compress the trie into a radix tree by merging nodes with a single child:

```go
// compress merges nodes with just one static child
func (n *Node) compress() {
	// Compress children first (depth-first)
	for _, child := range n.children {
		child.compress()
	}
	
	// If we have a parameter or wildcard child, compress it too
	if n.param != nil {
		n.param.compress()
	}
	if n.wildcard != nil {
		n.wildcard.compress()
	}
	
	// If this node has exactly one static child and no handlers or other child types, merge them
	if len(n.children) == 1 && len(n.handlers) == 0 && n.param == nil && n.wildcard == nil {
		// Get the single child
		var childKey string
		var childNode *Node
		for k, v := range n.children {
			childKey = k
			childNode = v
			break
		}
		
		// If the child also has no handlers and no special children, merge
		if childNode.nodeType == nodeTypeStatic && len(childNode.handlers) == 0 && 
			childNode.param == nil && childNode.wildcard == nil {
			// Merge path segments
			n.path = n.path + PathDelimiter + childNode.path
			// Adopt grandchildren
			n.children = childNode.children
			// Clear the now-merged child
			delete(n.children, childKey)
		}
	}
}
```

### 2. Sorted Child Matching

For static nodes with many children, we can optimize the search by sorting children by frequency:

```go
// childrenByFrequency helps prioritize matching based on access frequency
type childFrequency struct {
	path      string
	node      *Node
	frequency int64
}

// updateMatchFrequency increments the match frequency counter
func (n *Node) updateMatchFrequency(segment string) {
	if n.childrenFrequency == nil {
		n.childrenFrequency = make(map[string]*childFrequency)
	}
	
	freq, exists := n.childrenFrequency[segment]
	if !exists {
		freq = &childFrequency{
			path:      segment,
			node:      n.children[segment],
			frequency: 0,
		}
		n.childrenFrequency[segment] = freq
	}
	
	freq.frequency++
	
	// Reorder children by frequency for faster matching of common paths
	if len(n.childrenFrequency) > 1 && freq.frequency % 100 == 0 {
		n.sortChildrenByFrequency()
	}
}

// sortChildrenByFrequency sorts children by access frequency
func (n *Node) sortChildrenByFrequency() {
	// Implementation omitted for brevity
}
```

### 3. Path Segment Caching

Cache path segments to avoid repeated string splitting:

```go
// pathSegmentCache caches split path segments
var pathSegmentCache = &sync.Map{}

// splitPathCached splits a path into segments with caching
func splitPathCached(path string) []string {
	// Check cache first
	if cached, ok := pathSegmentCache.Load(path); ok {
		return cached.([]string)
	}
	
	// Split and cache the result
	segments := splitPath(path)
	pathSegmentCache.Store(path, segments)
	return segments
}
```

## Using Our Router in an Application

Let's see how to use our advanced router in a real application:

```go
package main

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"example.com/httprouter"
)

// Middleware for logging
func LoggerMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}

// Middleware for authentication
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		if token != "valid-token" {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, "Unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	// Create a new router
	router := httprouter.New()
	
	// Add global middleware
	router.Use(LoggerMiddleware)
	
	// Basic routes
	router.GET("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "Welcome to the home page!")
	}))
	
	router.GET("/users/:id", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := httprouter.Param(r, "id")
		fmt.Fprintf(w, "User details for user: %s", id)
	}))
	
	// Route with specific middleware
	router.GET("/admin", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "Admin page")
	}), AuthMiddleware)
	
	// Route group for API endpoints
	api := router.Group("/api")
	api.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			next.ServeHTTP(w, r)
		})
	})
	
	// API routes
	api.GET("/users", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"users": [{"id": 1, "name": "John"}, {"id": 2, "name": "Jane"}]}`)
	}))
	
	api.GET("/users/:id", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := httprouter.Param(r, "id")
		fmt.Fprintf(w, `{"id": %s, "name": "User %s"}`, id, id)
	}))
	
	// Start the server
	log.Println("Server starting on port 8080")
	log.Fatal(http.ListenAndServe(":8080", router))
}
```

## Benchmarking Our Router

It's important to measure the performance of our router. Here's a simple benchmark comparing it with the standard library and some popular alternatives:

```go
package httprouter_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"example.com/httprouter"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/mux"
	julienschmidt "github.com/julienschmidt/httprouter"
)

func BenchmarkRouterSimple(b *testing.B) {
	b.Run("StandardServeMux", func(b *testing.B) {
		mux := http.NewServeMux()
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {})
		mux.HandleFunc("/users/123", func(w http.ResponseWriter, r *http.Request) {})
		
		req, _ := http.NewRequest("GET", "/users/123", nil)
		
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
		}
	})
	
	b.Run("OurRouter", func(b *testing.B) {
		router := httprouter.New()
		router.GET("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		router.GET("/users/:id", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		
		req, _ := http.NewRequest("GET", "/users/123", nil)
		
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
		}
	})
	
	// Similar benchmarks for other routers omitted for brevity
}
```

Typical benchmark results might look like:

| Router                 | Operations/sec | Allocations/op | Bytes/op |
|------------------------|----------------|----------------|----------|
| net/http.ServeMux      | 6,000,000      | 0              | 0        |
| Our Router             | 2,500,000      | 4              | 160      |
| gorilla/mux            | 250,000        | 14             | 1,312    |
| julienschmidt/httprouter | 4,500,000    | 1              | 64       |
| go-chi/chi             | 1,000,000      | 7              | 368      |

These numbers are illustrative and would vary based on route complexity, implementation details, and benchmark methodology.

## Advanced Features and Enhancements

Here are some additional features we could add to make our router even more powerful:

### 1. Regular Expression Routing

Add support for regex-based path matching:

```go
// RegexNode extends Node with regex matching
type RegexNode struct {
	pattern *regexp.Regexp
	names   []string
}

// Insert with regex support
func (t *Trie) Insert(method, path string, handler http.Handler) error {
	// Detect regex patterns like /users/{id:[0-9]+}
	if strings.Contains(path, "{") && strings.Contains(path, "}") {
		// Parse regex pattern
		pattern, names := parseRegexPattern(path)
		
		// Create regex node
		// Implementation omitted for brevity
	}
	
	// Regular insertion for non-regex paths
	// ...
}
```

### 2. Automatic OPTIONS Handling

Add automatic handling of OPTIONS requests:

```go
// autoOptions automatically responds to OPTIONS requests
func (r *Router) autoOptions() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// Only handle OPTIONS requests
		if req.Method != http.MethodOptions {
			r.methodNotAllowed.ServeHTTP(w, req)
			return
		}
		
		// Find all methods allowed for this path
		methods := r.getAllowedMethods(req.URL.Path)
		
		// If no methods are allowed, return 404
		if len(methods) == 0 {
			r.notFound.ServeHTTP(w, req)
			return
		}
		
		// Add Allow header with allowed methods
		w.Header().Set("Allow", strings.Join(methods, ", "))
		w.WriteHeader(http.StatusNoContent)
	})
}

// getAllowedMethods returns all methods registered for a path
func (r *Router) getAllowedMethods(path string) []string {
	// Implementation omitted for brevity
	return []string{}
}
```

### 3. CORS Middleware

Add built-in CORS support:

```go
// CORSConfig defines CORS configuration
type CORSConfig struct {
	AllowOrigins     []string
	AllowMethods     []string
	AllowHeaders     []string
	AllowCredentials bool
	MaxAge           int
}

// CORSMiddleware creates a CORS middleware with the given config
func CORSMiddleware(config CORSConfig) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Set CORS headers
			if len(config.AllowOrigins) > 0 {
				w.Header().Set("Access-Control-Allow-Origin", strings.Join(config.AllowOrigins, ", "))
			}
			
			if len(config.AllowMethods) > 0 {
				w.Header().Set("Access-Control-Allow-Methods", strings.Join(config.AllowMethods, ", "))
			}
			
			if len(config.AllowHeaders) > 0 {
				w.Header().Set("Access-Control-Allow-Headers", strings.Join(config.AllowHeaders, ", "))
			}
			
			if config.AllowCredentials {
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
			
			if config.MaxAge > 0 {
				w.Header().Set("Access-Control-Max-Age", strconv.Itoa(config.MaxAge))
			}
			
			// Handle preflight requests
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			
			next.ServeHTTP(w, r)
		})
	}
}
```

## Best Practices for Router Implementation

When building or using an HTTP router, consider these best practices:

### 1. Route Organization

- Group related routes together
- Use consistent path patterns and naming conventions
- Organize routes by resource, not by HTTP method

### 2. Error Handling

- Provide descriptive error messages for routing conflicts
- Implement custom handlers for common error cases (404, 405)
- Log routing errors for debugging

### 3. Security Considerations

- Validate URL parameters to prevent injection attacks
- Implement rate limiting middleware
- Use HTTPS redirects where appropriate

### 4. Performance

- Benchmark your router with realistic workloads
- Use profiling to identify bottlenecks
- Consider the impact of middleware chains on performance

## Conclusion

Building a custom HTTP router in Go provides valuable insights into HTTP handling, algorithm design, and performance optimization. Our implementation offers several advantages over the standard library's router:

1. **Method-based routing** for cleaner handler organization
2. **Path parameters** for dynamic route segments
3. **Wildcards** for flexible path matching
4. **Middleware support** for cross-cutting concerns
5. **Route groups** for logical organization

While many production applications will use established routers like chi, gorilla/mux, or echo, understanding how these routers work under the hood makes you a better Go developer. The principles covered in this guide apply to other languages and frameworks as well.

The full source code for this router is available on [GitHub](https://github.com/supporttools/httprouter) (fictional link for illustration).

---

*Note: While this router is functional, production applications should consider using well-established, thoroughly tested routers for critical systems. Building your own router is primarily a learning experience or for specialized use cases.*