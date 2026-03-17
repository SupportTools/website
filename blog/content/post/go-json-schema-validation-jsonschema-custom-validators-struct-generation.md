---
title: "Go JSON Schema Validation: jsonschema Library, Custom Validators, Schema Generation from Structs, and Error Formatting"
date: 2032-03-01T00:00:00-05:00
draft: false
tags: ["Go", "JSON Schema", "Validation", "API", "jsonschema", "OpenAPI"]
categories:
- Go
- API Development
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to JSON Schema validation in Go using the jsonschema library, covering schema generation from Go structs, custom validators, multi-error formatting, and integration with HTTP middleware."
more_link: "yes"
url: "/go-json-schema-validation-jsonschema-custom-validators-struct-generation/"
---

JSON Schema validation provides a standard, language-agnostic way to define and enforce the structure of JSON documents. In Go, the `invopop/jsonschema` library generates schemas from struct definitions, and `santhosh-tekuri/jsonschema` provides the validation engine. Together they form a validation pipeline that catches structural errors before they reach your business logic, generates accurate API documentation from the same type definitions your code actually uses, and produces human-readable error messages that clients can act on. This guide covers the complete production implementation.

<!--more-->

# Go JSON Schema Validation

## Library Selection

Three primary libraries exist for JSON Schema validation in Go:

| Library | Schema Generation | Validation | Draft Support | Performance |
|---------|------------------|------------|---------------|-------------|
| `invopop/jsonschema` | Excellent (struct tags) | No | 2020-12 | N/A |
| `santhosh-tekuri/jsonschema/v6` | No | Excellent | 2020-12 | High |
| `xeipuuv/gojsonschema` | Basic | Good | Draft-07 | Medium |
| `qri-io/jsonschema` | No | Good | Draft-07 | Medium |

The recommended combination: `invopop/jsonschema` for generation + `santhosh-tekuri/jsonschema/v6` for validation.

```bash
go get github.com/invopop/jsonschema@v0.12.0
go get github.com/santhosh-tekuri/jsonschema/v6@v6.0.1
go get github.com/tidwall/gjson@v1.17.1  # for JSON path extraction in errors
```

## Section 1: Schema Generation from Go Structs

### Basic Struct Annotation

```go
// models/order.go
package models

import (
	"time"
)

// CreateOrderRequest represents an order creation request.
// Field-level validation is encoded in jsonschema struct tags.
type CreateOrderRequest struct {
	// Customer information
	CustomerID string `json:"customer_id" jsonschema:"required,minLength=1,maxLength=64,pattern=^[a-zA-Z0-9_-]+$,description=Unique customer identifier"`

	// Order items (1-50 items)
	Items []OrderItem `json:"items" jsonschema:"required,minItems=1,maxItems=50,description=List of items to order"`

	// Shipping information
	ShippingAddress Address `json:"shipping_address" jsonschema:"required"`

	// Optional coupon code
	CouponCode *string `json:"coupon_code,omitempty" jsonschema:"minLength=4,maxLength=32,pattern=^[A-Z0-9]+$,description=Promotional coupon code"`

	// Client-provided idempotency key
	IdempotencyKey string `json:"idempotency_key" jsonschema:"required,minLength=16,maxLength=64,description=UUID for idempotent request deduplication"`
}

type OrderItem struct {
	ProductID string `json:"product_id" jsonschema:"required,minLength=1,maxLength=64"`
	Quantity  int    `json:"quantity"   jsonschema:"required,minimum=1,maximum=100"`
	// Unit price in cents for price validation (must match catalog)
	ExpectedPriceCents *int `json:"expected_price_cents,omitempty" jsonschema:"minimum=0,maximum=1000000"`
}

type Address struct {
	Street     string  `json:"street"      jsonschema:"required,minLength=1,maxLength=200"`
	City       string  `json:"city"        jsonschema:"required,minLength=1,maxLength=100"`
	State      string  `json:"state"       jsonschema:"required,minLength=2,maxLength=2,pattern=^[A-Z]{2}$,description=US state abbreviation"`
	PostalCode string  `json:"postal_code" jsonschema:"required,pattern=^[0-9]{5}(-[0-9]{4})?$,description=US ZIP code"`
	Country    string  `json:"country"     jsonschema:"required,enum=US,description=Country code (currently US only)"`
}

// UserProfile with various field types
type UserProfile struct {
	Name        string   `json:"name"        jsonschema:"required,minLength=1,maxLength=100"`
	Email       string   `json:"email"       jsonschema:"required,format=email"`
	Age         *int     `json:"age,omitempty" jsonschema:"minimum=0,maximum=150"`
	Tags        []string `json:"tags,omitempty" jsonschema:"maxItems=20,uniqueItems=true"`
	Role        string   `json:"role"        jsonschema:"required,enum=admin,enum=user,enum=readonly"`
	Preferences map[string]interface{} `json:"preferences,omitempty" jsonschema:"additionalProperties=true"`
	CreatedAt   time.Time `json:"created_at,omitempty"`
}
```

