---
title: "Go Struct Tags: Custom Marshaling, Validation, and ORM Integration"
date: 2031-04-14T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Struct Tags", "Validation", "GORM", "JSON", "Reflection"]
categories:
- Go
- Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep-dive into Go struct tags covering syntax and reflection-based parsing, advanced encoding/json patterns beyond omitempty, go-playground/validator for struct validation, GORM model tags, mapstructure for config binding, and building a custom tag processor for enterprise use."
more_link: "yes"
url: "/go-struct-tags-custom-marshaling-validation-orm-integration/"
---

Go struct tags are a powerful metaprogramming mechanism that drives JSON serialization, database ORM mapping, configuration binding, and input validation. Despite their widespread use, struct tags are often misunderstood or misused. This guide covers the complete lifecycle from tag syntax to reflection-based processing, advanced JSON patterns, validator integration, GORM model configuration, and building custom tag processors for domain-specific needs.

<!--more-->

# Go Struct Tags: Custom Marshaling, Validation, and ORM Integration

## Section 1: Struct Tag Syntax and Reflection

### Tag Format Specification

Struct tags follow a strict key:"value" format defined by the `reflect` package:

```go
package main

import (
    "fmt"
    "reflect"
)

// Tags follow the format: `key:"value" key2:"value2"`
// Values can contain sub-options separated by commas
type Example struct {
    // Simple tag
    Name string `json:"name"`

    // Multiple options in one key
    Email string `json:"email,omitempty"`

    // Multiple keys
    Age int `json:"age" validate:"required,min=0,max=150" db:"age"`

    // Key with no value (flag pattern)
    ReadOnly bool `json:"readonly" db:"-"`

    // Quoted value
    Description string `json:"description" gorm:"column:description;type:text;not null"`

    // Backtick-encoded complex values
    Config map[string]string `json:"config,omitempty" mapstructure:"config,remain"`
}

// Parsing tags via reflection
func ParseStructTags(v interface{}) {
    t := reflect.TypeOf(v)
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
    }

    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        fmt.Printf("Field: %-20s\n", field.Name)

        // Get the complete tag string
        tag := field.Tag
        fmt.Printf("  Full tag: %q\n", string(tag))

        // Parse individual keys
        if jsonTag := tag.Get("json"); jsonTag != "" {
            fmt.Printf("  json: %q\n", jsonTag)
        }
        if validateTag := tag.Get("validate"); validateTag != "" {
            fmt.Printf("  validate: %q\n", validateTag)
        }
        if dbTag := tag.Get("db"); dbTag != "" {
            fmt.Printf("  db: %q\n", dbTag)
        }
    }
}

// ParseTagOptions parses a comma-separated tag value into name and options
// e.g., "name,omitempty" -> ("name", ["omitempty"])
func ParseTagOptions(tag string) (name string, options []string) {
    parts := strings.Split(tag, ",")
    if len(parts) == 0 {
        return "", nil
    }
    return parts[0], parts[1:]
}
```

### Reflection-Based Tag Processing

