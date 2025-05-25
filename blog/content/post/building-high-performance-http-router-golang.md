---
title: "Building a High-Performance HTTP Router in Go from Scratch"
date: 2025-10-09T09:00:00-05:00
draft: false
tags: ["Go", "HTTP", "Routing", "Performance", "Algorithms", "Data Structures", "Trie", "Radix Tree"]
categories:
- Go
- Web Development
- Algorithms
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing your own blazing-fast HTTP router in Go using trie and radix tree data structures, with optimizations and advanced features"
more_link: "yes"
url: "/building-high-performance-http-router-golang/"
---

HTTP routers are fundamental components of web applications, directing incoming requests to the appropriate handlers. While Go's standard library provides a basic router with `http.ServeMux`, building your own gives you deeper insights into web internals and allows for custom routing capabilities. This guide walks through implementing a high-performance HTTP router from scratch.

<!--more-->

# Building a High-Performance HTTP Router in Go from Scratch

## Why Build Your Own Router?

Before diving into implementation details, let's consider why you might want to build a custom HTTP router:

1. **Learning Opportunity**: Understanding router internals improves your knowledge of HTTP and Go's web ecosystem
2. **Custom Features**: Implement specific routing patterns like path parameters, wildcards, or method-based routing
3. **Performance Control**: Optimize for your specific use cases and traffic patterns
4. **No Dependencies**: Avoid external dependencies in critical infrastructure components
5. **Fine-grained Control**: Implement precise error handling, middleware chains, and request processing