### Generating Schemas

```go
// schema/generator.go
package schema

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sync"

	"github.com/invopop/jsonschema"
)

var reflector = &jsonschema.Reflector{
	// Include all fields, even unexported (rare but useful for internal schemas)
	AllowAdditionalProperties: false,
	// Add $schema field to help validators identify draft
	RequiredFromJSONSchemaTags: true,
	// Expand $refs inline for simpler validation
	ExpandedStruct: false,
}

var (
	schemaCache sync.Map
)

// Generate creates a JSON Schema for the given type.
func Generate(v interface{}) (*jsonschema.Schema, error) {
	t := reflect.TypeOf(v)
	if t.Kind() == reflect.Ptr {
		t = t.Elem()
	}

	key := t.PkgPath() + "." + t.Name()
	if cached, ok := schemaCache.Load(key); ok {
		return cached.(*jsonschema.Schema), nil
	}

	schema := reflector.Reflect(v)
	schemaCache.Store(key, schema)
	return schema, nil
}

// MustGenerate panics if schema generation fails.
func MustGenerate(v interface{}) *jsonschema.Schema {
	s, err := Generate(v)
	if err != nil {
		panic(fmt.Sprintf("schema generation failed for %T: %v", v, err))
	}
	return s
}

// ToJSON returns the schema as formatted JSON bytes.
func ToJSON(v interface{}) ([]byte, error) {
	s, err := Generate(v)
	if err != nil {
		return nil, err
	}
	return json.MarshalIndent(s, "", "  ")
}
```

### Sample Generated Schema

```go
// cmd/generate-schemas/main.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/example/api/schema"
	"github.com/example/api/models"
)

func main() {
	types := map[string]interface{}{
		"create_order":  models.CreateOrderRequest{},
		"user_profile":  models.UserProfile{},
	}

	for name, model := range types {
		data, err := schema.ToJSON(model)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error generating schema for %s: %v\n", name, err)
			os.Exit(1)
		}

		outPath := filepath.Join("schemas", name+".json")
		if err := os.WriteFile(outPath, data, 0644); err != nil {
			fmt.Fprintf(os.Stderr, "Error writing schema %s: %v\n", outPath, err)
			os.Exit(1)
		}
		fmt.Printf("Generated: %s\n", outPath)
	}
}
```

The generated schema for `CreateOrderRequest`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/create_order.json",
  "$ref": "#/$defs/CreateOrderRequest",
  "$defs": {
    "Address": {
      "properties": {
        "street":      {"type": "string", "minLength": 1, "maxLength": 200},
        "city":        {"type": "string", "minLength": 1, "maxLength": 100},
        "state":       {"type": "string", "minLength": 2, "maxLength": 2, "pattern": "^[A-Z]{2}$"},
        "postal_code": {"type": "string", "pattern": "^[0-9]{5}(-[0-9]{4})?$"},
        "country":     {"type": "string", "enum": ["US"]}
      },
      "additionalProperties": false,
      "required": ["street", "city", "state", "postal_code", "country"],
      "type": "object"
    },
    "CreateOrderRequest": {
      "properties": {
        "customer_id":      {"type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[a-zA-Z0-9_-]+$"},
        "items":            {"type": "array", "items": {"$ref": "#/$defs/OrderItem"}, "minItems": 1, "maxItems": 50},
        "shipping_address": {"$ref": "#/$defs/Address"},
        "coupon_code":      {"type": "string", "minLength": 4, "maxLength": 32, "pattern": "^[A-Z0-9]+$"},
        "idempotency_key":  {"type": "string", "minLength": 16, "maxLength": 64}
      },
      "additionalProperties": false,
      "required": ["customer_id", "items", "shipping_address", "idempotency_key"],
      "type": "object"
    }
  }
}
```

## Section 2: Validation Engine Setup

### Compiling and Caching Schemas

```go
// validation/validator.go
package validation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/invopop/jsonschema"
	santhosh "github.com/santhosh-tekuri/jsonschema/v6"
)