```go
package tagprocessor

import (
    "fmt"
    "reflect"
    "strings"
)

// TagProcessor provides utilities for working with struct tags
type TagProcessor struct {
    tag string // the tag key to process
}

func New(tagKey string) *TagProcessor {
    return &TagProcessor{tag: tagKey}
}

// FieldInfo contains parsed information about a struct field
type FieldInfo struct {
    Name      string
    TagValue  string
    TagName   string   // first part before comma
    TagOpts   []string // parts after first comma
    Type      reflect.Type
    Index     int
    Anonymous bool
    Exported  bool
}

// Fields returns all fields of a struct with their tag information
func (p *TagProcessor) Fields(v interface{}) ([]FieldInfo, error) {
    t := reflect.TypeOf(v)
    for t.Kind() == reflect.Ptr {
        t = t.Elem()
    }

    if t.Kind() != reflect.Struct {
        return nil, fmt.Errorf("expected struct, got %v", t.Kind())
    }

    return p.fieldsRecursive(t, nil), nil
}

func (p *TagProcessor) fieldsRecursive(t reflect.Type, index []int) []FieldInfo {
    var fields []FieldInfo

    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        fieldIndex := append(append([]int{}, index...), i)

        // Handle embedded structs
        if field.Anonymous {
            embedded := field.Type
            if embedded.Kind() == reflect.Ptr {
                embedded = embedded.Elem()
            }
            if embedded.Kind() == reflect.Struct {
                // Recursively process embedded struct fields
                embeddedFields := p.fieldsRecursive(embedded, fieldIndex)
                fields = append(fields, embeddedFields...)
                continue
            }
        }

        tagValue := field.Tag.Get(p.tag)
        tagName, tagOpts := parseTagValue(tagValue)

        // Skip fields explicitly excluded with "-"
        if tagName == "-" && len(tagOpts) == 0 {
            continue
        }

        // Use field name if no tag name specified
        if tagName == "" {
            tagName = field.Name
        }

        fields = append(fields, FieldInfo{
            Name:      field.Name,
            TagValue:  tagValue,
            TagName:   tagName,
            TagOpts:   tagOpts,
            Type:      field.Type,
            Index:     i,
            Anonymous: field.Anonymous,
            Exported:  field.IsExported(),
        })
    }

    return fields
}

func parseTagValue(tag string) (name string, opts []string) {
    if tag == "" {
        return "", nil
    }
    parts := strings.Split(tag, ",")
    return parts[0], parts[1:]
}

// HasOption checks if a specific option is present in a field's tag
func (fi *FieldInfo) HasOption(opt string) bool {
    for _, o := range fi.TagOpts {
        if o == opt {
            return true
        }
    }
    return false
}

// GetValue returns the reflect.Value of a field in a struct
func GetFieldValue(v interface{}, fieldIndex int) reflect.Value {
    val := reflect.ValueOf(v)
    if val.Kind() == reflect.Ptr {
        val = val.Elem()
    }
    return val.Field(fieldIndex)
}
```

## Section 2: Advanced encoding/json Patterns