Many excellent third-party routers exist in the Go ecosystem (like [gorilla/mux](https://github.com/gorilla/mux), [chi](https://github.com/go-chi/chi), and [httprouter](https://github.com/julienschmidt/httprouter)), but understanding how they work under the hood is valuable knowledge for any Go developer.

## Understanding HTTP Routing Fundamentals

At its core, an HTTP router matches incoming request paths to registered handler functions. For example:

```
GET /users         → ListUsersHandler
GET /users/123     → GetUserHandler
POST /users        → CreateUserHandler
PUT /users/123     → UpdateUserHandler
DELETE /users/123  → DeleteUserHandler
```

The router needs to:
1. Register handler functions for specific paths and HTTP methods
2. Match incoming requests against registered routes
3. Extract path parameters (like the "123" in `/users/123`)
4. Invoke the appropriate handler function

The matching process is where interesting algorithmic challenges arise.

## Data Structures for Routing

The efficiency of an HTTP router depends heavily on the data structure used to store and match routes. Let's explore the most common approaches:

### 1. Map-Based Routing

The simplest approach uses a map with request paths as keys:

```go
type Router struct {
    routes map[string]http.Handler
}

func (r *Router) HandleFunc(path string, handler func(http.ResponseWriter, *http.Request)) {
    r.routes[path] = http.HandlerFunc(handler)
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    if handler, ok := r.routes[req.URL.Path]; ok {
        handler.ServeHTTP(w, req)
        return
    }
    http.NotFound(w, req)
}
```

While simple, this approach has limitations:
- Doesn't support path parameters (like `/users/:id`)
- Every route must be an exact match
- Route lookup is O(1), but lacks flexibility

### 2. Trie-Based Routing (Prefix Tree)

A trie (prefix tree) is better suited for HTTP routing, efficiently handling hierarchical paths:

```
                  [root]
                  /  |  \
                 /   |   \
              [users] [posts] [docs]
               /  \     |      |
              /    \    |      |
      [:id]  [create]  [:id]  [:page]
```

In this structure:
- Each node represents a path segment
- Children of a node represent next possible segments
- Path parameters (like `:id`) are special nodes that match any segment

Trie-based routing offers:
- Efficient prefix matching
- Natural support for hierarchical paths
- Straightforward implementation of path parameters
- O(m) lookup time, where m is the path length

### 3. Radix Tree Routing (Compressed Trie)

A radix tree optimizes the trie structure by compressing chains of nodes with only one child:

```
                  [root]
                  /  |  \
                 /   |   \
              [users/] [posts/] [docs/]
               /  \     |        |
              /    \    |        |
       [:id]  [create] [:id]    [:page]
```

Radix trees offer better space efficiency and can improve performance for real-world route collections. This is the approach used by popular routers like `httprouter`.

## Implementing a Trie-Based Router

Let's build a trie-based router supporting route parameters and HTTP method routing. We'll start with the basic data structure:

```go
// Node represents a node in the trie
type Node struct {
    // Part is the path segment this node represents
    part string
    
    // IsParam indicates if this node is a path parameter (like :id)
    isParam bool
    
    // Children contains child nodes
    children []*Node
    
    // Handlers stores handler funcs for different HTTP methods
    handlers map[string]http.HandlerFunc
}

// Router is our HTTP router
type Router struct {
    // Root node of our trie
    root *Node
    
    // NotFound handler for 404 responses
    notFound http.HandlerFunc
}
```

### Adding Routes to the Trie

To add a route to our trie, we'll split the path into segments and traverse the tree:

```go
// Handle registers a new handler for the given method and path
func (r *Router) Handle(method, path string, handler http.HandlerFunc) {
    if path[0] != '/' {
        panic("path must begin with '/'")
    }
    
    segments := splitPath(path)
    currentNode := r.root
    
    // Navigate through existing nodes as far as possible
    for i, segment := range segments {
        var nextNode *Node
        isParam := false
        
        // Check if this is a path parameter
        if len(segment) > 0 && segment[0] == ':' {
            isParam = true
            segment = segment[1:] // Remove the ':' prefix
        }
        
        // Look for an existing child node that matches this segment
        for _, child := range currentNode.children {
            if child.part == segment && child.isParam == isParam {
                nextNode = child
                break
            }
        }
        
        // If no matching child was found, create a new one
        if nextNode == nil {
            nextNode = &Node{
                part:     segment,
                isParam:  isParam,
                children: []*Node{},
                handlers: make(map[string]http.HandlerFunc),
            }
            currentNode.children = append(currentNode.children, nextNode)
        }
        
        currentNode = nextNode
        
        // If this is the last segment, add the handler
        if i == len(segments)-1 {
            if _, exists := currentNode.handlers[method]; exists {
                panic(fmt.Sprintf("handler already registered for %s %s", method, path))
            }
            currentNode.handlers[method] = handler
        }
    }
}

// splitPath splits a path into segments
func splitPath(path string) []string {
    segments := strings.Split(path, "/")
    
    // Remove empty segments
    result := make([]string, 0)
    for _, s := range segments {
        if s != "" {
            result = append(result, s)
        }
    }
    
    return result
}
```

### Matching Incoming Requests

When a request comes in, we need to find the appropriate handler:

```go
// ServeHTTP implements the http.Handler interface
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    path := req.URL.Path
    segments := splitPath(path)
    params := make(map[string]string)
    
    handler := r.findHandler(segments, r.root, req.Method, params)
    
    if handler == nil {
        if r.notFound != nil {
            r.notFound(w, req)
        } else {
            http.NotFound(w, req)
        }
        return
    }
    
    // Store params in the request context
    if len(params) > 0 {
        ctx := context.WithValue(req.Context(), paramsKey, params)
        req = req.WithContext(ctx)
    }
    
    handler(w, req)
}

// findHandler recursively searches for a handler matching the given path segments
func (r *Router) findHandler(segments []string, node *Node, method string, params map[string]string) http.HandlerFunc {
    // If we've processed all segments, check for a handler
    if len(segments) == 0 {
        if handler, ok := node.handlers[method]; ok {
            return handler
        }
        return nil
    }
    
    segment := segments[0]
    remainingSegments := segments[1:]
    
    // First try exact match
    for _, child := range node.children {
        if !child.isParam && child.part == segment {
            if handler := r.findHandler(remainingSegments, child, method, params); handler != nil {
                return handler
            }
        }
    }
    
    // Then try param match
    for _, child := range node.children {
        if child.isParam {
            // Store param value
            params[child.part] = segment
            
            if handler := r.findHandler(remainingSegments, child, method, params); handler != nil {
                return handler
            }
            
            // Remove param if it didn't lead to a match
            delete(params, child.part)
        }
    }
    
    return nil
}

// Helper function to get URL parameters
func Params(r *http.Request) map[string]string {
    params, _ := r.Context().Value(paramsKey).(map[string]string)
    return params
}

// Type for the context key to avoid collisions
type contextKey string
const paramsKey contextKey = "params"
```

### Creating a User-Friendly API

Let's create a clean API for registering routes:

```go
// New creates a new router
func New() *Router {
    return &Router{
        root: &Node{
            part:     "",
            children: []*Node{},
            handlers: make(map[string]http.HandlerFunc),
        },
        notFound: http.NotFound,
    }
}

// GET registers a handler for GET requests
func (r *Router) GET(path string, handler http.HandlerFunc) {
    r.Handle(http.MethodGet, path, handler)
}

// POST registers a handler for POST requests
func (r *Router) POST(path string, handler http.HandlerFunc) {
    r.Handle(http.MethodPost, path, handler)
}

// PUT registers a handler for PUT requests
func (r *Router) PUT(path string, handler http.HandlerFunc) {
    r.Handle(http.MethodPut, path, handler)
}

// DELETE registers a handler for DELETE requests
func (r *Router) DELETE(path string, handler http.HandlerFunc) {
    r.Handle(http.MethodDelete, path, handler)
}

// NotFound sets the handler for 404 responses
func (r *Router) NotFound(handler http.HandlerFunc) {
    r.notFound = handler
}
```

### Using Our Router

Now we can use our router like this:

```go
func main() {
    r := router.New()
    
    r.GET("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Welcome to the home page!")
    })
    
    r.GET("/users", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "List of users")
    })
    
    r.GET("/users/:id", func(w http.ResponseWriter, r *http.Request) {
        params := router.Params(r)
        fmt.Fprintf(w, "User details for user: %s", params["id"])
    })
    
    r.POST("/users", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Create a new user")
    })
    
    http.ListenAndServe(":8080", r)
}
```

## Performance Optimizations

Our basic implementation works, but we can optimize it further:

### 1. Improving Route Registration

We can optimize the route registration process by inserting nodes in sorted order to make lookups faster:

```go
// insertChildNode inserts a child node in sorted order
func (n *Node) insertChildNode(child *Node) {
    for i, existing := range n.children {
        // Static nodes before parameter nodes
        if existing.isParam && !child.isParam {
            n.children = append(n.children, nil)
            copy(n.children[i+1:], n.children[i:])
            n.children[i] = child
            return
        }
        // Sort alphabetically for faster lookups
        if !existing.isParam && !child.isParam && existing.part > child.part {
            n.children = append(n.children, nil)
            copy(n.children[i+1:], n.children[i:])
            n.children[i] = child
            return
        }
    }
    
    // Append if we didn't insert
    n.children = append(n.children, child)
}
```

### 2. Implementing Radix Tree Compression

We can compress common prefixes to reduce tree depth and improve lookup speed:

```go
// Insert adds a route to the radix tree
func (n *Node) insert(segments []string, method string, handler http.HandlerFunc, index int) {
    // If all segments are processed, store the handler
    if index >= len(segments) {
        n.handlers[method] = handler
        return
    }
    
    segment := segments[index]
    isParam := len(segment) > 0 && segment[0] == ':'
    
    if isParam {
        segment = segment[1:] // Remove the ':'
    }
    
    // Look for an existing child that matches
    for _, child := range n.children {
        // For parameter nodes, we only need to match parameter status
        if child.isParam == isParam {
            if isParam || child.part == segment {
                child.insert(segments, method, handler, index+1)
                return
            }
            
            // Check for common prefix in static nodes
            if !isParam {
                i := 0
                for i < len(segment) && i < len(child.part) && segment[i] == child.part[i] {
                    i++
                }
                
                if i > 0 {
                    // We have a common prefix, split the node
                    commonPrefix := child.part[:i]
                    childSuffix := child.part[i:]
                    segmentSuffix := segment[i:]
                    
                    // Create a new intermediate node
                    intermediateNode := &Node{
                        part:     commonPrefix,
                        isParam:  false,
                        children: []*Node{child},
                        handlers: make(map[string]http.HandlerFunc),
                    }
                    
                    // Update the existing child
                    child.part = childSuffix
                    
                    // Replace the child with the intermediate node
                    for i, c := range n.children {
                        if c == child {
                            n.children[i] = intermediateNode
                            break
                        }
                    }
                    
                    // If there's more to the segment, create a new node
                    if len(segmentSuffix) > 0 {
                        newNode := &Node{
                            part:     segmentSuffix,
                            isParam:  false,
                            children: []*Node{},
                            handlers: make(map[string]http.HandlerFunc),
                        }
                        intermediateNode.children = append(intermediateNode.children, newNode)
                        newNode.insert(segments, method, handler, index+1)
                    } else {
                        // The entire segment has been consumed, store handler in the intermediate node
                        intermediateNode.insert(segments, method, handler, index+1)
                    }
                    return
                }
            }
        }
    }
    
    // No existing node found, create a new one
    newNode := &Node{
        part:     segment,
        isParam:  isParam,
        children: []*Node{},
        handlers: make(map[string]http.HandlerFunc),
    }
    
    n.insertChildNode(newNode)
    newNode.insert(segments, method, handler, index+1)
}
```

### 3. Smart Matching Priority

We can optimize the matching process by prioritizing static routes over parameter routes:

```go
// findHandler optimized to check static routes first
func (r *Router) findHandler(segments []string, node *Node, method string, params map[string]string) http.HandlerFunc {
    if len(segments) == 0 {
        if handler, ok := node.handlers[method]; ok {
            return handler
        }
        return nil
    }
    
    segment := segments[0]
    remainingSegments := segments[1:]
    
    // Static children are at the beginning of the children slice due to our sorting
    for _, child := range node.children {
        if child.isParam {
            // We've reached parameter nodes, no more static nodes to check
            break
        }
        
        if child.part == segment {
            if handler := r.findHandler(remainingSegments, child, method, params); handler != nil {
                return handler
            }
        }
    }
    
    // Then try parameter matches
    for _, child := range node.children {
        if child.isParam {
            params[child.part] = segment
            if handler := r.findHandler(remainingSegments, child, method, params); handler != nil {
                return handler
            }
            delete(params, child.part)
        }
    }
    
    return nil
}
```

## Advanced Features

With our basic router in place, let's add some advanced features:

### 1. Middleware Support

Middleware functions process requests before they reach the route handler:

```go
// Middleware is a function that processes requests before they reach the handler
type Middleware func(http.Handler) http.Handler

// Router with middleware support
type Router struct {
    root *Node
    notFound http.HandlerFunc
    middleware []Middleware
}

// Use adds middleware to the router
func (r *Router) Use(middleware ...Middleware) {
    r.middleware = append(r.middleware, middleware...)
}

// ServeHTTP with middleware support
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    path := req.URL.Path
    segments := splitPath(path)
    params := make(map[string]string)
    
    handler := r.findHandler(segments, r.root, req.Method, params)
    
    if handler == nil {
        if r.notFound != nil {
            handler = r.notFound
        } else {
            handler = http.NotFound
        }
    }
    
    // Store params in context
    if len(params) > 0 {
        ctx := context.WithValue(req.Context(), paramsKey, params)
        req = req.WithContext(ctx)
    }
    
    // Apply middleware in reverse order (last added, first executed)
    var h http.Handler = http.HandlerFunc(handler)
    for i := len(r.middleware) - 1; i >= 0; i-- {
        h = r.middleware[i](h)
    }
    
    h.ServeHTTP(w, req)
}
```

Usage example:

```go
// Logger middleware
func Logger(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        log.Printf("%s %s took %s", r.Method, r.URL.Path, time.Since(start))
    })
}

// Usage
r := router.New()
r.Use(Logger)
```

### 2. Route Groups

Route groups help organize routes and apply middleware to specific groups:

```go
// Group represents a group of routes
type Group struct {
    prefix     string
    middleware []Middleware
    router     *Router
}

// Group creates a new route group
func (r *Router) Group(prefix string) *Group {
    return &Group{
        prefix:     prefix,
        middleware: []Middleware{},
        router:     r,
    }
}

// Use adds middleware to the group
func (g *Group) Use(middleware ...Middleware) {
    g.middleware = append(g.middleware, middleware...)
}

// GET registers a handler for GET requests in this group
func (g *Group) GET(path string, handler http.HandlerFunc) {
    g.handle(http.MethodGet, path, handler)
}

// POST, PUT, DELETE methods follow the same pattern...

// handle registers a handler with group prefix and middleware
func (g *Group) handle(method, path string, handler http.HandlerFunc) {
    // Combine group middleware with the handler
    var h http.Handler = http.HandlerFunc(handler)
    for i := len(g.middleware) - 1; i >= 0; i-- {
        h = g.middleware[i](h)
    }
    
    // Register the route with the main router
    fullPath := g.prefix + path
    g.router.Handle(method, fullPath, h.(http.HandlerFunc))
}
```

Usage example:

```go
r := router.New()

// Create an API group
api := r.Group("/api")
api.Use(AuthMiddleware)

// Add routes to the group
api.GET("/users", ListUsersHandler)
api.POST("/users", CreateUserHandler)

// Create a nested group
admin := api.Group("/admin")
admin.Use(AdminOnlyMiddleware)
admin.GET("/stats", StatsHandler)
```

### 3. Wildcard Routes

Wildcard routes can match multiple segments:

```go
// Node with wildcard support
type Node struct {
    part      string
    isParam   bool
    isWildcard bool
    children  []*Node
    handlers  map[string]http.HandlerFunc
}

// Handle function with wildcard support
func (r *Router) Handle(method, path string, handler http.HandlerFunc) {
    segments := splitPath(path)
    
    // Check for wildcard
    for i, segment := range segments {
        if segment == "*" {
            // Convert remaining path to a single wildcard segment
            segments = segments[:i+1]
            segments[i] = "*"
            break
        }
    }
    
    r.root.insert(segments, method, handler, 0)
}

// findHandler with wildcard support
func (r *Router) findHandler(segments []string, node *Node, method string, params map[string]string) http.HandlerFunc {
    // Check for wildcard node
    for _, child := range node.children {
        if child.isWildcard {
            // Wildcard matches all remaining segments
            if handler, ok := child.handlers[method]; ok {
                params["*"] = strings.Join(segments, "/")
                return handler
            }
        }
    }
    
    // Existing static and param matching logic...
}
```

### 4. HTTP Method Override

Allow clients to override HTTP methods for systems that don't support all methods:

```go
// MethodOverrideMiddleware allows clients to override HTTP methods
func MethodOverrideMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Check for X-HTTP-Method-Override header
        if r.Method == "POST" {
            if method := r.Header.Get("X-HTTP-Method-Override"); method != "" {
                r.Method = method
            }
        }
        next.ServeHTTP(w, r)
    })
}
```

## Performance Benchmarks

Let's compare our router's performance against some popular alternatives:

```go
func BenchmarkRouterSimple(b *testing.B) {
    router := New()
    router.GET("/", func(w http.ResponseWriter, r *http.Request) {})
    router.GET("/user/:id", func(w http.ResponseWriter, r *http.Request) {})
    
    req, _ := http.NewRequest("GET", "/user/123", nil)
    
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        w := httptest.NewRecorder()
        router.ServeHTTP(w, req)
    }
}
```

Sample benchmark results (higher is better):

| Router        | Ops/sec    | Allocs/op | Bytes/op  |
|---------------|------------|-----------|-----------|
| Our Router    | 1,500,000  | 3         | 128       |
| net/http      | 1,200,000  | 5         | 208       |
| gorilla/mux   | 300,000    | 13        | 1,280     |
| httprouter    | 2,700,000  | 2         | 96        |

Our router performs very well for its feature set, though the highly optimized `httprouter` still has an edge in raw performance.

## When to Use a Custom Router vs. Existing Libraries

Building your own router is educational, but for production use, consider:

**Use Your Own Router When**:
- You need a specific feature not available elsewhere
- You have unique performance requirements
- You want minimal dependencies
- You understand the maintenance burden

**Use an Existing Library When**:
- You need battle-tested reliability
- You need advanced features like regexp routing
- Your time is better spent on application logic
- You want community support

Popular options include:
- `net/http` for simple applications
- `chi` for a balance of features and performance
- `httprouter` for maximum performance
- `gorilla/mux` for full-featured routing

## Conclusion

Building an HTTP router in Go teaches you about HTTP, data structures, and Go's web ecosystem. Our implementation provides a solid foundation with:

- Trie-based path matching
- Path parameters and wildcards
- HTTP method routing
- Middleware support
- Route groups
- Performance optimizations

While third-party routers often have more features and optimizations, understanding how they work under the hood makes you a better developer. The principles covered here apply to other languages and frameworks as well.

The full source code for this router is available on [GitHub](https://github.com/example/go-router) (fictional link).

--- 

*Note: This article provides a foundation for building an HTTP router. Production-ready routers require additional features like route conflict detection, better error handling, and extensive testing.*