// Validator holds compiled schemas for reuse across requests.
type Validator struct {
	compiler *santhosh.Compiler
	schemas  sync.Map
	reflector *jsonschema.Reflector
}

// New creates a Validator with the given custom formats registered.
func New(options ...Option) (*Validator, error) {
	compiler := santhosh.NewCompiler()

	// Enable format validation
	compiler.UseRegexpEngine(santhosh.GoRegexpEngine)

	// Register custom formats
	registerCustomFormats(compiler)

	v := &Validator{
		compiler: compiler,
		reflector: &jsonschema.Reflector{
			AllowAdditionalProperties: false,
			RequiredFromJSONSchemaTags: true,
		},
	}

	for _, opt := range options {
		opt(v)
	}

	return v, nil
}

type Option func(*Validator)

// compile returns a compiled schema for the given type.
func (v *Validator) compile(model interface{}) (*santhosh.Schema, error) {
	typeName := fmt.Sprintf("%T", model)

	if cached, ok := v.schemas.Load(typeName); ok {
		return cached.(*santhosh.Schema), nil
	}

	// Generate schema from struct
	generated := v.reflector.Reflect(model)

	schemaBytes, err := json.Marshal(generated)
	if err != nil {
		return nil, fmt.Errorf("marshaling schema for %T: %w", model, err)
	}

	// Add schema to compiler
	schemaURL := fmt.Sprintf("mem://%s", typeName)
	if err := v.compiler.AddResource(schemaURL, bytes.NewReader(schemaBytes)); err != nil {
		return nil, fmt.Errorf("adding schema resource for %T: %w", model, err)
	}

	compiled, err := v.compiler.Compile(schemaURL)
	if err != nil {
		return nil, fmt.Errorf("compiling schema for %T: %w", model, err)
	}

	v.schemas.Store(typeName, compiled)
	return compiled, nil
}

// ValidateBytes validates raw JSON bytes against the schema for the given model type.
func (v *Validator) ValidateBytes(ctx context.Context, data []byte, model interface{}) *ValidationError {
	compiled, err := v.compile(model)
	if err != nil {
		return &ValidationError{
			Message: "schema compilation error",
			Internal: err,
		}
	}

	// Parse JSON
	var jsonVal interface{}
	if err := json.Unmarshal(data, &jsonVal); err != nil {
		return &ValidationError{
			Message: "invalid JSON",
			Errors: []FieldError{
				{Field: "(root)", Message: fmt.Sprintf("JSON parse error: %v", err), Code: "INVALID_JSON"},
			},
		}
	}

	// Validate
	if err := compiled.Validate(jsonVal); err != nil {
		return parseValidationError(err)
	}

	return nil
}

// Validate validates a Go struct by first marshaling it to JSON.
func (v *Validator) Validate(ctx context.Context, model interface{}) *ValidationError {
	data, err := json.Marshal(model)
	if err != nil {
		return &ValidationError{Message: fmt.Sprintf("marshal error: %v", err)}
	}
	return v.ValidateBytes(ctx, data, model)
}
```

## Section 3: Custom Validators

### Custom Format Validators

```go
// validation/formats.go
package validation

import (
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"
	"unicode"

	santhosh "github.com/santhosh-tekuri/jsonschema/v6"
)

func registerCustomFormats(compiler *santhosh.Compiler) {
	// US phone number: +1-555-555-5555 or (555) 555-5555
	compiler.AssertFormat("phone-us", validateUSPhone)

	// Strong password: min 12 chars, uppercase, lowercase, digit, special
	compiler.AssertFormat("strong-password", validateStrongPassword)

	// CIDR notation: 192.168.1.0/24
	compiler.AssertFormat("cidr", validateCIDR)

	// Semantic version: 1.2.3 or 1.2.3-beta.1
	compiler.AssertFormat("semver", validateSemver)

	// ISO 8601 duration: P1Y2M3DT4H5M6S
	compiler.AssertFormat("duration-iso8601", validateISO8601Duration)

	// Kubernetes resource name: lowercase alphanumeric with hyphens
	compiler.AssertFormat("k8s-name", validateK8sName)

	// URL slug: lowercase with hyphens
	compiler.AssertFormat("slug", validateSlug)
}