```go
package json

import (
    "bytes"
    "encoding/json"
    "fmt"
    "strings"
    "time"
)

// UnixTimestamp marshals/unmarshals as Unix timestamp integer
type UnixTimestamp struct {
    time.Time
}

func (u UnixTimestamp) MarshalJSON() ([]byte, error) {
    return json.Marshal(u.Unix())
}

func (u *UnixTimestamp) UnmarshalJSON(data []byte) error {
    var ts int64
    if err := json.Unmarshal(data, &ts); err != nil {
        return err
    }
    u.Time = time.Unix(ts, 0)
    return nil
}

// SensitiveString redacts itself when marshaled to JSON
type SensitiveString string

func (s SensitiveString) MarshalJSON() ([]byte, error) {
    return json.Marshal("[REDACTED]")
}

func (s *SensitiveString) UnmarshalJSON(data []byte) error {
    var str string
    if err := json.Unmarshal(data, &str); err != nil {
        return err
    }
    *s = SensitiveString(str)
    return nil
}

// StringSlice handles both "value" and ["value"] JSON forms
type StringSlice []string

func (s *StringSlice) UnmarshalJSON(data []byte) error {
    // Try array form first
    var slice []string
    if err := json.Unmarshal(data, &slice); err == nil {
        *s = slice
        return nil
    }

    // Try single string form
    var str string
    if err := json.Unmarshal(data, &str); err != nil {
        return err
    }
    *s = StringSlice{str}
    return nil
}

// FlexibleBool handles "true", "false", 1, 0, "yes", "no" JSON values
type FlexibleBool bool

func (b *FlexibleBool) UnmarshalJSON(data []byte) error {
    // Try standard bool first
    var boolVal bool
    if err := json.Unmarshal(data, &boolVal); err == nil {
        *b = FlexibleBool(boolVal)
        return nil
    }

    // Try integer
    var intVal int
    if err := json.Unmarshal(data, &intVal); err == nil {
        *b = FlexibleBool(intVal != 0)
        return nil
    }

    // Try string
    var strVal string
    if err := json.Unmarshal(data, &strVal); err != nil {
        return fmt.Errorf("cannot parse bool from: %s", data)
    }

    switch strings.ToLower(strVal) {
    case "true", "yes", "1", "on", "enabled":
        *b = true
    case "false", "no", "0", "off", "disabled":
        *b = false
    default:
        return fmt.Errorf("unrecognized bool value: %s", strVal)
    }
    return nil
}

// Custom JSON marshaling for a complex type
type APIResponse struct {
    Success bool              `json:"success"`
    Data    json.RawMessage   `json:"data,omitempty"`
    Error   *APIError         `json:"error,omitempty"`
    Meta    *ResponseMeta     `json:"meta,omitempty"`
    // Internal fields not exposed in JSON
    internalTrace string
    processedAt   time.Time
}

type APIError struct {
    Code    string            `json:"code"`
    Message string            `json:"message"`
    Details map[string]string `json:"details,omitempty"`
}

type ResponseMeta struct {
    Page       int   `json:"page"`
    PageSize   int   `json:"page_size"`
    TotalItems int64 `json:"total_items"`
    TotalPages int   `json:"total_pages"`
}

// Partial updates with json.RawMessage
type PartialUpdate struct {
    // Pointer fields allow distinguishing "not set" from "zero value"
    Name        *string  `json:"name,omitempty"`
    Email       *string  `json:"email,omitempty"`
    Age         *int     `json:"age,omitempty"`
    Active      *bool    `json:"active,omitempty"`
}

// Using json.RawMessage for deferred parsing
type WebhookEvent struct {
    Type    string          `json:"type"`
    Version string          `json:"version"`
    // Payload parsing deferred until type is known
    Payload json.RawMessage `json:"payload"`
}

func ProcessWebhook(data []byte) error {
    var event WebhookEvent
    if err := json.Unmarshal(data, &event); err != nil {
        return err
    }

    switch event.Type {
    case "user.created":
        var payload struct {
            UserID   string `json:"user_id"`
            Email    string `json:"email"`
            Plan     string `json:"plan"`
        }
        if err := json.Unmarshal(event.Payload, &payload); err != nil {
            return err
        }
        // Handle user creation
    case "payment.succeeded":
        var payload struct {
            Amount   int64  `json:"amount"`
            Currency string `json:"currency"`
            ChargeID string `json:"charge_id"`
        }
        if err := json.Unmarshal(event.Payload, &payload); err != nil {
            return err
        }
        // Handle payment
    }
    return nil
}

// Custom MarshalJSON for computed fields
type User struct {
    FirstName string    `json:"first_name"`
    LastName  string    `json:"last_name"`
    BirthDate time.Time `json:"-"` // Excluded from normal marshaling
}

// Override marshaling to add computed fields
func (u User) MarshalJSON() ([]byte, error) {
    type Alias User // Prevent infinite recursion
    return json.Marshal(struct {
        Alias
        FullName string `json:"full_name"`
        Age      int    `json:"age"`
    }{
        Alias:    Alias(u),
        FullName: u.FirstName + " " + u.LastName,
        Age:      int(time.Since(u.BirthDate).Hours() / 8760),
    })
}

// Streaming large JSON arrays without loading into memory
func StreamJSONArray(buf *bytes.Buffer, items []interface{}) error {
    enc := json.NewEncoder(buf)
    buf.WriteByte('[')

    for i, item := range items {
        if i > 0 {
            buf.WriteByte(',')
        }
        if err := enc.Encode(item); err != nil {
            return err
        }
        // Trim the trailing newline from Encode
        if buf.Len() > 0 && buf.Bytes()[buf.Len()-1] == '\n' {
            buf.Truncate(buf.Len() - 1)
        }
    }

    buf.WriteByte(']')
    return nil
}
```

## Section 3: go-playground/validator Integration

