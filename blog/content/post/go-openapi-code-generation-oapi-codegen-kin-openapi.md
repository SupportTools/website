---
title: "Go OpenAPI: Code Generation with oapi-codegen and kin-openapi"
date: 2029-10-26T00:00:00-05:00
draft: false
tags: ["Go", "OpenAPI", "oapi-codegen", "kin-openapi", "API", "Code Generation", "REST"]
categories: ["Go", "API Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to OpenAPI 3.0 spec-first development in Go using oapi-codegen for server/client stub generation, strict mode, middleware integration, request validation, and API versioning strategies."
more_link: "yes"
url: "/go-openapi-code-generation-oapi-codegen-kin-openapi/"
---

Spec-first API development has become the standard approach for building maintainable, well-documented Go services. OpenAPI 3.0 combined with `oapi-codegen` and `kin-openapi` gives Go teams a robust workflow: define the contract once, generate type-safe server and client code, and enforce validation at the boundary. This guide covers the complete lifecycle from spec authoring through strict-mode handlers, middleware integration, and versioning strategies used in production environments.

<!--more-->

# Go OpenAPI: Code Generation with oapi-codegen and kin-openapi

## Section 1: Why Spec-First API Development in Go

The alternative to spec-first development—writing handlers and hoping documentation stays current—breaks down quickly in teams. When the spec is the source of truth, you get:

- Type-safe request and response structs generated from the schema
- Compile-time detection of handler signature mismatches
- Client SDKs that stay synchronized with the server automatically
- Automatic request validation without hand-written middleware
- OpenAPI docs that are always accurate

The Go ecosystem has converged on two complementary libraries: `oapi-codegen` for code generation and `kin-openapi` (the underlying validation engine) for runtime schema enforcement.

### Tool Versions

This guide uses:
- `github.com/oapi-codegen/oapi-codegen/v2` v2.3.0
- `github.com/getkin/kin-openapi/openapi3` v0.127.0
- `github.com/getkin/kin-openapi/openapi3filter` for request/response validation

```bash
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest
```

## Section 2: Authoring the OpenAPI 3.0 Specification

A well-structured spec uses `$ref` for reusability and separates concerns into components. The following spec models a simple inventory service.

```yaml
# api/openapi.yaml
openapi: "3.0.3"
info:
  title: Inventory Service API
  version: "1.0.0"
  description: Manages product inventory with full CRUD operations
  contact:
    name: Platform Engineering
    email: platform@example.com

servers:
  - url: https://api.example.com/v1
    description: Production
  - url: http://localhost:8080/v1
    description: Local development

paths:
  /products:
    get:
      operationId: listProducts
      summary: List all products
      tags: [Products]
      parameters:
        - $ref: '#/components/parameters/PageParam'
        - $ref: '#/components/parameters/PageSizeParam'
        - name: category
          in: query
          schema:
            type: string
            enum: [electronics, clothing, food, other]
      responses:
        "200":
          description: Paginated list of products
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ProductList'
        "400":
          $ref: '#/components/responses/BadRequest'
        "500":
          $ref: '#/components/responses/InternalError'

    post:
      operationId: createProduct
      summary: Create a new product
      tags: [Products]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateProductRequest'
      responses:
        "201":
          description: Product created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Product'
        "400":
          $ref: '#/components/responses/BadRequest'
        "409":
          $ref: '#/components/responses/Conflict'

  /products/{productId}:
    parameters:
      - $ref: '#/components/parameters/ProductIdParam'
    get:
      operationId: getProduct
      summary: Get a product by ID
      tags: [Products]
      responses:
        "200":
          description: Product found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Product'
        "404":
          $ref: '#/components/responses/NotFound'

    put:
      operationId: updateProduct
      summary: Update a product
      tags: [Products]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateProductRequest'
      responses:
        "200":
          description: Product updated
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Product'
        "404":
          $ref: '#/components/responses/NotFound'

    delete:
      operationId: deleteProduct
      summary: Delete a product
      tags: [Products]
      responses:
        "204":
          description: Product deleted
        "404":
          $ref: '#/components/responses/NotFound'

  /products/{productId}/stock:
    parameters:
      - $ref: '#/components/parameters/ProductIdParam'
    patch:
      operationId: adjustStock
      summary: Adjust product stock level
      tags: [Products, Inventory]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/StockAdjustment'
      responses:
        "200":
          description: Stock adjusted
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Product'

components:
  parameters:
    ProductIdParam:
      name: productId
      in: path
      required: true
      schema:
        type: string
        format: uuid

    PageParam:
      name: page
      in: query
      schema:
        type: integer
        minimum: 1
        default: 1

    PageSizeParam:
      name: pageSize
      in: query
      schema:
        type: integer
        minimum: 1
        maximum: 100
        default: 20

  schemas:
    Product:
      type: object
      required: [id, sku, name, price, stock, category, createdAt, updatedAt]
      properties:
        id:
          type: string
          format: uuid
          readOnly: true
        sku:
          type: string
          minLength: 3
          maxLength: 50
          pattern: '^[A-Z0-9-]+$'
        name:
          type: string
          minLength: 1
          maxLength: 200
        description:
          type: string
          maxLength: 2000
        price:
          type: number
          format: float
          minimum: 0
          exclusiveMinimum: true
        stock:
          type: integer
          minimum: 0
        category:
          type: string
          enum: [electronics, clothing, food, other]
        createdAt:
          type: string
          format: date-time
          readOnly: true
        updatedAt:
          type: string
          format: date-time
          readOnly: true

    CreateProductRequest:
      type: object
      required: [sku, name, price, category]
      properties:
        sku:
          type: string
          minLength: 3
          maxLength: 50
          pattern: '^[A-Z0-9-]+$'
        name:
          type: string
          minLength: 1
          maxLength: 200
        description:
          type: string
          maxLength: 2000
        price:
          type: number
          format: float
          minimum: 0
          exclusiveMinimum: true
        category:
          type: string
          enum: [electronics, clothing, food, other]
        initialStock:
          type: integer
          minimum: 0
          default: 0

    UpdateProductRequest:
      type: object
      properties:
        name:
          type: string
          minLength: 1
          maxLength: 200
        description:
          type: string
          maxLength: 2000
        price:
          type: number
          format: float
          minimum: 0
          exclusiveMinimum: true
        category:
          type: string
          enum: [electronics, clothing, food, other]

    StockAdjustment:
      type: object
      required: [delta, reason]
      properties:
        delta:
          type: integer
          description: Positive to add stock, negative to remove
        reason:
          type: string
          enum: [sale, return, damage, restock, correction]
        reference:
          type: string
          description: Order ID or other reference

    ProductList:
      type: object
      required: [items, total, page, pageSize]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/Product'
        total:
          type: integer
        page:
          type: integer
        pageSize:
          type: integer

    Error:
      type: object
      required: [code, message]
      properties:
        code:
          type: string
        message:
          type: string
        details:
          type: object
          additionalProperties: true

  responses:
    BadRequest:
      description: Invalid request parameters or body
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
    Conflict:
      description: Resource already exists
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
    InternalError:
      description: Internal server error
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'

  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

security:
  - BearerAuth: []
```

## Section 3: oapi-codegen Configuration and Code Generation

`oapi-codegen` is driven by a YAML configuration file that controls what it generates. This replaces the old command-line flags approach.

```yaml
# api/codegen.yaml
package: api
generate:
  models: true
  strict-server: true     # Strict mode: compile errors for missing handlers
  client: true
  embedded-spec: true     # Embed spec for runtime validation

output: api/generated.go
output-options:
  skip-fmt: false
  skip-prune: false

import-mapping:
  "openapi.yaml": "github.com/example/inventory/api"
```

Generate the code:

```bash
# From the project root
oapi-codegen --config api/codegen.yaml api/openapi.yaml
```

For more complex projects, separate generation into multiple files:

```yaml
# api/codegen-server.yaml
package: api
generate:
  strict-server: true
output: api/server.gen.go

# api/codegen-client.yaml
package: api
generate:
  client: true
output: api/client.gen.go

# api/codegen-types.yaml
package: api
generate:
  models: true
  embedded-spec: true
output: api/types.gen.go
```

Add a `go generate` directive to automate this:

```go
// api/generate.go
package api

//go:generate oapi-codegen --config codegen-types.yaml openapi.yaml
//go:generate oapi-codegen --config codegen-server.yaml openapi.yaml
//go:generate oapi-codegen --config codegen-client.yaml openapi.yaml
```

Run with:

```bash
go generate ./api/...
```

## Section 4: Strict Mode Server Implementation

Strict mode is the most important feature of modern oapi-codegen. Instead of receiving `http.ResponseWriter` and `*http.Request`, your handlers receive typed request objects and return typed response objects. Missing a handler causes a compile error.

The generated interface looks like:

```go
// This is what oapi-codegen generates (do not edit)
type StrictServerInterface interface {
    ListProducts(ctx context.Context, request ListProductsRequestObject) (ListProductsResponseObject, error)
    CreateProduct(ctx context.Context, request CreateProductRequestObject) (CreateProductResponseObject, error)
    GetProduct(ctx context.Context, request GetProductRequestObject) (GetProductResponseObject, error)
    UpdateProduct(ctx context.Context, request UpdateProductRequestObject) (UpdateProductResponseObject, error)
    DeleteProduct(ctx context.Context, request DeleteProductRequestObject) (DeleteProductResponseObject, error)
    AdjustStock(ctx context.Context, request AdjustStockRequestObject) (AdjustStockResponseObject, error)
}
```

Your implementation:

```go
// internal/handler/product.go
package handler

import (
    "context"
    "errors"
    "time"

    "github.com/google/uuid"
    "github.com/example/inventory/api"
    "github.com/example/inventory/internal/domain"
    "github.com/example/inventory/internal/store"
)

type ProductHandler struct {
    store store.ProductStore
}

func NewProductHandler(s store.ProductStore) *ProductHandler {
    return &ProductHandler{store: s}
}

// Compile-time assertion that ProductHandler implements StrictServerInterface
var _ api.StrictServerInterface = (*ProductHandler)(nil)

func (h *ProductHandler) ListProducts(
    ctx context.Context,
    req api.ListProductsRequestObject,
) (api.ListProductsResponseObject, error) {
    page := 1
    pageSize := 20

    if req.Params.Page != nil {
        page = *req.Params.Page
    }
    if req.Params.PageSize != nil {
        pageSize = *req.Params.PageSize
    }

    var category *string
    if req.Params.Category != nil {
        s := string(*req.Params.Category)
        category = &s
    }

    products, total, err := h.store.List(ctx, store.ListParams{
        Page:     page,
        PageSize: pageSize,
        Category: category,
    })
    if err != nil {
        return nil, err
    }

    items := make([]api.Product, len(products))
    for i, p := range products {
        items[i] = domainToAPI(p)
    }

    return api.ListProducts200JSONResponse(api.ProductList{
        Items:    items,
        Total:    total,
        Page:     page,
        PageSize: pageSize,
    }), nil
}

func (h *ProductHandler) CreateProduct(
    ctx context.Context,
    req api.CreateProductRequestObject,
) (api.CreateProductResponseObject, error) {
    // Body is already validated and deserialized by middleware
    body := req.Body

    initialStock := 0
    if body.InitialStock != nil {
        initialStock = *body.InitialStock
    }

    product, err := h.store.Create(ctx, store.CreateParams{
        SKU:          body.Sku,
        Name:         body.Name,
        Description:  body.Description,
        Price:        float64(body.Price),
        Category:     string(body.Category),
        InitialStock: initialStock,
    })
    if err != nil {
        if errors.Is(err, store.ErrDuplicate) {
            return api.CreateProduct409JSONResponse(api.Error{
                Code:    "CONFLICT",
                Message: "A product with this SKU already exists",
            }), nil
        }
        return nil, err
    }

    return api.CreateProduct201JSONResponse(domainToAPI(product)), nil
}

func (h *ProductHandler) GetProduct(
    ctx context.Context,
    req api.GetProductRequestObject,
) (api.GetProductResponseObject, error) {
    product, err := h.store.GetByID(ctx, req.ProductId.String())
    if err != nil {
        if errors.Is(err, store.ErrNotFound) {
            return api.GetProduct404JSONResponse(api.Error{
                Code:    "NOT_FOUND",
                Message: "Product not found",
            }), nil
        }
        return nil, err
    }

    return api.GetProduct200JSONResponse(domainToAPI(product)), nil
}

func (h *ProductHandler) UpdateProduct(
    ctx context.Context,
    req api.UpdateProductRequestObject,
) (api.UpdateProductResponseObject, error) {
    params := store.UpdateParams{ID: req.ProductId.String()}

    if req.Body.Name != nil {
        params.Name = req.Body.Name
    }
    if req.Body.Price != nil {
        f := float64(*req.Body.Price)
        params.Price = &f
    }
    if req.Body.Category != nil {
        s := string(*req.Body.Category)
        params.Category = &s
    }
    if req.Body.Description != nil {
        params.Description = req.Body.Description
    }

    product, err := h.store.Update(ctx, params)
    if err != nil {
        if errors.Is(err, store.ErrNotFound) {
            return api.UpdateProduct404JSONResponse(api.Error{
                Code:    "NOT_FOUND",
                Message: "Product not found",
            }), nil
        }
        return nil, err
    }

    return api.UpdateProduct200JSONResponse(domainToAPI(product)), nil
}

func (h *ProductHandler) DeleteProduct(
    ctx context.Context,
    req api.DeleteProductRequestObject,
) (api.DeleteProductResponseObject, error) {
    err := h.store.Delete(ctx, req.ProductId.String())
    if err != nil {
        if errors.Is(err, store.ErrNotFound) {
            return api.DeleteProduct404JSONResponse(api.Error{
                Code:    "NOT_FOUND",
                Message: "Product not found",
            }), nil
        }
        return nil, err
    }

    return api.DeleteProduct204Response{}, nil
}

func (h *ProductHandler) AdjustStock(
    ctx context.Context,
    req api.AdjustStockRequestObject,
) (api.AdjustStockResponseObject, error) {
    product, err := h.store.AdjustStock(ctx, store.StockAdjustParams{
        ProductID: req.ProductId.String(),
        Delta:     req.Body.Delta,
        Reason:    string(req.Body.Reason),
        Reference: req.Body.Reference,
    })
    if err != nil {
        if errors.Is(err, store.ErrNotFound) {
            return api.AdjustStock404JSONResponse(api.Error{
                Code:    "NOT_FOUND",
                Message: "Product not found",
            }), nil
        }
        if errors.Is(err, store.ErrInsufficientStock) {
            return api.AdjustStock400JSONResponse(api.Error{
                Code:    "INSUFFICIENT_STOCK",
                Message: "Cannot reduce stock below zero",
            }), nil
        }
        return nil, err
    }

    return api.AdjustStock200JSONResponse(domainToAPI(product)), nil
}

func domainToAPI(p domain.Product) api.Product {
    return api.Product{
        Id:          uuid.MustParse(p.ID),
        Sku:         p.SKU,
        Name:        p.Name,
        Description: &p.Description,
        Price:       float32(p.Price),
        Stock:       p.Stock,
        Category:    api.ProductCategory(p.Category),
        CreatedAt:   p.CreatedAt,
        UpdatedAt:   p.UpdatedAt,
    }
}
```

## Section 5: Middleware Integration and Request Validation

Wire everything together with the validation middleware that uses `kin-openapi`:

```go
// internal/server/server.go
package server

import (
    "context"
    "fmt"
    "log/slog"
    "net/http"

    "github.com/getkin/kin-openapi/openapi3"
    "github.com/getkin/kin-openapi/openapi3filter"
    "github.com/go-chi/chi/v5"
    chimiddleware "github.com/go-chi/chi/v5/middleware"
    nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

    "github.com/example/inventory/api"
    "github.com/example/inventory/internal/handler"
    "github.com/example/inventory/internal/store"
)

type Server struct {
    router http.Handler
    logger *slog.Logger
}

func New(s store.ProductStore, logger *slog.Logger) (*Server, error) {
    // Load and validate the embedded OpenAPI spec
    swagger, err := api.GetSwagger()
    if err != nil {
        return nil, fmt.Errorf("loading swagger spec: %w", err)
    }

    // Clear servers so validation does not check the host
    swagger.Servers = nil

    r := chi.NewRouter()

    // Standard middleware
    r.Use(chimiddleware.RequestID)
    r.Use(chimiddleware.RealIP)
    r.Use(chimiddleware.Recoverer)
    r.Use(requestLogger(logger))
    r.Use(chimiddleware.Compress(5))

    // OpenAPI validation middleware - validates all requests against the spec
    r.Use(nethttpmiddleware.OapiRequestValidatorWithOptions(swagger, &nethttpmiddleware.Options{
        Options: openapi3filter.Options{
            AuthenticationFunc: openapi3filter.NoopAuthenticationFunc,
            // Validate request body
            ExcludeRequestBody:  false,
            // Validate response body in development
            ExcludeResponseBody: true,
        },
        ErrorHandler: validationErrorHandler(logger),
    }))

    // Authentication middleware
    r.Use(jwtAuthMiddleware)

    // Build the strict handler
    productHandler := handler.NewProductHandler(s)
    strictHandler := api.NewStrictHandlerWithOptions(
        productHandler,
        []api.StrictMiddlewareFunc{
            errorMappingMiddleware(logger),
        },
        api.StrictHTTPServerOptions{
            RequestErrorHandlerFunc:  requestErrorHandler(logger),
            ResponseErrorHandlerFunc: responseErrorHandler(logger),
        },
    )

    // Register routes
    r.Route("/v1", func(r chi.Router) {
        api.HandlerFromMux(strictHandler, r)
    })

    // Health and readiness endpoints (outside of OpenAPI spec)
    r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ok"))
    })

    return &Server{router: r, logger: logger}, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    s.router.ServeHTTP(w, r)
}

// validationErrorHandler returns a structured JSON error for validation failures
func validationErrorHandler(logger *slog.Logger) nethttpmiddleware.ErrorHandler {
    return func(w http.ResponseWriter, message string, statusCode int) {
        logger.Warn("validation error", "message", message, "status", statusCode)
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(statusCode)
        fmt.Fprintf(w, `{"code":"VALIDATION_ERROR","message":%q}`, message)
    }
}

// errorMappingMiddleware translates domain errors to HTTP responses
func errorMappingMiddleware(logger *slog.Logger) api.StrictMiddlewareFunc {
    return func(f api.StrictHandlerFunc, operationID string) api.StrictHandlerFunc {
        return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request interface{}) (interface{}, error) {
            response, err := f(ctx, w, r, request)
            if err != nil {
                logger.Error("handler error",
                    "operation", operationID,
                    "error", err,
                )
                // Return 500 for unhandled errors
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusInternalServerError)
                fmt.Fprint(w, `{"code":"INTERNAL_ERROR","message":"An unexpected error occurred"}`)
                return nil, nil
            }
            return response, nil
        }
    }
}
```

## Section 6: Custom Validation with kin-openapi

For validation beyond what the spec expresses, use `kin-openapi` directly:

```go
// internal/validation/custom.go
package validation

import (
    "context"
    "fmt"
    "strings"

    "github.com/getkin/kin-openapi/openapi3"
    "github.com/getkin/kin-openapi/openapi3filter"
    "github.com/getkin/kin-openapi/routers/gorillamux"
)

type Validator struct {
    router openapi3filter.Router
}

func NewValidator(spec *openapi3.T) (*Validator, error) {
    router, err := gorillamux.NewRouter(spec)
    if err != nil {
        return nil, fmt.Errorf("creating router: %w", err)
    }
    return &Validator{router: router}, nil
}

// ValidateRequest validates an HTTP request against the OpenAPI spec
func (v *Validator) ValidateRequest(ctx context.Context, r *http.Request) error {
    route, pathParams, err := v.router.FindRoute(r)
    if err != nil {
        return fmt.Errorf("finding route: %w", err)
    }

    input := &openapi3filter.RequestValidationInput{
        Request:    r,
        PathParams: pathParams,
        Route:      route,
        Options: &openapi3filter.Options{
            AuthenticationFunc: openapi3filter.NoopAuthenticationFunc,
        },
    }

    if err := openapi3filter.ValidateRequest(ctx, input); err != nil {
        return formatValidationError(err)
    }

    return nil
}

func formatValidationError(err error) error {
    var reqErr *openapi3filter.RequestError
    if errors.As(err, &reqErr) {
        var schemaErr *openapi3.SchemaError
        if errors.As(reqErr.Err, &schemaErr) {
            return fmt.Errorf("field %s: %s",
                strings.Join(schemaErr.JSONPointer(), "."),
                schemaErr.Reason,
            )
        }
        return fmt.Errorf("request error: %s", reqErr.Error())
    }
    return err
}
```

## Section 7: Generating a Type-Safe Go Client

The same spec generates a client with retry and timeout support:

```go
// internal/client/inventory.go
package client

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/example/inventory/api"
)

type InventoryClient struct {
    client *api.ClientWithResponses
}

func New(baseURL string, opts ...Option) (*InventoryClient, error) {
    cfg := &config{
        timeout:    30 * time.Second,
        maxRetries: 3,
    }
    for _, o := range opts {
        o(cfg)
    }

    httpClient := &http.Client{
        Timeout: cfg.timeout,
        Transport: &retryTransport{
            base:       http.DefaultTransport,
            maxRetries: cfg.maxRetries,
        },
    }

    c, err := api.NewClientWithResponses(
        baseURL,
        api.WithHTTPClient(httpClient),
        api.WithRequestEditorFn(func(ctx context.Context, req *http.Request) error {
            if token, ok := ctx.Value(tokenKey{}).(string); ok {
                req.Header.Set("Authorization", "Bearer "+token)
            }
            return nil
        }),
    )
    if err != nil {
        return nil, err
    }

    return &InventoryClient{client: c}, nil
}

func (c *InventoryClient) GetProduct(ctx context.Context, id string) (*api.Product, error) {
    productID, err := uuid.Parse(id)
    if err != nil {
        return nil, fmt.Errorf("invalid product ID: %w", err)
    }

    resp, err := c.client.GetProductWithResponse(ctx, productID)
    if err != nil {
        return nil, fmt.Errorf("request failed: %w", err)
    }

    switch resp.StatusCode() {
    case 200:
        return resp.JSON200, nil
    case 404:
        return nil, ErrNotFound
    default:
        if resp.JSONDefault != nil {
            return nil, fmt.Errorf("API error %d: %s", resp.StatusCode(), resp.JSONDefault.Message)
        }
        return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode())
    }
}

func (c *InventoryClient) CreateProduct(ctx context.Context, req api.CreateProductRequest) (*api.Product, error) {
    resp, err := c.client.CreateProductWithResponse(ctx, req)
    if err != nil {
        return nil, err
    }

    switch resp.StatusCode() {
    case 201:
        return resp.JSON201, nil
    case 400:
        return nil, fmt.Errorf("bad request: %s", resp.JSON400.Message)
    case 409:
        return nil, ErrDuplicate
    default:
        return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode())
    }
}
```

## Section 8: API Versioning Strategy

Managing multiple API versions requires careful planning. Three strategies work well with oapi-codegen:

### Strategy 1: URL Path Versioning (Recommended)

```
/v1/products   -- stable
/v2/products   -- new version
```

Structure the project:

```
api/
  v1/
    openapi.yaml
    codegen.yaml
    generate.go
    generated.go  (v1 types + server)
  v2/
    openapi.yaml
    codegen.yaml
    generate.go
    generated.go  (v2 types + server)
```

Register both in the router:

```go
// Serve both versions simultaneously during transition
r.Route("/v1", func(r chi.Router) {
    v1api.HandlerFromMux(v1Handler, r)
})
r.Route("/v2", func(r chi.Router) {
    v2api.HandlerFromMux(v2Handler, r)
})
```

### Strategy 2: Spec Extension with Deprecation Markers

```yaml
# In openapi.yaml
paths:
  /products/{productId}/inventory:
    get:
      deprecated: true
      x-sunset: "2030-01-01"
      description: "Deprecated. Use /products/{productId}/stock instead."
```

A middleware can inject the `Sunset` header on deprecated endpoints:

```go
func deprecationMiddleware(swagger *openapi3.T) func(http.Handler) http.Handler {
    deprecated := map[string]string{}
    for path, item := range swagger.Paths.Map() {
        for method, op := range item.Operations() {
            if op.Deprecated {
                if sunset, ok := op.Extensions["x-sunset"].(string); ok {
                    key := method + ":" + path
                    deprecated[key] = sunset
                }
            }
        }
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Match route and inject header
            next.ServeHTTP(w, r)
        })
    }
}
```

### Strategy 3: Contract Testing in CI

Prevent breaking changes with `oasdiff`:

```bash
# Install
go install github.com/tufin/oasdiff@latest

# Check for breaking changes
oasdiff breaking api/v1/openapi.yaml api/v1/openapi-proposed.yaml

# As a CI step
oasdiff breaking --fail-on ERR api/v1/openapi.yaml api/v1/openapi-proposed.yaml
```

## Section 9: Testing Strategies

### Unit Testing Strict Handlers

```go
// internal/handler/product_test.go
package handler_test

import (
    "context"
    "testing"
    "time"

    "github.com/google/uuid"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/example/inventory/api"
    "github.com/example/inventory/internal/handler"
    "github.com/example/inventory/internal/store/mock"
)

func TestGetProduct_Found(t *testing.T) {
    productID := uuid.New()
    mockStore := mock.NewProductStore()
    mockStore.AddProduct(store.Product{
        ID:        productID.String(),
        SKU:       "ELEC-001",
        Name:      "Widget",
        Price:     9.99,
        Stock:     100,
        Category:  "electronics",
        CreatedAt: time.Now(),
        UpdatedAt: time.Now(),
    })

    h := handler.NewProductHandler(mockStore)
    resp, err := h.GetProduct(context.Background(), api.GetProductRequestObject{
        ProductId: productID,
    })

    require.NoError(t, err)
    result, ok := resp.(api.GetProduct200JSONResponse)
    require.True(t, ok, "expected 200 response")
    assert.Equal(t, productID, result.Id)
    assert.Equal(t, "ELEC-001", result.Sku)
}

func TestGetProduct_NotFound(t *testing.T) {
    h := handler.NewProductHandler(mock.NewProductStore())
    resp, err := h.GetProduct(context.Background(), api.GetProductRequestObject{
        ProductId: uuid.New(),
    })

    require.NoError(t, err)
    _, ok := resp.(api.GetProduct404JSONResponse)
    assert.True(t, ok, "expected 404 response")
}
```

### Integration Testing with the Validator

```go
// internal/server/server_test.go
package server_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestCreateProduct_ValidatesRequest(t *testing.T) {
    srv := newTestServer(t)

    // Missing required fields
    body := map[string]interface{}{
        "name": "Widget",
        // Missing: sku, price, category
    }

    data, _ := json.Marshal(body)
    req := httptest.NewRequest(http.MethodPost, "/v1/products", bytes.NewReader(data))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer test-token")

    w := httptest.NewRecorder()
    srv.ServeHTTP(w, req)

    assert.Equal(t, http.StatusBadRequest, w.Code)

    var resp map[string]interface{}
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
    assert.Equal(t, "VALIDATION_ERROR", resp["code"])
}
```

## Section 10: Makefile and CI Integration

```makefile
# Makefile

.PHONY: generate lint test build

generate:
	go generate ./api/...
	# Verify the generated code compiles
	go build ./api/...

# Check that generated code is up to date
check-generate: generate
	git diff --exit-code api/

lint:
	golangci-lint run ./...
	# Validate the OpenAPI spec itself
	vacuum lint api/openapi.yaml --ruleset .vacuum-rules.yaml

# Check for breaking changes against main
breaking-changes:
	oasdiff breaking \
		<(git show main:api/openapi.yaml) \
		api/openapi.yaml \
		--fail-on ERR

test:
	go test -race -coverprofile=coverage.out ./...

build:
	go build -o bin/server ./cmd/server
```

A CI pipeline should:

1. Run `check-generate` to ensure generated code is committed
2. Run `lint` to validate spec and code quality
3. Run `breaking-changes` on PRs to prevent accidental regressions
4. Run `test` with race detection

## Conclusion

The `oapi-codegen` + `kin-openapi` combination provides a compelling spec-first workflow for Go APIs. Strict mode eliminates an entire class of bugs where handler signatures diverge from the spec. The embedded spec enables runtime validation without any additional tooling. Combined with client generation and contract testing, teams can move fast without breaking the contract.

Key takeaways:
- Use strict mode always — the compile-time safety is worth the initial setup
- Embed the spec and validate at the boundary, not deep in business logic
- Version specs in separate directories and test for breaking changes in CI
- Generated clients should handle error mapping to domain types, not expose raw API types

The full example project is available at `github.com/example/inventory` (adjust to your organization's repository).