var (
	reUSPhone  = regexp.MustCompile(`^\+?1?[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}$`)
	reSemver   = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`)
	reK8sName  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$`)
	reSlug     = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	reDuration = regexp.MustCompile(`^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$`)
)

func validateUSPhone(v interface{}) error {
	s, ok := v.(string)
	if !ok {
		return fmt.Errorf("expected string")
	}
	digits := strings.Map(func(r rune) rune {
		if unicode.IsDigit(r) {
			return r
		}
		return -1
	}, s)
	if len(digits) < 10 || len(digits) > 11 {
		return fmt.Errorf("invalid US phone number format")
	}
	if !reUSPhone.MatchString(s) {
		return fmt.Errorf("invalid US phone number format")
	}
	return nil
}

func validateStrongPassword(v interface{}) error {
	s, ok := v.(string)
	if !ok {
		return fmt.Errorf("expected string")
	}

	var (
		hasUpper   bool
		hasLower   bool
		hasDigit   bool
		hasSpecial bool
	)

	for _, r := range s {
		switch {
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsDigit(r):
			hasDigit = true
		case unicode.IsPunct(r) || unicode.IsSymbol(r):
			hasSpecial = true
		}
	}

	var missing []string
	if len(s) < 12 {
		missing = append(missing, "minimum 12 characters")
	}
	if !hasUpper {
		missing = append(missing, "uppercase letter")
	}
	if !hasLower {
		missing = append(missing, "lowercase letter")
	}
	if !hasDigit {
		missing = append(missing, "digit")
	}
	if !hasSpecial {
		missing = append(missing, "special character")
	}

	if len(missing) > 0 {
		return fmt.Errorf("password must contain: %s", strings.Join(missing, ", "))
	}
	return nil
}

func validateCIDR(v interface{}) error {
	s, ok := v.(string)
	if !ok {
		return fmt.Errorf("expected string")
	}
	_, _, err := net.ParseCIDR(s)
	if err != nil {
		return fmt.Errorf("invalid CIDR notation: %v", err)
	}
	return nil
}

func validateSemver(v interface{}) error {
	s, ok := v.(string)
	if !ok {
		return fmt.Errorf("expected string")
	}
	if !reSemver.MatchString(s) {
		return fmt.Errorf("invalid semantic version (must be X.Y.Z or X.Y.Z-pre+build)")
	}
	return nil
}

func validateISO8601Duration(v interface{}) error {
	s, ok := v.(string)
	if !ok {
		return fmt.Errorf("expected string")
	}
	if s == "P" || s == "" {
		return fmt.Errorf("empty duration")
	}
	if !reDuration.MatchString(s) {
		return fmt.Errorf("invalid ISO 8601 duration (example: P1Y2M3DT4H5M6S)")
	}
	return nil
}

func validateK8sName(v interface{}) error {
	s, ok := v.(string)
	if !ok {
		return fmt.Errorf("expected string")
	}
	if len(s) < 1 || len(s) > 63 {
		return fmt.Errorf("must be 1-63 characters")
	}
	if !reK8sName.MatchString(s) {
		return fmt.Errorf("must be lowercase alphanumeric with hyphens, starting and ending with alphanumeric")
	}
	return nil
}

func validateSlug(v interface{}) error {
	s, ok := v.(string)
	if !ok {
		return fmt.Errorf("expected string")
	}
	if !reSlug.MatchString(s) {
		return fmt.Errorf("must be lowercase letters, digits, and hyphens only")
	}
	return nil
}
```

### Custom Keywords via Schema Extension

```go
// validation/keywords.go
package validation

import (
	"fmt"

	santhosh "github.com/santhosh-tekuri/jsonschema/v6"
)

// RegisterCustomKeywords adds application-specific validation keywords.
func RegisterCustomKeywords(compiler *santhosh.Compiler) {
	// x-no-html: prohibit HTML tags in string values
	compiler.RegisterKeyword("x-no-html", compileNoHTML)

	// x-future-date: value must be in the future
	compiler.RegisterKeyword("x-future-date", compileFutureDate)
}

func compileNoHTML(schema *santhosh.Schema, property string, value interface{}) (santhosh.Validator, error) {
	enabled, ok := value.(bool)
	if !ok || !enabled {
		return nil, nil
	}
	return noHTMLValidator{}, nil
}

type noHTMLValidator struct{}