```go
package validation

import (
    "fmt"
    "net"
    "reflect"
    "regexp"
    "strings"
    "unicode"

    "github.com/go-playground/locales/en"
    ut "github.com/go-playground/universal-translator"
    "github.com/go-playground/validator/v10"
    enTranslations "github.com/go-playground/validator/v10/translations/en"
)

var (
    validate *validator.Validate
    trans    ut.Translator
)

func init() {
    validate = validator.New()

    // Use struct field names in JSON form for error messages
    validate.RegisterTagNameFunc(func(fld reflect.StructField) string {
        name := strings.SplitN(fld.Tag.Get("json"), ",", 2)[0]
        if name == "-" {
            return ""
        }
        if name == "" {
            return fld.Name
        }
        return name
    })

    // Setup English translations
    enLocale := en.New()
    uni := ut.New(enLocale, enLocale)
    trans, _ = uni.GetTranslator("en")
    enTranslations.RegisterDefaultTranslations(validate, trans)

    // Register custom validators
    _ = validate.RegisterValidation("slug", validateSlug)
    _ = validate.RegisterValidation("semver", validateSemver)
    _ = validate.RegisterValidation("cidr_list", validateCIDRList)
    _ = validate.RegisterValidation("k8s_name", validateK8sName)
    _ = validate.RegisterValidation("no_html", validateNoHTML)

    // Register custom translations
    _ = validate.RegisterTranslation("slug", trans, func(ut ut.Translator) error {
        return ut.Add("slug", "{0} must contain only lowercase letters, numbers, and hyphens", true)
    }, func(ut ut.Translator, fe validator.FieldError) string {
        t, _ := ut.T("slug", fe.Field())
        return t
    })
}

// validateSlug checks for URL-safe slugs
func validateSlug(fl validator.FieldLevel) bool {
    matched, _ := regexp.MatchString(`^[a-z0-9]+(?:-[a-z0-9]+)*$`, fl.Field().String())
    return matched
}

// validateSemver validates semantic version strings
func validateSemver(fl validator.FieldLevel) bool {
    matched, _ := regexp.MatchString(
        `^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`,
        fl.Field().String(),
    )
    return matched
}

// validateCIDRList validates a comma-separated list of CIDR blocks
func validateCIDRList(fl validator.FieldLevel) bool {
    cidrs := strings.Split(fl.Field().String(), ",")
    for _, cidr := range cidrs {
        cidr = strings.TrimSpace(cidr)
        if _, _, err := net.ParseCIDR(cidr); err != nil {
            return false
        }
    }
    return len(cidrs) > 0
}

// validateK8sName validates Kubernetes resource names
func validateK8sName(fl validator.FieldLevel) bool {
    name := fl.Field().String()
    if len(name) > 253 {
        return false
    }
    matched, _ := regexp.MatchString(`^[a-z0-9]([a-z0-9\-\.]*[a-z0-9])?$`, name)
    return matched
}

// validateNoHTML rejects strings containing HTML tags
func validateNoHTML(fl validator.FieldLevel) bool {
    return !strings.ContainsAny(fl.Field().String(), "<>")
}

// ValidationErrors returns human-readable errors
type ValidationErrors struct {
    Errors map[string]string `json:"errors"`
}

func (e ValidationErrors) Error() string {
    msgs := make([]string, 0, len(e.Errors))
    for field, msg := range e.Errors {
        msgs = append(msgs, fmt.Sprintf("%s: %s", field, msg))
    }
    return strings.Join(msgs, "; ")
}

// Validate validates a struct and returns structured errors
func Validate(v interface{}) error {
    err := validate.Struct(v)
    if err == nil {
        return nil
    }

    validationErrors, ok := err.(validator.ValidationErrors)
    if !ok {
        return err
    }

    errors := make(map[string]string, len(validationErrors))
    for _, e := range validationErrors {
        errors[e.Field()] = e.Translate(trans)
    }

    return ValidationErrors{Errors: errors}
}

// Example struct with comprehensive validation tags
type CreateUserRequest struct {
    // String validations
    Username    string  `json:"username" validate:"required,min=3,max=50,slug"`
    Email       string  `json:"email" validate:"required,email"`
    Password    string  `json:"password" validate:"required,min=8,max=128,containsany=!@#$%^&*"`
    FirstName   string  `json:"first_name" validate:"required,min=1,max=100,no_html"`
    LastName    string  `json:"last_name" validate:"required,min=1,max=100,no_html"`

    // Numeric validations
    Age         int     `json:"age" validate:"required,min=13,max=120"`

    // Enum validations
    Role        string  `json:"role" validate:"required,oneof=admin user viewer"`
    Plan        string  `json:"plan" validate:"required,oneof=free starter pro enterprise"`

    // Optional with validation
    PhoneNumber string  `json:"phone_number,omitempty" validate:"omitempty,e164"`
    Website     string  `json:"website,omitempty" validate:"omitempty,url"`

    // Slice validations
    Tags        []string `json:"tags" validate:"dive,min=1,max=50,slug"`

    // Nested struct
    Address     *Address `json:"address,omitempty" validate:"omitempty"`
}

type Address struct {
    Street  string `json:"street" validate:"required,min=5,max=200"`
    City    string `json:"city" validate:"required,min=2,max=100"`
    Country string `json:"country" validate:"required,iso3166_1_alpha2"`
    ZipCode string `json:"zip_code" validate:"required,min=3,max=10"`
}

// Cross-field validation using struct-level validator
type DateRange struct {
    StartDate string `json:"start_date" validate:"required,datetime=2006-01-02"`
    EndDate   string `json:"end_date" validate:"required,datetime=2006-01-02"`
}

func RegisterCrossFieldValidators() {
    validate.RegisterStructValidation(func(sl validator.StructLevel) {
        dr := sl.Current().Interface().(DateRange)
        if dr.StartDate > dr.EndDate {
            sl.ReportError(dr.EndDate, "end_date", "EndDate",
                "enddate_after_startdate", "")
        }
    }, DateRange{})
}

// Validate and extract cleaned data
func ValidateAndClean(req *CreateUserRequest) error {
    // Normalize before validation
    req.Username = strings.ToLower(strings.TrimSpace(req.Username))
    req.Email = strings.ToLower(strings.TrimSpace(req.Email))
    req.FirstName = strings.TrimSpace(req.FirstName)
    req.LastName = strings.TrimSpace(req.LastName)

    return Validate(req)
}
```

