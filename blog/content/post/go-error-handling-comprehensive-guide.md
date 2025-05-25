---
title: "Comprehensive Guide to Error Handling in Go: From Basics to Advanced Patterns"
date: 2026-05-26T09:00:00-05:00
draft: false
tags: ["go", "golang", "error-handling", "programming", "best-practices"]
categories: ["Programming", "Go", "Best Practices"]
---

Error handling is a fundamental aspect of robust software development, and Go takes a distinctive approach that differs significantly from many other modern programming languages. Rather than using exceptions, Go embraces explicit error handling that promotes clarity and visibility, though at the cost of some verbosity. This guide explores the complete spectrum of error handling in Go, from basic patterns to advanced techniques that will help you write more robust, maintainable code.

## Go's Philosophy on Error Handling

Go's approach to error handling is rooted in simplicity and explicitness. Unlike languages that use exceptions (like Java, Python, or C#), Go treats errors as values that must be explicitly checked and handled. This philosophy stems from the Go designers' belief that:

1. **Explicit is better than implicit**: When errors are values that must be checked, the error handling flow is always visible in the code.
2. **Simplicity matters**: Complex error hierarchies and exception handling can make code harder to reason about.
3. **Control flow should be clear**: The path of execution, including error cases, should be easy to follow.

While this approach can feel verbose initially, it offers significant benefits: code becomes more predictable, the "happy path" and error paths are equally visible, and there are no hidden control flows that might surprise maintainers later.

## Basic Error Handling Patterns

### The Standard Pattern: Check and Return

The most common error handling pattern in Go is checking errors immediately after function calls:

```go
result, err := someFunction()
if err != nil {
    // Handle the error
    return nil, err
}
// Continue with the result
```

This pattern is so ubiquitous that it's considered idiomatic Go. Always handle errors immediately—don't let them linger.

### Adding Context to Errors

When returning errors up the call stack, add context to help with debugging:

```go
func readConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("failed to read config file: %w", err)
    }
    
    var config Config
    if err := json.Unmarshal(data, &config); err != nil {
        return nil, fmt.Errorf("failed to parse config file: %w", err)
    }
    
    return &config, nil
}
```