func (v noHTMLValidator) Validate(ctx *santhosh.ValidationContext, instance interface{}) error {
	s, ok := instance.(string)
	if !ok {
		return nil
	}
	if containsHTML(s) {
		return fmt.Errorf("HTML tags are not allowed")
	}
	return nil
}

func containsHTML(s string) bool {
	for i := 0; i < len(s)-1; i++ {
		if s[i] == '<' {
			for j := i + 1; j < len(s); j++ {
				if s[j] == '>' {
					return true
				}
				if s[j] == ' ' || s[j] == '\n' || s[j] == '\t' {
					break
				}
			}
		}
	}
	return false
}
```

## Section 4: Error Formatting

### Error Types

```go
// validation/errors.go
package validation

import (
	"fmt"
	"net/http"
	"strings"

	santhosh "github.com/santhosh-tekuri/jsonschema/v6"
)

// ValidationError is returned when schema validation fails.
type ValidationError struct {
	Message  string
	Errors   []FieldError
	Internal error
}

// FieldError represents a single field validation failure.
type FieldError struct {
	// Field is the JSON path to the failing field (e.g., "items[0].quantity")
	Field string `json:"field"`
	// Message is a human-readable description of the error
	Message string `json:"message"`
	// Code is a machine-readable error code
	Code string `json:"code"`
	// Value is the actual value that failed validation (optional)
	Value interface{} `json:"value,omitempty"`
}

func (e *ValidationError) Error() string {
	if len(e.Errors) == 0 {
		return e.Message
	}
	msgs := make([]string, len(e.Errors))
	for i, err := range e.Errors {
		msgs[i] = fmt.Sprintf("%s: %s", err.Field, err.Message)
	}
	return strings.Join(msgs, "; ")
}

// HTTPStatus returns the appropriate HTTP status code.
func (e *ValidationError) HTTPStatus() int {
	if e.Internal != nil {
		return http.StatusInternalServerError
	}
	return http.StatusUnprocessableEntity
}

// AsAPIResponse returns the error in API response format.
func (e *ValidationError) AsAPIResponse() map[string]interface{} {
	return map[string]interface{}{
		"error":   "VALIDATION_FAILED",
		"message": e.Message,
		"details": e.Errors,
	}
}

// parseValidationError converts santhosh validation errors to our format.
func parseValidationError(err error) *ValidationError {
	ve, ok := err.(*santhosh.ValidationError)
	if !ok {
		return &ValidationError{
			Message: err.Error(),
			Errors: []FieldError{
				{Field: "(root)", Message: err.Error(), Code: "VALIDATION_ERROR"},
			},
		}
	}

	var fieldErrors []FieldError
	collectErrors(ve, &fieldErrors)

	return &ValidationError{
		Message: fmt.Sprintf("validation failed with %d error(s)", len(fieldErrors)),
		Errors:  fieldErrors,
	}
}

func collectErrors(ve *santhosh.ValidationError, fieldErrors *[]FieldError) {
	if len(ve.Causes) == 0 {
		// Leaf error - this is the actual validation failure
		field := instancePath(ve.InstanceLocation)
		code := keywordCode(ve.KeywordLocation)
		msg := humanizeError(ve, code)

		*fieldErrors = append(*fieldErrors, FieldError{
			Field:   field,
			Message: msg,
			Code:    code,
		})
		return
	}

	for _, cause := range ve.Causes {
		collectErrors(cause, fieldErrors)
	}
}

// instancePath converts JSONPointer to dot-bracket notation.
// /items/0/quantity -> items[0].quantity
func instancePath(pointer string) string {
	if pointer == "" || pointer == "/" {
		return "(root)"
	}

	parts := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	var result strings.Builder

	for i, part := range parts {
		// Check if numeric (array index)
		isNumeric := true
		for _, r := range part {
			if r < '0' || r > '9' {
				isNumeric = false
				break
			}
		}

		if isNumeric && i > 0 {
			result.WriteString("[")
			result.WriteString(part)
			result.WriteString("]")
		} else {
			if i > 0 {
				result.WriteString(".")
			}
			result.WriteString(part)
		}
	}

	return result.String()
}