## Section 4: GORM Model Tags

```go
package models

import (
    "database/sql"
    "time"

    "gorm.io/gorm"
    "gorm.io/gorm/clause"
)

// User demonstrates comprehensive GORM tag usage
type User struct {
    // Primary key
    ID uint `gorm:"primaryKey;autoIncrement;column:id"`

    // String columns
    Username string `gorm:"column:username;type:varchar(50);not null;uniqueIndex:idx_username"`
    Email    string `gorm:"column:email;type:varchar(255);not null;uniqueIndex:idx_email"`

    // Nullable fields
    DisplayName sql.NullString `gorm:"column:display_name;type:varchar(100)"`
    Avatar      *string        `gorm:"column:avatar;type:text"`

    // JSON column (PostgreSQL jsonb, MySQL json)
    Preferences JSON           `gorm:"column:preferences;type:jsonb;default:'{}'"`

    // Enums
    Status   UserStatus `gorm:"column:status;type:varchar(20);not null;default:'active';check:chk_status,status IN ('active','inactive','banned')"`
    Role     UserRole   `gorm:"column:role;type:varchar(20);not null;default:'user'"`

    // Numeric
    LoginCount int64  `gorm:"column:login_count;type:bigint;not null;default:0"`
    CreditBalance decimal.Decimal `gorm:"column:credit_balance;type:decimal(15,2);not null;default:0.00"`

    // Timestamps - GORM auto-manages these with magic column names
    CreatedAt time.Time  `gorm:"column:created_at;not null;autoCreateTime"`
    UpdatedAt time.Time  `gorm:"column:updated_at;not null;autoUpdateTime"`
    DeletedAt gorm.DeletedAt `gorm:"column:deleted_at;index"` // Soft delete

    // Foreign keys
    OrganizationID uint         `gorm:"column:organization_id;not null;index:idx_org_id"`
    Organization   Organization `gorm:"foreignKey:OrganizationID;references:ID;constraint:OnUpdate:CASCADE,OnDelete:RESTRICT"`

    // Many-to-many
    Roles []Role `gorm:"many2many:user_roles;joinForeignKey:user_id;joinReferences:role_id"`

    // One-to-many
    Sessions []Session `gorm:"foreignKey:UserID"`

    // Computed/virtual field (not stored)
    FullName string `gorm:"-"` // "-" excludes from GORM operations
}

// TableName overrides the default table name
func (User) TableName() string {
    return "users"
}

type UserStatus string
type UserRole string

const (
    StatusActive   UserStatus = "active"
    StatusInactive UserStatus = "inactive"
    StatusBanned   UserStatus = "banned"

    RoleAdmin  UserRole = "admin"
    RoleUser   UserRole = "user"
    RoleViewer UserRole = "viewer"
)

// Organization model with composite indexes
type Organization struct {
    ID        uint           `gorm:"primaryKey"`
    Slug      string         `gorm:"column:slug;type:varchar(100);not null;uniqueIndex"`
    Name      string         `gorm:"column:name;type:varchar(255);not null"`
    Domain    string         `gorm:"column:domain;type:varchar(255);uniqueIndex:idx_domain_plan"`
    Plan      string         `gorm:"column:plan;type:varchar(50);not null;index:idx_domain_plan"`
    Settings  datatypes.JSON `gorm:"column:settings;type:jsonb"`
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt gorm.DeletedAt `gorm:"index"`
}

// Session model with composite primary key
type Session struct {
    ID        string    `gorm:"column:id;type:uuid;primaryKey;default:gen_random_uuid()"`
    UserID    uint      `gorm:"column:user_id;not null;index:idx_user_sessions"`
    Token     string    `gorm:"column:token;type:varchar(255);not null;uniqueIndex"`
    IPAddress string    `gorm:"column:ip_address;type:inet"`
    UserAgent string    `gorm:"column:user_agent;type:text"`
    ExpiresAt time.Time `gorm:"column:expires_at;not null;index:idx_expires"`
    CreatedAt time.Time `gorm:"autoCreateTime"`
}

// AuditLog demonstrates immutable append-only records
type AuditLog struct {
    ID         uint64         `gorm:"primaryKey;autoIncrement"`
    EntityType string         `gorm:"column:entity_type;type:varchar(100);not null;index:idx_entity"`
    EntityID   string         `gorm:"column:entity_id;type:varchar(36);not null;index:idx_entity"`
    Action     string         `gorm:"column:action;type:varchar(50);not null"`
    ActorID    uint           `gorm:"column:actor_id;not null"`
    Changes    datatypes.JSON `gorm:"column:changes;type:jsonb"`
    CreatedAt  time.Time      `gorm:"autoCreateTime;not null"`
    // No UpdatedAt or DeletedAt - audit logs are immutable
}

// BeforeCreate hook for validation
func (u *User) BeforeCreate(tx *gorm.DB) error {
    if u.Username == "" {
        return fmt.Errorf("username is required")
    }
    return nil
}

// AfterCreate hook for side effects
func (u *User) AfterCreate(tx *gorm.DB) error {
    // Create default settings
    return tx.Create(&UserSettings{
        UserID: u.ID,
        Theme:  "light",
    }).Error
}

// Repository pattern with GORM
type UserRepository struct {
    db *gorm.DB
}

func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*User, error) {
    var user User
    result := r.db.WithContext(ctx).
        Where("email = ? AND deleted_at IS NULL", email).
        Preload("Organization").
        Preload("Roles").
        First(&user)

    if result.Error != nil {
        if errors.Is(result.Error, gorm.ErrRecordNotFound) {
            return nil, ErrNotFound
        }
        return nil, result.Error
    }
    return &user, nil
}

func (r *UserRepository) Create(ctx context.Context, user *User) error {
    return r.db.WithContext(ctx).
        Clauses(clause.OnConflict{
            Columns:   []clause.Column{{Name: "email"}},
            DoNothing: true,
        }).
        Create(user).Error
}

func (r *UserRepository) UpdatePartial(ctx context.Context, id uint, updates map[string]interface{}) error {
    // Use Model() + Updates() for partial updates
    // This respects zero values unlike Save()
    return r.db.WithContext(ctx).
        Model(&User{}).
        Where("id = ?", id).
        Updates(updates).Error
}
```