The `%w` verb (introduced in Go 1.13) wraps the original error, preserving its type and value while adding context. This allows error inspection with `errors.Is` and `errors.As` (which we'll cover later).

### Sentinel Errors

For specific error conditions that callers might want to check, define sentinel errors:

```go
var (
    ErrNotFound     = errors.New("resource not found")
    ErrUnauthorized = errors.New("unauthorized access")
    ErrTimeout      = errors.New("operation timed out")
)

func GetUser(id string) (*User, error) {
    user, found := userDB[id]
    if !found {
        return nil, ErrNotFound
    }
    return user, nil
}
```

Callers can then check for specific errors:

```go
user, err := GetUser(userID)
if err != nil {
    if errors.Is(err, ErrNotFound) {
        // Handle not found specifically
        return nil, fmt.Errorf("user %s not found", userID)
    }
    // Handle other errors
    return nil, fmt.Errorf("failed to get user: %w", err)
}
```

### Handling Multiple Error Types

For complex operations that can fail in different ways, consider using custom error types:

```go
type ValidationError struct {
    Field string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation error on field %s: %s", e.Field, e.Message)
}

func ValidateUser(user User) error {
    if user.Name == "" {
        return &ValidationError{
            Field: "name",
            Message: "name cannot be empty",
        }
    }
    
    if user.Age < 0 {
        return &ValidationError{
            Field: "age",
            Message: "age cannot be negative",
        }
    }
    
    return nil
}
```

Then use type assertions or `errors.As` to handle specific error types:

```go
if err := ValidateUser(user); err != nil {
    var valErr *ValidationError
    if errors.As(err, &valErr) {
        fmt.Printf("Validation failed: %s\n", valErr.Message)
        return
    }
    fmt.Printf("Unknown error: %v\n", err)
}
```

## Advanced Error Handling Techniques

### Error Wrapping (Go 1.13+)

Go 1.13 introduced error wrapping with the `%w` formatting verb and related functions:

```go
// Wrapping an error
err := doSomething()
if err != nil {
    return fmt.Errorf("operation failed: %w", err)
}
```

This allows two powerful checks:

1. **errors.Is**: Check if an error or any error it wraps matches a specific error value

```go
// Check if err or any wrapped error is ErrNotFound
if errors.Is(err, ErrNotFound) {
    // Handle not found case
}
```

2. **errors.As**: Check if an error or any error it wraps matches a specific error type

```go
var syntaxErr *json.SyntaxError
if errors.As(err, &syntaxErr) {
    line, col := findLineCol(data, syntaxErr.Offset)
    fmt.Printf("Syntax error at line %d, column %d\n", line, col)
}
```

### The Errors Package

For more advanced error handling with stack traces, consider using the [`github.com/pkg/errors`](https://github.com/pkg/errors) package:

```go
import "github.com/pkg/errors"

func readConfig() (*Config, error) {
    data, err := ioutil.ReadFile("config.json")
    if err != nil {
        return nil, errors.Wrap(err, "reading config file")
    }
    
    var config Config
    if err := json.Unmarshal(data, &config); err != nil {
        return nil, errors.Wrap(err, "parsing config file")
    }
    
    return &config, nil
}
```

This package provides several useful functions:
- `errors.New`: Create a new error with stack trace
- `errors.Wrap`: Wrap an error with a message and stack trace
- `errors.Cause`: Get the original error

However, with Go 1.13+'s error wrapping features, the standard library now covers most use cases.

### Working with Multiple Errors

Sometimes you need to collect multiple errors before returning them. Here are a few approaches:

#### 1. Using Slices

```go
func validateForm(form Form) error {
    var errs []error
    
    if form.Name == "" {
        errs = append(errs, errors.New("name is required"))
    }
    
    if form.Email == "" {
        errs = append(errs, errors.New("email is required"))
    }
    
    if len(errs) > 0 {
        return fmt.Errorf("form validation failed: %v", errs)
    }
    
    return nil
}
```

#### 2. Using the `errors` package in Go 1.20+

Go 1.20 introduced `errors.Join` for combining multiple errors:

```go
func validateForm(form Form) error {
    var errs []error
    
    if form.Name == "" {
        errs = append(errs, errors.New("name is required"))
    }
    
    if form.Email == "" {
        errs = append(errs, errors.New("email is required"))
    }
    
    if len(errs) > 0 {
        return errors.Join(errs...)
    }
    
    return nil
}
```

Errors combined with `errors.Join` can still be checked with `errors.Is` and `errors.As`.

#### 3. Using Third-Party Packages

For more complex use cases, consider packages like [`github.com/hashicorp/go-multierror`](https://github.com/hashicorp/go-multierror):

```go
import "github.com/hashicorp/go-multierror"

func validateForm(form Form) error {
    var result *multierror.Error
    
    if form.Name == "" {
        result = multierror.Append(result, errors.New("name is required"))
    }
    
    if form.Email == "" {
        result = multierror.Append(result, errors.New("email is required"))
    }
    
    return result.ErrorOrNil()
}
```

### Functional Options for Error Handling

For functions with many possible error conditions, you can use functional options to keep the code clean:

```go
type errorOption func(*error)

func WithValidation(validate func() error) errorOption {
    return func(err *error) {
        if *err != nil {
            return
        }
        *err = validate()
    }
}

func WithTransaction(tx *sql.Tx) errorOption {
    return func(err *error) {
        if *err != nil {
            tx.Rollback()
            return
        }
        *err = tx.Commit()
    }
}

func ProcessOrder(order Order, opts ...errorOption) error {
    var err error
    
    // Apply all error options
    for _, opt := range opts {
        opt(&err)
        if err != nil {
            return err
        }
    }
    
    // Process the order if no errors occurred
    return nil
}

// Usage
err := ProcessOrder(order,
    WithValidation(func() error {
        if order.Amount <= 0 {
            return errors.New("order amount must be positive")
        }
        return nil
    }),
    WithTransaction(tx),
)
```

## Practical Error Handling Patterns

### HTTP Error Handling

For web applications, consistent error handling is crucial. Here's a pattern that works well:

```go
type ErrorResponse struct {
    Status  int    `json:"status"`
    Message string `json:"message"`
    Error   string `json:"error,omitempty"`
}

func WriteError(w http.ResponseWriter, status int, message string, err error) {
    resp := ErrorResponse{
        Status:  status,
        Message: message,
    }
    
    if err != nil {
        resp.Error = err.Error()
    }
    
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(resp)
}

// Usage in a handler
func GetUserHandler(w http.ResponseWriter, r *http.Request) {
    id := chi.URLParam(r, "id")
    
    user, err := userService.GetUser(id)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            WriteError(w, http.StatusNotFound, "User not found", err)
            return
        }
        WriteError(w, http.StatusInternalServerError, "Failed to get user", err)
        return
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
}
```

For more advanced HTTP error handling, middleware can be helpful:

```go
func ErrorMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Create a custom response writer that captures the status code
        crw := &customResponseWriter{ResponseWriter: w, status: http.StatusOK}
        
        // Recover from panics
        defer func() {
            if rec := recover(); rec != nil {
                err, ok := rec.(error)
                if !ok {
                    err = fmt.Errorf("%v", rec)
                }
                
                stack := string(debug.Stack())
                log.Printf("Panic: %v\n%s", err, stack)
                
                if crw.status == http.StatusOK {
                    crw.status = http.StatusInternalServerError
                }
                
                WriteError(crw, crw.status, "Internal server error", err)
            }
        }()
        
        // Call the next handler
        next.ServeHTTP(crw, r)
    })
}
```

### Database Error Handling

Database operations have specific error patterns:

```go
func GetUser(ctx context.Context, id string) (*User, error) {
    var user User
    err := db.GetContext(ctx, &user, "SELECT * FROM users WHERE id = ?", id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, fmt.Errorf("user %s not found: %w", id, ErrNotFound)
        }
        return nil, fmt.Errorf("database error: %w", err)
    }
    return &user, nil
}
```

### API Client Error Handling

When writing clients for external APIs, structure your error handling for clear diagnostics:

```go
type APIError struct {
    StatusCode int
    URL        string
    Message    string
    Body       string
}

func (e *APIError) Error() string {
    return fmt.Sprintf("API error [%d] on %s: %s", e.StatusCode, e.URL, e.Message)
}

func (c *Client) Get(ctx context.Context, url string, result interface{}) error {
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return fmt.Errorf("creating request: %w", err)
    }
    
    resp, err := c.httpClient.Do(req)
    if err != nil {
        return fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()
    
    if resp.StatusCode >= 400 {
        body, _ := io.ReadAll(resp.Body)
        return &APIError{
            StatusCode: resp.StatusCode,
            URL:        url,
            Message:    resp.Status,
            Body:       string(body),
        }
    }
    
    if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
        return fmt.Errorf("decoding response: %w", err)
    }
    
    return nil
}
```

## Error Handling in Concurrent Code

Error handling in goroutines requires special consideration since you can't simply return an error from a goroutine.

### Using Error Channels

```go
func processItems(items []Item) error {
    errs := make(chan error, len(items))
    
    var wg sync.WaitGroup
    for _, item := range items {
        wg.Add(1)
        go func(item Item) {
            defer wg.Done()
            if err := processItem(item); err != nil {
                errs <- err
            }
        }(item)
    }
    
    // Wait for all goroutines to complete
    wg.Wait()
    close(errs)
    
    // Collect errors
    var errList []error
    for err := range errs {
        errList = append(errList, err)
    }
    
    if len(errList) > 0 {
        return errors.Join(errList...)
    }
    
    return nil
}
```

### Using errgroup

The `golang.org/x/sync/errgroup` package provides a cleaner way to handle errors in concurrent code:

```go
import "golang.org/x/sync/errgroup"

func processItems(ctx context.Context, items []Item) error {
    g, ctx := errgroup.WithContext(ctx)
    
    for _, item := range items {
        item := item // Create a new variable to avoid closure capture issues
        g.Go(func() error {
            return processItem(ctx, item)
        })
    }
    
    // Wait for all goroutines to complete or return on first error
    if err := g.Wait(); err != nil {
        return fmt.Errorf("processing items: %w", err)
    }
    
    return nil
}
```

The `errgroup` package stops all goroutines as soon as one returns an error, using the provided context.

## Handling Panics

While Go's error handling is explicit, panics can still occur for truly exceptional situations. It's important to handle them gracefully:

```go
func RecoverMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                err, ok := rec.(error)
                if !ok {
                    err = fmt.Errorf("%v", rec)
                }
                
                stack := string(debug.Stack())
                log.Printf("Panic: %v\n%s", err, stack)
                
                http.Error(w, "Internal Server Error", http.StatusInternalServerError)
            }
        }()
        
        next.ServeHTTP(w, r)
    })
}
```

For background jobs or critical goroutines:

```go
func SafeGoroutine(f func()) {
    go func() {
        defer func() {
            if rec := recover(); rec != nil {
                err, ok := rec.(error)
                if !ok {
                    err = fmt.Errorf("%v", rec)
                }
                
                stack := string(debug.Stack())
                log.Printf("Panic in goroutine: %v\n%s", err, stack)
            }
        }()
        
        f()
    }()
}

// Usage
SafeGoroutine(func() {
    // Do some work that might panic
})
```

## Best Practices for Go Error Handling

Based on the patterns we've covered, here are some best practices for error handling in Go:

1. **Be Explicit**: Always check and handle errors explicitly. Don't ignore them with `_`.

2. **Add Context**: When returning errors, add context with `fmt.Errorf("operation failed: %w", err)`.

3. **Use Sentinel Errors** for specific error conditions that callers might need to check.

4. **Create Custom Error Types** for complex error scenarios that need additional information.

5. **Use `errors.Is` and `errors.As`** for checking wrapped errors, not direct equality (`==`).

6. **Handle Errors Once**: Handle each error in exactly one place—either log it or return it, not both.

7. **Don't Panic**: Treat `panic` as a last resort for truly unrecoverable situations.

8. **Create Helper Functions** for common error handling patterns to reduce boilerplate.

9. **Use Middleware** for consistent error handling across HTTP handlers.

10. **Test Error Paths**: Ensure you have test coverage for error conditions, not just happy paths.

## Common Error Handling Anti-Patterns to Avoid

While we've covered many good practices, here are some anti-patterns to avoid:

1. **Ignoring Errors**: Don't discard errors with `_` unless you have a specific reason.
   ```go
   // Bad
   file, _ := os.Open("file.txt")
   
   // Good
   file, err := os.Open("file.txt")
   if err != nil {
       // Handle error
   }
   ```

2. **Shadowing Errors**: Don't declare new variables with the same name in if blocks.
   ```go
   // Bad - err is redeclared in the if scope
   if err := doSomething(); err != nil {
       // This err shadows the outer err
       if err := doSomethingElse(); err != nil {
           return err // Only returns the inner error
       }
   }
   
   // Good
   if err := doSomething(); err != nil {
       if innerErr := doSomethingElse(); innerErr != nil {
           return fmt.Errorf("nested error: %w", innerErr)
       }
       return err
   }
   ```

3. **Using Panics for Normal Flow Control**: Panics should be reserved for truly exceptional cases.
   ```go
   // Bad
   func getUser(id string) *User {
       user, found := userDB[id]
       if !found {
           panic("user not found")
       }
       return user
   }
   
   // Good
   func getUser(id string) (*User, error) {
       user, found := userDB[id]
       if !found {
           return nil, ErrNotFound
       }
       return user, nil
   }
   ```

4. **Excessive Wrapping**: Don't add too many layers of wrapping to errors.
   ```go
   // Bad - too many layers
   if err := doSomething(); err != nil {
       return fmt.Errorf("layer1: %w", fmt.Errorf("layer2: %w", fmt.Errorf("layer3: %w", err)))
   }
   
   // Good - one meaningful layer is enough
   if err := doSomething(); err != nil {
       return fmt.Errorf("operation failed: %w", err)
   }
   ```

5. **Both Logging and Returning**: Don't both log and return the same error.
   ```go
   // Bad - double handling
   if err := doSomething(); err != nil {
       log.Printf("Failed: %v", err)
       return err
   }
   
   // Good - either log and handle or return
   if err := doSomething(); err != nil {
       // Handle locally
       log.Printf("Failed: %v", err)
       // Return a different error or nil
       return nil
   }
   
   // Or
   if err := doSomething(); err != nil {
       // Add context and propagate up
       return fmt.Errorf("operation failed: %w", err)
   }
   ```

## Conclusion

Go's approach to error handling reflects its philosophy of simplicity and explicitness. While it may seem verbose initially, explicit error handling prevents surprises, improves code clarity, and forces developers to think about error conditions upfront.

As you've seen from the patterns in this guide, there are many ways to make error handling in Go more efficient and expressive without sacrificing these principles. By embracing Go's error handling model and applying these patterns, you can write code that is both robust and maintainable.

Remember, good error handling isn't just about catching failures—it's about providing clear information that helps users and developers understand what went wrong and how to fix it. In Go, errors are just values, but with the right approaches, they can be powerful tools for building reliable software.