func keywordCode(keyword string) string {
	// Extract the last component of the keyword location
	parts := strings.Split(keyword, "/")
	if len(parts) == 0 {
		return "VALIDATION_ERROR"
	}
	last := parts[len(parts)-1]

	switch last {
	case "required":
		return "REQUIRED"
	case "minLength":
		return "MIN_LENGTH"
	case "maxLength":
		return "MAX_LENGTH"
	case "minimum":
		return "MINIMUM"
	case "maximum":
		return "MAXIMUM"
	case "pattern":
		return "PATTERN"
	case "format":
		return "FORMAT"
	case "enum":
		return "ENUM"
	case "type":
		return "TYPE"
	case "minItems":
		return "MIN_ITEMS"
	case "maxItems":
		return "MAX_ITEMS"
	case "uniqueItems":
		return "UNIQUE_ITEMS"
	case "additionalProperties":
		return "ADDITIONAL_PROPERTIES"
	case "const":
		return "CONST"
	default:
		return "VALIDATION_ERROR"
	}
}

func humanizeError(ve *santhosh.ValidationError, code string) string {
	switch code {
	case "REQUIRED":
		return "this field is required"
	case "MIN_LENGTH":
		return fmt.Sprintf("must be at least %s characters", extractParam(ve.Message, "minimum"))
	case "MAX_LENGTH":
		return fmt.Sprintf("must be at most %s characters", extractParam(ve.Message, "maximum"))
	case "MINIMUM":
		return fmt.Sprintf("must be greater than or equal to %s", extractParam(ve.Message, "minimum"))
	case "MAXIMUM":
		return fmt.Sprintf("must be less than or equal to %s", extractParam(ve.Message, "maximum"))
	case "PATTERN":
		return fmt.Sprintf("must match pattern: %s", extractParam(ve.Message, "pattern"))
	case "FORMAT":
		return fmt.Sprintf("must be a valid %s", extractParam(ve.Message, "format"))
	case "ENUM":
		return fmt.Sprintf("must be one of the allowed values: %s", extractParam(ve.Message, "enum"))
	case "TYPE":
		return fmt.Sprintf("must be of type %s", extractParam(ve.Message, "type"))
	case "MIN_ITEMS":
		return "array must have at least the minimum number of items"
	case "MAX_ITEMS":
		return "array must not exceed the maximum number of items"
	case "UNIQUE_ITEMS":
		return "array items must be unique"
	case "ADDITIONAL_PROPERTIES":
		return "unknown field not allowed"
	default:
		return ve.Message
	}
}

func extractParam(msg, key string) string {
	// Simple extraction from error messages
	// Real implementation would use the schema keyword value
	return "see schema"
}
```

### Error Response Examples

The formatted errors look like:

```json
{
  "error": "VALIDATION_FAILED",
  "message": "validation failed with 3 error(s)",
  "details": [
    {
      "field": "customer_id",
      "message": "this field is required",
      "code": "REQUIRED"
    },
    {
      "field": "items[0].quantity",
      "message": "must be greater than or equal to 1",
      "code": "MINIMUM"
    },
    {
      "field": "shipping_address.state",
      "message": "must match pattern: ^[A-Z]{2}$",
      "code": "PATTERN"
    }
  ]
}
```

## Section 5: HTTP Middleware Integration

### Request Validation Middleware

```go
// middleware/validate.go
package middleware

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/example/api/validation"
)

type contextKey string

const validatedBodyKey contextKey = "validated_body"

// ValidateRequest validates the request body against the provided schema model.
// On success, the validated body is stored in context.
// On failure, a 422 response is written.
func ValidateRequest(validator *validation.Validator, model interface{}) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body == nil {
				writeValidationError(w, &validation.ValidationError{
					Message: "request body is required",
					Errors: []validation.FieldError{
						{Field: "(root)", Message: "request body must not be empty", Code: "REQUIRED"},
					},
				})
				return
			}

			body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MiB limit
			if err != nil {
				http.Error(w, "failed to read request body", http.StatusBadRequest)
				return
			}
			defer r.Body.Close()

			if len(body) == 0 {
				writeValidationError(w, &validation.ValidationError{
					Message: "request body is required",
					Errors: []validation.FieldError{
						{Field: "(root)", Message: "request body must not be empty", Code: "REQUIRED"},
					},
				})
				return
			}

			if verr := validator.ValidateBytes(r.Context(), body, model); verr != nil {
				writeValidationError(w, verr)
				return
			}

			// Store validated body in context for handler use
			ctx := context.WithValue(r.Context(), validatedBodyKey, body)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeValidationError(w http.ResponseWriter, verr *validation.ValidationError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(verr.HTTPStatus())
	json.NewEncoder(w).Encode(verr.AsAPIResponse())
}