## Section 5: mapstructure for Configuration Binding

```go
package config

import (
    "fmt"
    "reflect"
    "time"

    "github.com/mitchellh/mapstructure"
)

// AppConfig demonstrates mapstructure for configuration binding
type AppConfig struct {
    // Basic fields
    Name    string `mapstructure:"name"`
    Version string `mapstructure:"version"`
    Debug   bool   `mapstructure:"debug"`

    // Nested config
    Server   ServerConfig   `mapstructure:"server"`
    Database DatabaseConfig `mapstructure:"database"`
    Cache    CacheConfig    `mapstructure:"cache"`

    // Dynamic configuration with "remain" squash
    Extra map[string]interface{} `mapstructure:",remain"`
}

type ServerConfig struct {
    Host            string        `mapstructure:"host"`
    Port            int           `mapstructure:"port"`
    ReadTimeout     time.Duration `mapstructure:"read_timeout"`
    WriteTimeout    time.Duration `mapstructure:"write_timeout"`
    MaxConnections  int           `mapstructure:"max_connections"`
    TLS             *TLSConfig    `mapstructure:"tls"`

    // List of allowed CORS origins
    CORSOrigins     []string      `mapstructure:"cors_origins"`
}

type TLSConfig struct {
    CertFile string `mapstructure:"cert_file"`
    KeyFile  string `mapstructure:"key_file"`
    CAFile   string `mapstructure:"ca_file"`
}

type DatabaseConfig struct {
    // Support both DSN and individual fields
    DSN          string        `mapstructure:"dsn"`
    Host         string        `mapstructure:"host"`
    Port         int           `mapstructure:"port"`
    Database     string        `mapstructure:"database"`
    Username     string        `mapstructure:"username"`
    Password     string        `mapstructure:"password"`
    SSLMode      string        `mapstructure:"ssl_mode"`
    MaxOpenConns int           `mapstructure:"max_open_conns"`
    MaxIdleConns int           `mapstructure:"max_idle_conns"`
    ConnMaxLife  time.Duration `mapstructure:"conn_max_lifetime"`
}

type CacheConfig struct {
    Backend  string        `mapstructure:"backend"` // redis, memcached, memory
    Address  string        `mapstructure:"address"`
    Password string        `mapstructure:"password"`
    DB       int           `mapstructure:"db"`
    TTL      time.Duration `mapstructure:"ttl"`
    MaxSize  int           `mapstructure:"max_size"`
}

// DecodeConfig decodes a map into a config struct with custom hooks
func DecodeConfig(input map[string]interface{}, output interface{}) error {
    decoder, err := mapstructure.NewDecoder(&mapstructure.DecoderConfig{
        Metadata: nil,
        Result:   output,
        // Convert string to target type where possible
        WeaklyTypedInput: false,
        // Decode embedded struct fields from the parent map
        Squash: true,
        // Custom type decoders
        DecodeHook: mapstructure.ComposeDecodeHookFunc(
            // Handle time.Duration from strings
            mapstructure.StringToTimeDurationHookFunc(),
            // Handle time.Time from strings
            mapstructure.StringToTimeHookFunc(time.RFC3339),
            // Custom hook for environment variable expansion
            envExpandHook(),
        ),
        // Fail on unknown keys (catch typos in config)
        ErrorUnused: true,
        // Fail on keys that don't match any struct field
        ErrorUnset: false,
        // Tag to use for mapping
        TagName: "mapstructure",
    })
    if err != nil {
        return fmt.Errorf("creating decoder: %w", err)
    }

    return decoder.Decode(input)
}

// envExpandHook expands ${ENV_VAR} in string values
func envExpandHook() mapstructure.DecodeHookFunc {
    return func(
        from reflect.Type,
        to reflect.Type,
        data interface{},
    ) (interface{}, error) {
        if from.Kind() != reflect.String {
            return data, nil
        }
        if to.Kind() != reflect.String {
            return data, nil
        }

        str := data.(string)
        expanded := os.ExpandEnv(str)
        return expanded, nil
    }
}

// LoadConfig loads configuration from multiple sources
func LoadConfig(paths []string) (*AppConfig, error) {
    // Merge configuration from files and environment
    merged := make(map[string]interface{})

    // Load from YAML/TOML files
    for _, path := range paths {
        data, err := loadFile(path)
        if err != nil {
            if os.IsNotExist(err) {
                continue
            }
            return nil, fmt.Errorf("loading %s: %w", path, err)
        }
        // Deep merge
        deepMerge(merged, data)
    }

    // Override with environment variables
    // e.g., APP_SERVER_PORT=8080 overrides server.port
    overrideFromEnv(merged, "APP")

    var config AppConfig
    if err := DecodeConfig(merged, &config); err != nil {
        return nil, fmt.Errorf("decoding config: %w", err)
    }

    return &config, nil
}
```