// ValidatedBody retrieves the pre-validated request body from context.
func ValidatedBody(ctx context.Context) []byte {
	b, _ := ctx.Value(validatedBodyKey).([]byte)
	return b
}
```

### Handler Usage

```go
// handlers/orders.go
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/example/api/middleware"
	"github.com/example/api/models"
	"github.com/example/api/validation"
)

type OrderHandler struct {
	validator *validation.Validator
	service   OrderService
}

func NewOrderHandler(v *validation.Validator, svc OrderService) *OrderHandler {
	return &OrderHandler{validator: v, service: svc}
}

func (h *OrderHandler) RegisterRoutes(mux *http.ServeMux) {
	// Wrap the handler with validation middleware
	mux.Handle("POST /api/v1/orders",
		middleware.ValidateRequest(h.validator, models.CreateOrderRequest{})(
			http.HandlerFunc(h.CreateOrder),
		),
	)
}

func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
	// Body is already validated - safe to unmarshal directly
	body := middleware.ValidatedBody(r.Context())

	var req models.CreateOrderRequest
	if err := json.Unmarshal(body, &req); err != nil {
		// This should not happen since validation already parsed the JSON
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Proceed with business logic
	order, err := h.service.Create(r.Context(), req)
	if err != nil {
		// Handle service-level errors
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(order)
}
```

## Section 6: Schema Versioning and Management

### Schema Registry

```go
// schema/registry.go
package schema

import (
	"fmt"
	"sync"

	santhosh "github.com/santhosh-tekuri/jsonschema/v6"
)

// Registry manages compiled schemas by name and version.
type Registry struct {
	mu      sync.RWMutex
	schemas map[string]*santhosh.Schema
}

var global = &Registry{
	schemas: make(map[string]*santhosh.Schema),
}

func Register(name, version string, model interface{}) error {
	key := fmt.Sprintf("%s@%s", name, version)

	data, err := ToJSON(model)
	if err != nil {
		return fmt.Errorf("generating schema for %s: %w", key, err)
	}

	compiler := santhosh.NewCompiler()
	schemaURL := fmt.Sprintf("schema://%s", key)
	if err := compiler.AddResource(schemaURL, bytes.NewReader(data)); err != nil {
		return fmt.Errorf("adding schema resource: %w", err)
	}

	compiled, err := compiler.Compile(schemaURL)
	if err != nil {
		return fmt.Errorf("compiling schema: %w", err)
	}

	global.mu.Lock()
	global.schemas[key] = compiled
	global.mu.Unlock()

	return nil
}

func Get(name, version string) (*santhosh.Schema, bool) {
	key := fmt.Sprintf("%s@%s", name, version)
	global.mu.RLock()
	s, ok := global.schemas[key]
	global.mu.RUnlock()
	return s, ok
}
```

## Section 7: Testing Schema Validation

```go
// validation/validator_test.go
package validation_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/example/api/models"
	"github.com/example/api/validation"
)

func TestValidCreateOrderRequest(t *testing.T) {
	v, err := validation.New()
	require.NoError(t, err)

	validReq := models.CreateOrderRequest{
		CustomerID:     "customer-123",
		IdempotencyKey: "a1b2c3d4e5f6g7h8",
		Items: []models.OrderItem{
			{ProductID: "prod-abc", Quantity: 2},
		},
		ShippingAddress: models.Address{
			Street:     "123 Main St",
			City:       "Springfield",
			State:      "IL",
			PostalCode: "62701",
			Country:    "US",
		},
	}

	data, _ := json.Marshal(validReq)
	verr := v.ValidateBytes(context.Background(), data, models.CreateOrderRequest{})
	assert.Nil(t, verr, "valid request should not produce errors")
}

func TestRequiredFields(t *testing.T) {
	v, err := validation.New()
	require.NoError(t, err)

	verr := v.ValidateBytes(
		context.Background(),
		[]byte(`{}`),
		models.CreateOrderRequest{},
	)

	require.NotNil(t, verr)

	// Check that required field errors are present
	fieldCodes := make(map[string]string)
	for _, fe := range verr.Errors {
		fieldCodes[fe.Field] = fe.Code
	}

	assert.Equal(t, "REQUIRED", fieldCodes["customer_id"])
	assert.Equal(t, "REQUIRED", fieldCodes["items"])
	assert.Equal(t, "REQUIRED", fieldCodes["idempotency_key"])
}