## Section 6: Writing a Custom Tag Processor

```go
package tagprocessor

import (
    "fmt"
    "reflect"
    "strings"
    "sync"
)

// CustomTag "api" for API documentation generation
// api:"name,required|optional,description text"
type APIDoc struct {
    mu     sync.RWMutex
    routes map[string][]FieldDocumentation
}

type FieldDocumentation struct {
    JSONName    string
    Required    bool
    Description string
    Type        string
    Validation  string
    Example     string
}

// ExtractAPIDocumentation extracts API documentation from struct tags
func ExtractAPIDocumentation(v interface{}) ([]FieldDocumentation, error) {
    t := reflect.TypeOf(v)
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
    }
    if t.Kind() != reflect.Struct {
        return nil, fmt.Errorf("expected struct, got %v", t.Kind())
    }

    var docs []FieldDocumentation

    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)

        // Skip unexported fields
        if !field.IsExported() {
            continue
        }

        doc := FieldDocumentation{
            Type: formatType(field.Type),
        }

        // Extract JSON name
        jsonTag := field.Tag.Get("json")
        if jsonTag != "" {
            parts := strings.SplitN(jsonTag, ",", 2)
            doc.JSONName = parts[0]
            if doc.JSONName == "-" {
                continue // Skip fields excluded from JSON
            }
        } else {
            doc.JSONName = strings.ToLower(field.Name)
        }

        // Extract validation requirements
        validateTag := field.Tag.Get("validate")
        if validateTag != "" {
            doc.Required = strings.Contains(validateTag, "required")
            doc.Validation = validateTag
        }

        // Extract API documentation tag
        // Format: `api:"description|example value"`
        apiTag := field.Tag.Get("api")
        if apiTag != "" {
            parts := strings.SplitN(apiTag, "|", 2)
            doc.Description = parts[0]
            if len(parts) > 1 {
                doc.Example = parts[1]
            }
        }

        docs = append(docs, doc)
    }

    return docs, nil
}

// Practical example with all tags working together
type CreateProductRequest struct {
    // ID is ignored (auto-generated)
    // json:"-" excludes from JSON completely
    InternalID uint `json:"-" gorm:"-" validate:"-"`

    // Name with multiple constraints
    Name string `
        json:"name"
        validate:"required,min=3,max=200,no_html"
        gorm:"column:name;type:varchar(200);not null"
        api:"Product display name|Wireless Keyboard"`

    // Slug with custom validator
    Slug string `
        json:"slug,omitempty"
        validate:"omitempty,slug,max=250"
        gorm:"column:slug;type:varchar(250);uniqueIndex"
        api:"URL-friendly identifier (auto-generated if omitted)|wireless-keyboard"`

    // Price as string for exact decimal
    Price string `
        json:"price"
        validate:"required,numeric,min=0"
        gorm:"column:price;type:decimal(15,2);not null"
        api:"Price in cents as string|2999"`

    // Category as enum
    Category string `
        json:"category"
        validate:"required,oneof=electronics clothing books home sports"
        gorm:"column:category;type:varchar(50);not null;index"
        api:"Product category|electronics"`

    // Optional rich text description
    Description *string `
        json:"description,omitempty"
        validate:"omitempty,min=10,max=5000"
        gorm:"column:description;type:text"
        api:"Full product description (HTML allowed)|<p>High-performance keyboard</p>"`

    // Images as JSON array
    Images []string `
        json:"images,omitempty"
        validate:"omitempty,dive,url,max=500"
        gorm:"column:images;type:jsonb;default:'[]'"
        api:"Image URLs|[\"https://cdn.example.com/img/keyboard.jpg\"]"`

    // Nested struct
    Dimensions *Dimensions `
        json:"dimensions,omitempty"
        validate:"omitempty"
        gorm:"embedded;embeddedPrefix:dim_"
        api:"Physical dimensions"`

    // Timestamps managed by GORM, hidden from API input
    CreatedAt time.Time `json:"-" gorm:"autoCreateTime"`
    UpdatedAt time.Time `json:"-" gorm:"autoUpdateTime"`
}

type Dimensions struct {
    Width  float64 `json:"width" validate:"required,min=0,max=10000" gorm:"column:width" api:"Width in mm"`
    Height float64 `json:"height" validate:"required,min=0,max=10000" gorm:"column:height" api:"Height in mm"`
    Depth  float64 `json:"depth" validate:"required,min=0,max=10000" gorm:"column:depth" api:"Depth in mm"`
    Weight float64 `json:"weight" validate:"required,min=0,max=100000" gorm:"column:weight" api:"Weight in grams"`
}

func formatType(t reflect.Type) string {
    if t.Kind() == reflect.Ptr {
        return "?" + formatType(t.Elem())
    }
    switch t.Kind() {
    case reflect.String:
        return "string"
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        return "integer"
    case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
        return "unsigned integer"
    case reflect.Float32, reflect.Float64:
        return "number"
    case reflect.Bool:
        return "boolean"
    case reflect.Slice:
        return "array of " + formatType(t.Elem())
    case reflect.Map:
        return fmt.Sprintf("map[%s]%s", formatType(t.Key()), formatType(t.Elem()))
    case reflect.Struct:
        return t.Name()
    default:
        return t.Kind().String()
    }
}
```

Struct tags in Go are more than a convenience — they are the primary mechanism for declarative metadata that drives a significant portion of enterprise Go application behavior. By understanding tag parsing at the reflection level, applying advanced JSON marshaling patterns, combining validator annotations with GORM column definitions, and building custom tag processors, teams can reduce boilerplate, improve consistency, and create self-documenting data models that serve as the single source of truth for API contracts, database schemas, and validation rules.