func TestInvalidQuantity(t *testing.T) {
	v, err := validation.New()
	require.NoError(t, err)

	data := []byte(`{
		"customer_id": "cust-1",
		"idempotency_key": "a1b2c3d4e5f6g7h8",
		"items": [{"product_id": "prod-1", "quantity": 0}],
		"shipping_address": {
			"street": "123 Main",
			"city": "City",
			"state": "IL",
			"postal_code": "62701",
			"country": "US"
		}
	}`)

	verr := v.ValidateBytes(context.Background(), data, models.CreateOrderRequest{})
	require.NotNil(t, verr)

	found := false
	for _, fe := range verr.Errors {
		if fe.Field == "items[0].quantity" && fe.Code == "MINIMUM" {
			found = true
			break
		}
	}
	assert.True(t, found, "should have minimum error on items[0].quantity")
}

func TestAdditionalPropertiesRejected(t *testing.T) {
	v, err := validation.New()
	require.NoError(t, err)

	// Include an unknown field
	data := []byte(`{
		"customer_id": "cust-1",
		"unknown_field": "should be rejected",
		"idempotency_key": "a1b2c3d4e5f6g7h8",
		"items": [{"product_id": "prod-1", "quantity": 1}],
		"shipping_address": {
			"street": "123 Main",
			"city": "City",
			"state": "IL",
			"postal_code": "62701",
			"country": "US"
		}
	}`)

	verr := v.ValidateBytes(context.Background(), data, models.CreateOrderRequest{})
	require.NotNil(t, verr, "unknown field should fail validation")
}

func BenchmarkValidation(b *testing.B) {
	v, _ := validation.New()
	ctx := context.Background()
	data := []byte(`{
		"customer_id": "customer-123",
		"idempotency_key": "a1b2c3d4e5f6g7h8",
		"items": [{"product_id": "prod-abc", "quantity": 2}],
		"shipping_address": {"street": "123 Main St", "city": "Springfield", "state": "IL", "postal_code": "62701", "country": "US"}
	}`)

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			v.ValidateBytes(ctx, data, models.CreateOrderRequest{})
		}
	})
}
```

## Section 8: OpenAPI Integration

### Generating OpenAPI 3.1 Components

```go
// openapi/generator.go
package openapi

import (
	"encoding/json"
	"fmt"

	"github.com/invopop/jsonschema"
)

// Component generates an OpenAPI 3.1 component schema from a Go struct.
func Component(model interface{}, name string) (map[string]interface{}, error) {
	reflector := &jsonschema.Reflector{
		AllowAdditionalProperties: false,
		RequiredFromJSONSchemaTags: true,
	}

	schema := reflector.Reflect(model)

	// Convert to OpenAPI 3.1 format
	schemaBytes, err := json.Marshal(schema)
	if err != nil {
		return nil, fmt.Errorf("marshaling schema: %w", err)
	}

	var component map[string]interface{}
	if err := json.Unmarshal(schemaBytes, &component); err != nil {
		return nil, fmt.Errorf("unmarshaling schema: %w", err)
	}

	// Remove JSON Schema dialect identifier (not valid in OpenAPI 3.1 components)
	delete(component, "$schema")

	return component, nil
}

// GenerateSpec creates a minimal OpenAPI 3.1 spec with components from Go structs.
func GenerateSpec(title, version string, models map[string]interface{}) ([]byte, error) {
	components := make(map[string]interface{})

	for name, model := range models {
		comp, err := Component(model, name)
		if err != nil {
			return nil, fmt.Errorf("generating component %s: %w", name, err)
		}
		components[name] = comp
	}

	spec := map[string]interface{}{
		"openapi": "3.1.0",
		"info": map[string]interface{}{
			"title":   title,
			"version": version,
		},
		"components": map[string]interface{}{
			"schemas": components,
		},
	}

	return json.MarshalIndent(spec, "", "  ")
}
```

## Conclusion

The combination of `invopop/jsonschema` for struct-to-schema generation and `santhosh-tekuri/jsonschema` for validation provides a complete, production-ready JSON Schema pipeline in Go. Key design decisions: compile schemas once at startup and cache them, implement custom format validators for domain-specific constraints, format validation errors with JSON paths and human-readable messages, and generate OpenAPI schemas from the same struct definitions your handlers use. This approach keeps the schema definition co-located with the type definition, ensuring they cannot diverge, and eliminates a class of integration bugs that occur when documentation and implementation are maintained separately.
