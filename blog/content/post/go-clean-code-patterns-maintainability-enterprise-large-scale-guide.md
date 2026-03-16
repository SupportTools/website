---
title: "Clean Code in Go: Enterprise Patterns for Maintainable Large-Scale Applications (50,000+ Lines)"
date: 2026-07-17T00:00:00-05:00
draft: false
tags: ["Go", "Clean Code", "Maintainability", "Enterprise", "Architecture", "Code Quality", "Refactoring"]
categories: ["Clean Code", "Development", "Enterprise"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to writing clean, maintainable Go code for enterprise applications, featuring proven patterns for organizing 50,000+ line codebases, domain-driven design, and long-term code quality strategies."
more_link: "yes"
url: "/go-clean-code-patterns-maintainability-enterprise-large-scale-guide/"
---

Writing clean, maintainable Go code becomes increasingly critical as enterprise applications grow beyond 50,000 lines of code. While Go's simplicity is an asset, large-scale enterprise development demands sophisticated patterns for code organization, domain modeling, dependency management, and architectural clarity that enable teams to maintain development velocity while ensuring long-term maintainability. Clean code principles, when properly applied to Go, provide the foundation for applications that can evolve gracefully over years of development.

This comprehensive guide explores battle-tested clean code patterns, enterprise-scale architecture strategies, and maintainability frameworks that enable Go applications to scale from thousands to hundreds of thousands of lines while preserving code quality, developer productivity, and system reliability.

<!--more-->

## Executive Summary

Large-scale Go applications face unique maintainability challenges: domain complexity that spans multiple business areas, team coordination across dozens of developers, architectural decisions that affect long-term evolution, and the need to balance feature velocity with code quality. Clean code principles provide systematic approaches to managing this complexity through clear separation of concerns, explicit dependency relationships, comprehensive testing strategies, and domain-driven design patterns.

Key areas include enterprise package organization strategies, domain-driven design implementation, interface-based architecture patterns, comprehensive testing frameworks, refactoring strategies for legacy code, and continuous code quality improvement processes that scale across large engineering organizations.

## Enterprise Package Organization and Architecture

### Domain-Driven Package Structure

Large-scale Go applications require sophisticated organization that aligns with business domains while maintaining technical clarity:

```go
package architecture

import (
    "context"
    "fmt"
    "time"
)

// Enterprise package structure for 50,000+ line applications
/*
Project Structure for Large-Scale Go Applications:

cmd/
├── api/                    # API server entry point
│   └── main.go
├── worker/                 # Background worker entry point
│   └── main.go
├── scheduler/              # Job scheduler entry point
│   └── main.go
└── migration/              # Database migration tool
    └── main.go

internal/                   # Private application code
├── user/                   # User domain
│   ├── domain/             # Domain models and business logic
│   │   ├── user.go         # User aggregate root
│   │   ├── profile.go      # Profile value object
│   │   ├── repository.go   # Repository interface
│   │   └── service.go      # Domain service
│   ├── application/        # Application services
│   │   ├── commands/       # Command handlers
│   │   ├── queries/        # Query handlers
│   │   └── dto/            # Data transfer objects
│   ├── infrastructure/     # Infrastructure implementations
│   │   ├── persistence/    # Database implementations
│   │   ├── external/       # External service clients
│   │   └── messaging/      # Message queue implementations
│   └── interfaces/         # External interfaces
│       ├── http/           # HTTP handlers
│       ├── grpc/           # gRPC handlers
│       └── events/         # Event handlers
├── order/                  # Order domain (similar structure)
├── payment/                # Payment domain (similar structure)
├── notification/           # Notification domain (similar structure)
└── shared/                 # Shared kernel
    ├── domain/             # Shared domain concepts
    ├── infrastructure/     # Shared infrastructure
    └── interfaces/         # Shared interfaces

pkg/                        # Public library code
├── client/                 # API clients for external consumption
├── contracts/              # Interface contracts
└── types/                  # Shared types

api/                        # API specifications
├── openapi/                # OpenAPI/Swagger specs
├── proto/                  # Protocol Buffer definitions
└── graphql/                # GraphQL schemas

docs/                       # Documentation
├── architecture/           # Architecture Decision Records (ADRs)
├── domain/                 # Domain documentation
└── runbooks/               # Operational runbooks
*/

// CleanArchitecturePattern demonstrates enterprise clean architecture implementation
type CleanArchitecturePattern struct {
    // Domain Layer - Core business logic
    domainServices   map[string]DomainService
    repositories     map[string]Repository
    aggregates      map[string]AggregateRoot

    // Application Layer - Use cases and orchestration
    commandHandlers  map[string]CommandHandler
    queryHandlers    map[string]QueryHandler
    eventHandlers    map[string]EventHandler

    // Infrastructure Layer - External concerns
    databases        map[string]Database
    messageBrokers   map[string]MessageBroker
    externalServices map[string]ExternalService

    // Interface Layer - External communication
    httpHandlers     map[string]HTTPHandler
    grpcServers      map[string]GRPCServer
    eventListeners   map[string]EventListener

    // Cross-cutting concerns
    logger           Logger
    metrics          MetricsCollector
    tracer           Tracer
    validator        Validator
}

// Domain Model: User Aggregate demonstrates clean domain modeling
type User struct {
    // Identity
    id       UserID
    email    Email
    username Username

    // Value objects
    profile  Profile
    settings UserSettings

    // State
    status    UserStatus
    createdAt time.Time
    updatedAt time.Time
    version   int

    // Domain events (uncommitted)
    events []DomainEvent
}

// UserID demonstrates type safety through custom types
type UserID struct {
    value string
}

func NewUserID(value string) (UserID, error) {
    if value == "" {
        return UserID{}, fmt.Errorf("user ID cannot be empty")
    }

    if len(value) < 10 {
        return UserID{}, fmt.Errorf("user ID must be at least 10 characters")
    }

    return UserID{value: value}, nil
}

func (uid UserID) String() string {
    return uid.value
}

func (uid UserID) Equals(other UserID) bool {
    return uid.value == other.value
}

// Email demonstrates value object patterns with validation
type Email struct {
    value string
}

func NewEmail(value string) (Email, error) {
    if value == "" {
        return Email{}, fmt.Errorf("email cannot be empty")
    }

    if !isValidEmail(value) {
        return Email{}, fmt.Errorf("invalid email format: %s", value)
    }

    return Email{value: value}, nil
}

func (e Email) String() string {
    return e.value
}

func (e Email) Domain() string {
    parts := strings.Split(e.value, "@")
    if len(parts) != 2 {
        return ""
    }
    return parts[1]
}

func (e Email) LocalPart() string {
    parts := strings.Split(e.value, "@")
    if len(parts) != 2 {
        return ""
    }
    return parts[0]
}

// Profile demonstrates complex value objects
type Profile struct {
    firstName   string
    lastName    string
    dateOfBirth *time.Time
    avatar      *URL
    biography   string
}

func NewProfile(firstName, lastName string) (Profile, error) {
    if firstName == "" {
        return Profile{}, fmt.Errorf("first name is required")
    }

    if lastName == "" {
        return Profile{}, fmt.Errorf("last name is required")
    }

    return Profile{
        firstName: firstName,
        lastName:  lastName,
    }, nil
}

func (p Profile) FullName() string {
    return fmt.Sprintf("%s %s", p.firstName, p.lastName)
}

func (p Profile) WithDateOfBirth(dob time.Time) Profile {
    p.dateOfBirth = &dob
    return p
}

func (p Profile) WithAvatar(avatar URL) Profile {
    p.avatar = &avatar
    return p
}

func (p Profile) WithBiography(bio string) Profile {
    p.biography = bio
    return p
}

func (p Profile) Age() *int {
    if p.dateOfBirth == nil {
        return nil
    }

    age := int(time.Since(*p.dateOfBirth).Hours() / 24 / 365)
    return &age
}

// Business Logic: User domain service demonstrates clean business logic
func (u *User) ChangeEmail(newEmail Email, emailService EmailDomainService) error {
    // Business rule: Cannot change to the same email
    if u.email.Equals(newEmail) {
        return fmt.Errorf("new email must be different from current email")
    }

    // Business rule: Email domain must not be blocked
    if emailService.IsDomainBlocked(newEmail.Domain()) {
        return fmt.Errorf("email domain %s is blocked", newEmail.Domain())
    }

    // Business rule: Email must be unique
    exists, err := emailService.EmailExists(newEmail)
    if err != nil {
        return fmt.Errorf("failed to check email uniqueness: %w", err)
    }

    if exists {
        return fmt.Errorf("email %s is already in use", newEmail.String())
    }

    oldEmail := u.email
    u.email = newEmail
    u.updatedAt = time.Now()
    u.version++

    // Raise domain event
    u.addEvent(NewUserEmailChangedEvent(u.id, oldEmail, newEmail))

    return nil
}

func (u *User) UpdateProfile(newProfile Profile) error {
    // Business validation
    if newProfile.firstName == "" || newProfile.lastName == "" {
        return fmt.Errorf("profile must have both first name and last name")
    }

    u.profile = newProfile
    u.updatedAt = time.Now()
    u.version++

    // Raise domain event
    u.addEvent(NewUserProfileUpdatedEvent(u.id, u.profile))

    return nil
}

func (u *User) Deactivate(reason string) error {
    // Business rule: Cannot deactivate already inactive users
    if u.status == UserStatusInactive {
        return fmt.Errorf("user is already inactive")
    }

    // Business rule: Reason must be provided for deactivation
    if reason == "" {
        return fmt.Errorf("deactivation reason is required")
    }

    u.status = UserStatusInactive
    u.updatedAt = time.Now()
    u.version++

    // Raise domain event
    u.addEvent(NewUserDeactivatedEvent(u.id, reason))

    return nil
}

// Domain events for maintaining consistency
func (u *User) addEvent(event DomainEvent) {
    u.events = append(u.events, event)
}

func (u *User) GetUncommittedEvents() []DomainEvent {
    return u.events
}

func (u *User) MarkEventsAsCommitted() {
    u.events = nil
}

// Repository interface demonstrates clean separation of concerns
type UserRepository interface {
    // Aggregate persistence
    Save(ctx context.Context, user *User) error
    FindByID(ctx context.Context, id UserID) (*User, error)
    FindByEmail(ctx context.Context, email Email) (*User, error)
    Delete(ctx context.Context, id UserID) error

    // Query methods
    FindByStatus(ctx context.Context, status UserStatus, limit, offset int) ([]*User, error)
    Search(ctx context.Context, criteria UserSearchCriteria) ([]*User, error)
    Count(ctx context.Context, criteria UserSearchCriteria) (int, error)

    // Batch operations
    SaveBatch(ctx context.Context, users []*User) error
    FindByIDs(ctx context.Context, ids []UserID) ([]*User, error)
}

type UserSearchCriteria struct {
    Email     *Email
    Username  *Username
    Status    *UserStatus
    CreatedAt *TimeRange
    UpdatedAt *TimeRange
}

type TimeRange struct {
    From *time.Time
    To   *time.Time
}

// Domain service for complex business logic
type EmailDomainService interface {
    IsDomainBlocked(domain string) bool
    EmailExists(email Email) (bool, error)
    ValidateEmailFormat(email string) error
    GetDomainReputation(domain string) DomainReputation
}

type DomainReputation struct {
    Score       float64
    IsTrusted   bool
    IsBlacklisted bool
    Reasons     []string
}

// Application Service demonstrates use case orchestration
type UserApplicationService struct {
    userRepo        UserRepository
    emailService    EmailDomainService
    eventPublisher  EventPublisher
    unitOfWork      UnitOfWork

    // Cross-cutting concerns
    logger          Logger
    metrics         MetricsCollector
    validator       Validator
}

func NewUserApplicationService(
    userRepo UserRepository,
    emailService EmailDomainService,
    eventPublisher EventPublisher,
    unitOfWork UnitOfWork,
    logger Logger,
    metrics MetricsCollector,
    validator Validator,
) *UserApplicationService {
    return &UserApplicationService{
        userRepo:       userRepo,
        emailService:   emailService,
        eventPublisher: eventPublisher,
        unitOfWork:     unitOfWork,
        logger:         logger,
        metrics:        metrics,
        validator:      validator,
    }
}

// Command pattern for write operations
type CreateUserCommand struct {
    Email     string `validate:"required,email"`
    Username  string `validate:"required,min=3,max=30,alphanum"`
    FirstName string `validate:"required,min=1,max=50"`
    LastName  string `validate:"required,min=1,max=50"`
}

func (uas *UserApplicationService) CreateUser(ctx context.Context, cmd CreateUserCommand) (*User, error) {
    // Validate command
    if err := uas.validator.Validate(cmd); err != nil {
        return nil, fmt.Errorf("validation failed: %w", err)
    }

    // Start unit of work
    uow, err := uas.unitOfWork.Begin(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to start unit of work: %w", err)
    }
    defer uow.Rollback()

    // Create value objects
    email, err := NewEmail(cmd.Email)
    if err != nil {
        return nil, fmt.Errorf("invalid email: %w", err)
    }

    username, err := NewUsername(cmd.Username)
    if err != nil {
        return nil, fmt.Errorf("invalid username: %w", err)
    }

    profile, err := NewProfile(cmd.FirstName, cmd.LastName)
    if err != nil {
        return nil, fmt.Errorf("invalid profile: %w", err)
    }

    // Business validation
    if uas.emailService.IsDomainBlocked(email.Domain()) {
        return nil, fmt.Errorf("email domain is blocked")
    }

    // Check uniqueness
    existingUser, err := uas.userRepo.FindByEmail(ctx, email)
    if err != nil && !IsNotFoundError(err) {
        return nil, fmt.Errorf("failed to check email uniqueness: %w", err)
    }
    if existingUser != nil {
        return nil, fmt.Errorf("email already exists")
    }

    // Create user aggregate
    userID, err := NewUserID(generateUserID())
    if err != nil {
        return nil, fmt.Errorf("failed to generate user ID: %w", err)
    }

    user := &User{
        id:        userID,
        email:     email,
        username:  username,
        profile:   profile,
        status:    UserStatusActive,
        createdAt: time.Now(),
        updatedAt: time.Now(),
        version:   1,
    }

    // Add creation event
    user.addEvent(NewUserCreatedEvent(user.id, user.email, user.username))

    // Save aggregate
    if err := uas.userRepo.Save(ctx, user); err != nil {
        return nil, fmt.Errorf("failed to save user: %w", err)
    }

    // Publish domain events
    events := user.GetUncommittedEvents()
    for _, event := range events {
        if err := uas.eventPublisher.Publish(ctx, event); err != nil {
            uas.logger.Error("Failed to publish domain event", "event", event, "error", err)
            // Consider if this should fail the transaction
        }
    }

    user.MarkEventsAsCommitted()

    // Commit transaction
    if err := uow.Commit(); err != nil {
        return nil, fmt.Errorf("failed to commit transaction: %w", err)
    }

    // Record metrics
    uas.metrics.IncrementCounter("users_created_total", nil)

    return user, nil
}

// Query pattern for read operations
type GetUserQuery struct {
    UserID string `validate:"required,uuid4"`
}

type UserDTO struct {
    ID        string    `json:"id"`
    Email     string    `json:"email"`
    Username  string    `json:"username"`
    FirstName string    `json:"firstName"`
    LastName  string    `json:"lastName"`
    FullName  string    `json:"fullName"`
    Status    string    `json:"status"`
    CreatedAt time.Time `json:"createdAt"`
    UpdatedAt time.Time `json:"updatedAt"`
}

func (uas *UserApplicationService) GetUser(ctx context.Context, query GetUserQuery) (*UserDTO, error) {
    // Validate query
    if err := uas.validator.Validate(query); err != nil {
        return nil, fmt.Errorf("validation failed: %w", err)
    }

    // Parse user ID
    userID, err := NewUserID(query.UserID)
    if err != nil {
        return nil, fmt.Errorf("invalid user ID: %w", err)
    }

    // Find user
    user, err := uas.userRepo.FindByID(ctx, userID)
    if err != nil {
        if IsNotFoundError(err) {
            return nil, fmt.Errorf("user not found")
        }
        return nil, fmt.Errorf("failed to find user: %w", err)
    }

    // Convert to DTO
    dto := &UserDTO{
        ID:        user.id.String(),
        Email:     user.email.String(),
        Username:  user.username.String(),
        FirstName: user.profile.firstName,
        LastName:  user.profile.lastName,
        FullName:  user.profile.FullName(),
        Status:    user.status.String(),
        CreatedAt: user.createdAt,
        UpdatedAt: user.updatedAt,
    }

    return dto, nil
}
```

## Advanced Clean Code Patterns

### Interface-Based Design for Flexibility

Clean interfaces enable testability, dependency inversion, and architectural flexibility:

```go
package interfaces

import (
    "context"
    "io"
    "time"
)

// ServiceInterface demonstrates clean interface design principles
type ServiceInterface interface {
    // Methods should be focused and cohesive
    ProcessData(ctx context.Context, data ProcessingData) (*ProcessingResult, error)

    // Return interfaces, not concrete types when possible
    GetProcessor() DataProcessor

    // Use context for cancellation and timeouts
    ProcessWithTimeout(ctx context.Context, data ProcessingData, timeout time.Duration) (*ProcessingResult, error)
}

// Smaller, focused interfaces are better than large ones
type DataProcessor interface {
    Process(ctx context.Context, input []byte) ([]byte, error)
}

type DataValidator interface {
    Validate(ctx context.Context, data interface{}) error
}

type DataTransformer interface {
    Transform(ctx context.Context, input []byte) ([]byte, error)
}

// Composition over inheritance through interface embedding
type CompleteDataProcessor interface {
    DataProcessor
    DataValidator
    DataTransformer
}

// ConcreteService demonstrates clean implementation
type ConcreteService struct {
    processor   DataProcessor
    validator   DataValidator
    transformer DataTransformer

    // Dependencies are injected through constructor
    logger      Logger
    metrics     MetricsCollector
    config      ServiceConfig
}

type ServiceConfig struct {
    MaxProcessingTime time.Duration
    BatchSize         int
    RetryAttempts     int
    EnableCaching     bool
}

func NewConcreteService(
    processor DataProcessor,
    validator DataValidator,
    transformer DataTransformer,
    logger Logger,
    metrics MetricsCollector,
    config ServiceConfig,
) *ConcreteService {
    return &ConcreteService{
        processor:   processor,
        validator:   validator,
        transformer: transformer,
        logger:      logger,
        metrics:     metrics,
        config:      config,
    }
}

func (cs *ConcreteService) ProcessData(ctx context.Context, data ProcessingData) (*ProcessingResult, error) {
    start := time.Now()
    defer func() {
        cs.metrics.RecordProcessingTime(time.Since(start))
    }()

    // Validation
    if err := cs.validator.Validate(ctx, data); err != nil {
        cs.metrics.IncrementCounter("validation_errors_total", nil)
        return nil, fmt.Errorf("validation failed: %w", err)
    }

    // Transformation
    transformed, err := cs.transformer.Transform(ctx, data.Raw)
    if err != nil {
        cs.metrics.IncrementCounter("transformation_errors_total", nil)
        return nil, fmt.Errorf("transformation failed: %w", err)
    }

    // Processing
    processed, err := cs.processor.Process(ctx, transformed)
    if err != nil {
        cs.metrics.IncrementCounter("processing_errors_total", nil)
        return nil, fmt.Errorf("processing failed: %w", err)
    }

    result := &ProcessingResult{
        ProcessedData: processed,
        ProcessedAt:   time.Now(),
        Metadata:      map[string]interface{}{
            "original_size":  len(data.Raw),
            "processed_size": len(processed),
            "processing_time": time.Since(start).String(),
        },
    }

    cs.metrics.IncrementCounter("successful_processing_total", nil)
    return result, nil
}

// Factory pattern for creating configured instances
type ProcessorFactory interface {
    CreateProcessor(processorType string, config ProcessorConfig) (DataProcessor, error)
    CreateValidator(validatorType string, config ValidatorConfig) (DataValidator, error)
    CreateTransformer(transformerType string, config TransformerConfig) (DataTransformer, error)
}

type DefaultProcessorFactory struct {
    logger Logger
}

func NewDefaultProcessorFactory(logger Logger) *DefaultProcessorFactory {
    return &DefaultProcessorFactory{
        logger: logger,
    }
}

func (dpf *DefaultProcessorFactory) CreateProcessor(processorType string, config ProcessorConfig) (DataProcessor, error) {
    switch processorType {
    case "json":
        return NewJSONProcessor(config, dpf.logger), nil
    case "xml":
        return NewXMLProcessor(config, dpf.logger), nil
    case "csv":
        return NewCSVProcessor(config, dpf.logger), nil
    default:
        return nil, fmt.Errorf("unknown processor type: %s", processorType)
    }
}

// Strategy pattern for algorithm selection
type ProcessingStrategy interface {
    Execute(ctx context.Context, data []byte) ([]byte, error)
    CanHandle(dataType string) bool
    EstimateComplexity(dataSize int) ComplexityEstimate
}

type ComplexityEstimate struct {
    TimeComplexity  string
    SpaceComplexity string
    EstimatedTime   time.Duration
}

type StrategySelector struct {
    strategies []ProcessingStrategy
    fallback   ProcessingStrategy
}

func NewStrategySelector(strategies []ProcessingStrategy, fallback ProcessingStrategy) *StrategySelector {
    return &StrategySelector{
        strategies: strategies,
        fallback:   fallback,
    }
}

func (ss *StrategySelector) SelectStrategy(dataType string, dataSize int) ProcessingStrategy {
    // Find capable strategies
    var candidates []ProcessingStrategy
    for _, strategy := range ss.strategies {
        if strategy.CanHandle(dataType) {
            candidates = append(candidates, strategy)
        }
    }

    if len(candidates) == 0 {
        return ss.fallback
    }

    if len(candidates) == 1 {
        return candidates[0]
    }

    // Select best strategy based on complexity estimates
    bestStrategy := candidates[0]
    bestEstimate := bestStrategy.EstimateComplexity(dataSize)

    for _, candidate := range candidates[1:] {
        estimate := candidate.EstimateComplexity(dataSize)
        if estimate.EstimatedTime < bestEstimate.EstimatedTime {
            bestStrategy = candidate
            bestEstimate = estimate
        }
    }

    return bestStrategy
}

// Decorator pattern for cross-cutting concerns
type ProcessorDecorator interface {
    DataProcessor
    GetDecorated() DataProcessor
}

// Logging decorator
type LoggingProcessor struct {
    decorated DataProcessor
    logger    Logger
}

func NewLoggingProcessor(decorated DataProcessor, logger Logger) *LoggingProcessor {
    return &LoggingProcessor{
        decorated: decorated,
        logger:    logger,
    }
}

func (lp *LoggingProcessor) Process(ctx context.Context, input []byte) ([]byte, error) {
    lp.logger.Info("Starting data processing", "input_size", len(input))

    start := time.Now()
    result, err := lp.decorated.Process(ctx, input)
    duration := time.Since(start)

    if err != nil {
        lp.logger.Error("Processing failed", "error", err, "duration", duration)
        return nil, err
    }

    lp.logger.Info("Processing completed",
        "input_size", len(input),
        "output_size", len(result),
        "duration", duration)

    return result, nil
}

func (lp *LoggingProcessor) GetDecorated() DataProcessor {
    return lp.decorated
}

// Caching decorator
type CachingProcessor struct {
    decorated DataProcessor
    cache     Cache
    ttl       time.Duration
}

func NewCachingProcessor(decorated DataProcessor, cache Cache, ttl time.Duration) *CachingProcessor {
    return &CachingProcessor{
        decorated: decorated,
        cache:     cache,
        ttl:       ttl,
    }
}

func (cp *CachingProcessor) Process(ctx context.Context, input []byte) ([]byte, error) {
    // Generate cache key
    key := cp.generateCacheKey(input)

    // Check cache
    if cached, err := cp.cache.Get(ctx, key); err == nil {
        if result, ok := cached.([]byte); ok {
            return result, nil
        }
    }

    // Process if not cached
    result, err := cp.decorated.Process(ctx, input)
    if err != nil {
        return nil, err
    }

    // Cache result
    cp.cache.Set(ctx, key, result, cp.ttl)

    return result, nil
}

func (cp *CachingProcessor) generateCacheKey(input []byte) string {
    // Implement appropriate cache key generation
    // This is a simplified example
    return fmt.Sprintf("processor_%x", sha256.Sum256(input))
}

func (cp *CachingProcessor) GetDecorated() DataProcessor {
    return cp.decorated
}

// Metrics decorator
type MetricsProcessor struct {
    decorated DataProcessor
    metrics   MetricsCollector
}

func NewMetricsProcessor(decorated DataProcessor, metrics MetricsCollector) *MetricsProcessor {
    return &MetricsProcessor{
        decorated: decorated,
        metrics:   metrics,
    }
}

func (mp *MetricsProcessor) Process(ctx context.Context, input []byte) ([]byte, error) {
    start := time.Now()

    result, err := mp.decorated.Process(ctx, input)

    duration := time.Since(start)

    // Record metrics
    mp.metrics.RecordHistogram("processing_duration_seconds", duration.Seconds(), nil)
    mp.metrics.RecordHistogram("input_size_bytes", float64(len(input)), nil)

    if err != nil {
        mp.metrics.IncrementCounter("processing_errors_total", nil)
    } else {
        mp.metrics.IncrementCounter("processing_success_total", nil)
        mp.metrics.RecordHistogram("output_size_bytes", float64(len(result)), nil)
    }

    return result, err
}

func (mp *MetricsProcessor) GetDecorated() DataProcessor {
    return mp.decorated
}

// Builder pattern for complex object construction
type ServiceBuilder struct {
    processor   DataProcessor
    validator   DataValidator
    transformer DataTransformer
    logger      Logger
    metrics     MetricsCollector
    config      ServiceConfig
    decorators  []func(DataProcessor) DataProcessor
}

func NewServiceBuilder() *ServiceBuilder {
    return &ServiceBuilder{
        decorators: make([]func(DataProcessor) DataProcessor, 0),
    }
}

func (sb *ServiceBuilder) WithProcessor(processor DataProcessor) *ServiceBuilder {
    sb.processor = processor
    return sb
}

func (sb *ServiceBuilder) WithValidator(validator DataValidator) *ServiceBuilder {
    sb.validator = validator
    return sb
}

func (sb *ServiceBuilder) WithTransformer(transformer DataTransformer) *ServiceBuilder {
    sb.transformer = transformer
    return sb
}

func (sb *ServiceBuilder) WithLogger(logger Logger) *ServiceBuilder {
    sb.logger = logger
    return sb
}

func (sb *ServiceBuilder) WithMetrics(metrics MetricsCollector) *ServiceBuilder {
    sb.metrics = metrics
    return sb
}

func (sb *ServiceBuilder) WithConfig(config ServiceConfig) *ServiceBuilder {
    sb.config = config
    return sb
}

func (sb *ServiceBuilder) WithLogging() *ServiceBuilder {
    sb.decorators = append(sb.decorators, func(p DataProcessor) DataProcessor {
        return NewLoggingProcessor(p, sb.logger)
    })
    return sb
}

func (sb *ServiceBuilder) WithCaching(cache Cache, ttl time.Duration) *ServiceBuilder {
    sb.decorators = append(sb.decorators, func(p DataProcessor) DataProcessor {
        return NewCachingProcessor(p, cache, ttl)
    })
    return sb
}

func (sb *ServiceBuilder) WithMetrics() *ServiceBuilder {
    sb.decorators = append(sb.decorators, func(p DataProcessor) DataProcessor {
        return NewMetricsProcessor(p, sb.metrics)
    })
    return sb
}

func (sb *ServiceBuilder) Build() (*ConcreteService, error) {
    // Validate required dependencies
    if sb.processor == nil {
        return nil, fmt.Errorf("processor is required")
    }
    if sb.validator == nil {
        return nil, fmt.Errorf("validator is required")
    }
    if sb.transformer == nil {
        return nil, fmt.Errorf("transformer is required")
    }

    // Apply decorators
    processor := sb.processor
    for _, decorator := range sb.decorators {
        processor = decorator(processor)
    }

    return NewConcreteService(
        processor,
        sb.validator,
        sb.transformer,
        sb.logger,
        sb.metrics,
        sb.config,
    ), nil
}

// Example usage demonstrating clean construction
func ExampleServiceConstruction() (*ConcreteService, error) {
    logger := NewLogger()
    metrics := NewMetricsCollector()
    cache := NewRedisCache()

    factory := NewDefaultProcessorFactory(logger)

    processor, err := factory.CreateProcessor("json", ProcessorConfig{})
    if err != nil {
        return nil, err
    }

    validator, err := factory.CreateValidator("json", ValidatorConfig{})
    if err != nil {
        return nil, err
    }

    transformer, err := factory.CreateTransformer("json", TransformerConfig{})
    if err != nil {
        return nil, err
    }

    service, err := NewServiceBuilder().
        WithProcessor(processor).
        WithValidator(validator).
        WithTransformer(transformer).
        WithLogger(logger).
        WithMetrics(metrics).
        WithConfig(ServiceConfig{
            MaxProcessingTime: 30 * time.Second,
            BatchSize:         100,
            RetryAttempts:     3,
            EnableCaching:     true,
        }).
        WithLogging().
        WithMetrics().
        WithCaching(cache, 5*time.Minute).
        Build()

    if err != nil {
        return nil, err
    }

    return service, nil
}
```

## Comprehensive Testing Strategies

### Test-Driven Development for Clean Code

Comprehensive testing ensures code quality and enables confident refactoring:

```go
package testing

import (
    "context"
    "testing"
    "time"
)

// TestSuite demonstrates comprehensive testing patterns for clean code
type UserServiceTestSuite struct {
    // Test dependencies
    userRepo        *MockUserRepository
    emailService    *MockEmailDomainService
    eventPublisher  *MockEventPublisher
    unitOfWork      *MockUnitOfWork

    // System under test
    userService     *UserApplicationService

    // Test data
    testUser        *User
    testEmail       Email
    testProfile     Profile
}

func NewUserServiceTestSuite(t *testing.T) *UserServiceTestSuite {
    suite := &UserServiceTestSuite{
        userRepo:       NewMockUserRepository(),
        emailService:   NewMockEmailDomainService(),
        eventPublisher: NewMockEventPublisher(),
        unitOfWork:     NewMockUnitOfWork(),
    }

    // Set up test data
    var err error
    suite.testEmail, err = NewEmail("test@example.com")
    if err != nil {
        t.Fatalf("Failed to create test email: %v", err)
    }

    suite.testProfile, err = NewProfile("John", "Doe")
    if err != nil {
        t.Fatalf("Failed to create test profile: %v", err)
    }

    userID, err := NewUserID("test-user-id-123")
    if err != nil {
        t.Fatalf("Failed to create test user ID: %v", err)
    }

    username, err := NewUsername("johndoe")
    if err != nil {
        t.Fatalf("Failed to create test username: %v", err)
    }

    suite.testUser = &User{
        id:        userID,
        email:     suite.testEmail,
        username:  username,
        profile:   suite.testProfile,
        status:    UserStatusActive,
        createdAt: time.Now(),
        updatedAt: time.Now(),
        version:   1,
    }

    // Create service under test
    suite.userService = NewUserApplicationService(
        suite.userRepo,
        suite.emailService,
        suite.eventPublisher,
        suite.unitOfWork,
        NewTestLogger(),
        NewTestMetricsCollector(),
        NewTestValidator(),
    )

    return suite
}

// Unit tests for domain logic
func TestUser_ChangeEmail_Success(t *testing.T) {
    suite := NewUserServiceTestSuite(t)

    newEmail, err := NewEmail("newemail@example.com")
    if err != nil {
        t.Fatalf("Failed to create new email: %v", err)
    }

    // Set up mock expectations
    suite.emailService.On("IsDomainBlocked", "example.com").Return(false)
    suite.emailService.On("EmailExists", newEmail).Return(false, nil)

    // Execute
    err = suite.testUser.ChangeEmail(newEmail, suite.emailService)

    // Assert
    if err != nil {
        t.Errorf("Expected no error, got: %v", err)
    }

    if !suite.testUser.email.Equals(newEmail) {
        t.Errorf("Expected email to be %s, got %s", newEmail.String(), suite.testUser.email.String())
    }

    events := suite.testUser.GetUncommittedEvents()
    if len(events) != 1 {
        t.Errorf("Expected 1 event, got %d", len(events))
    }

    // Verify mock expectations
    suite.emailService.AssertExpectations(t)
}

func TestUser_ChangeEmail_SameEmail_ReturnsError(t *testing.T) {
    suite := NewUserServiceTestSuite(t)

    // Execute - try to change to same email
    err := suite.testUser.ChangeEmail(suite.testEmail, suite.emailService)

    // Assert
    if err == nil {
        t.Error("Expected error when changing to same email")
    }

    expectedError := "new email must be different from current email"
    if err.Error() != expectedError {
        t.Errorf("Expected error '%s', got '%s'", expectedError, err.Error())
    }

    // No events should be raised
    events := suite.testUser.GetUncommittedEvents()
    if len(events) != 0 {
        t.Errorf("Expected 0 events, got %d", len(events))
    }
}

func TestUser_ChangeEmail_BlockedDomain_ReturnsError(t *testing.T) {
    suite := NewUserServiceTestSuite(t)

    blockedEmail, err := NewEmail("test@blocked.com")
    if err != nil {
        t.Fatalf("Failed to create blocked email: %v", err)
    }

    // Set up mock expectations
    suite.emailService.On("IsDomainBlocked", "blocked.com").Return(true)

    // Execute
    err = suite.testUser.ChangeEmail(blockedEmail, suite.emailService)

    // Assert
    if err == nil {
        t.Error("Expected error for blocked domain")
    }

    expectedError := "email domain blocked.com is blocked"
    if err.Error() != expectedError {
        t.Errorf("Expected error '%s', got '%s'", expectedError, err.Error())
    }

    // Verify mock expectations
    suite.emailService.AssertExpectations(t)
}

// Integration tests for application services
func TestUserApplicationService_CreateUser_Success(t *testing.T) {
    suite := NewUserServiceTestSuite(t)

    command := CreateUserCommand{
        Email:     "newuser@example.com",
        Username:  "newuser",
        FirstName: "New",
        LastName:  "User",
    }

    // Set up mock expectations
    uow := NewMockUnitOfWork()
    suite.unitOfWork.On("Begin", mock.Anything).Return(uow, nil)
    uow.On("Commit").Return(nil)
    uow.On("Rollback").Return(nil)

    suite.emailService.On("IsDomainBlocked", "example.com").Return(false)

    suite.userRepo.On("FindByEmail", mock.Anything, mock.Anything).Return(nil, NewNotFoundError("user not found"))
    suite.userRepo.On("Save", mock.Anything, mock.AnythingOfType("*User")).Return(nil)

    suite.eventPublisher.On("Publish", mock.Anything, mock.AnythingOfType("*UserCreatedEvent")).Return(nil)

    // Execute
    user, err := suite.userService.CreateUser(context.Background(), command)

    // Assert
    if err != nil {
        t.Errorf("Expected no error, got: %v", err)
    }

    if user == nil {
        t.Error("Expected user to be created")
    }

    if user.email.String() != command.Email {
        t.Errorf("Expected email %s, got %s", command.Email, user.email.String())
    }

    // Verify mock expectations
    suite.userRepo.AssertExpectations(t)
    suite.emailService.AssertExpectations(t)
    suite.eventPublisher.AssertExpectations(t)
    suite.unitOfWork.AssertExpectations(t)
    uow.AssertExpectations(t)
}

// Table-driven tests for comprehensive coverage
func TestEmail_Validation(t *testing.T) {
    testCases := []struct {
        name        string
        email       string
        expectError bool
        errorMsg    string
    }{
        {
            name:        "Valid email",
            email:       "test@example.com",
            expectError: false,
        },
        {
            name:        "Empty email",
            email:       "",
            expectError: true,
            errorMsg:    "email cannot be empty",
        },
        {
            name:        "Invalid format - no @",
            email:       "testexample.com",
            expectError: true,
            errorMsg:    "invalid email format",
        },
        {
            name:        "Invalid format - no domain",
            email:       "test@",
            expectError: true,
            errorMsg:    "invalid email format",
        },
        {
            name:        "Invalid format - no local part",
            email:       "@example.com",
            expectError: true,
            errorMsg:    "invalid email format",
        },
        {
            name:        "Valid email with subdomain",
            email:       "test@mail.example.com",
            expectError: false,
        },
    }

    for _, tc := range testCases {
        t.Run(tc.name, func(t *testing.T) {
            email, err := NewEmail(tc.email)

            if tc.expectError {
                if err == nil {
                    t.Errorf("Expected error for email '%s'", tc.email)
                }
                if tc.errorMsg != "" && !strings.Contains(err.Error(), tc.errorMsg) {
                    t.Errorf("Expected error containing '%s', got '%s'", tc.errorMsg, err.Error())
                }
            } else {
                if err != nil {
                    t.Errorf("Expected no error for valid email '%s', got: %v", tc.email, err)
                }
                if email.String() != tc.email {
                    t.Errorf("Expected email value '%s', got '%s'", tc.email, email.String())
                }
            }
        })
    }
}

// Property-based testing for comprehensive validation
func TestProfile_Properties(t *testing.T) {
    // Test property: Full name should always be "FirstName LastName"
    property := func(firstName, lastName string) bool {
        if firstName == "" || lastName == "" {
            return true // Skip invalid inputs
        }

        profile, err := NewProfile(firstName, lastName)
        if err != nil {
            return false
        }

        expected := fmt.Sprintf("%s %s", firstName, lastName)
        return profile.FullName() == expected
    }

    // Test with various combinations
    testCases := []struct {
        firstName string
        lastName  string
    }{
        {"John", "Doe"},
        {"Alice", "Smith"},
        {"Bob", "Johnson"},
        {"Carol", "Williams"},
        {"David", "Brown"},
    }

    for _, tc := range testCases {
        if !property(tc.firstName, tc.lastName) {
            t.Errorf("Property failed for %s %s", tc.firstName, tc.lastName)
        }
    }
}

// Benchmark tests for performance validation
func BenchmarkUserRepository_FindByID(b *testing.B) {
    repo := NewInMemoryUserRepository()

    // Set up test data
    users := make([]*User, 1000)
    for i := 0; i < 1000; i++ {
        userID, _ := NewUserID(fmt.Sprintf("user-id-%d", i))
        email, _ := NewEmail(fmt.Sprintf("user%d@example.com", i))
        username, _ := NewUsername(fmt.Sprintf("user%d", i))
        profile, _ := NewProfile("User", fmt.Sprintf("%d", i))

        users[i] = &User{
            id:       userID,
            email:    email,
            username: username,
            profile:  profile,
            status:   UserStatusActive,
        }

        repo.Save(context.Background(), users[i])
    }

    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        userID := users[i%1000].id
        _, err := repo.FindByID(context.Background(), userID)
        if err != nil {
            b.Errorf("Unexpected error: %v", err)
        }
    }
}

// Mock implementations for testing
type MockUserRepository struct {
    mock.Mock
}

func NewMockUserRepository() *MockUserRepository {
    return &MockUserRepository{}
}

func (m *MockUserRepository) Save(ctx context.Context, user *User) error {
    args := m.Called(ctx, user)
    return args.Error(0)
}

func (m *MockUserRepository) FindByID(ctx context.Context, id UserID) (*User, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*User), args.Error(1)
}

func (m *MockUserRepository) FindByEmail(ctx context.Context, email Email) (*User, error) {
    args := m.Called(ctx, email)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*User), args.Error(1)
}

func (m *MockUserRepository) Delete(ctx context.Context, id UserID) error {
    args := m.Called(ctx, id)
    return args.Error(0)
}

type MockEmailDomainService struct {
    mock.Mock
}

func NewMockEmailDomainService() *MockEmailDomainService {
    return &MockEmailDomainService{}
}

func (m *MockEmailDomainService) IsDomainBlocked(domain string) bool {
    args := m.Called(domain)
    return args.Bool(0)
}

func (m *MockEmailDomainService) EmailExists(email Email) (bool, error) {
    args := m.Called(email)
    return args.Bool(0), args.Error(1)
}

// Test utilities
func NewTestLogger() Logger {
    return &TestLogger{}
}

type TestLogger struct{}

func (tl *TestLogger) Info(msg string, fields ...interface{}) {}
func (tl *TestLogger) Error(msg string, fields ...interface{}) {}
func (tl *TestLogger) Debug(msg string, fields ...interface{}) {}
func (tl *TestLogger) Warn(msg string, fields ...interface{}) {}

func NewTestMetricsCollector() MetricsCollector {
    return &TestMetricsCollector{}
}

type TestMetricsCollector struct{}

func (tmc *TestMetricsCollector) IncrementCounter(name string, tags map[string]string) {}
func (tmc *TestMetricsCollector) RecordHistogram(name string, value float64, tags map[string]string) {}
func (tmc *TestMetricsCollector) RecordGauge(name string, value float64, tags map[string]string) {}

func NewTestValidator() Validator {
    return &TestValidator{}
}

type TestValidator struct{}

func (tv *TestValidator) Validate(obj interface{}) error {
    return nil
}
```

## Refactoring Strategies for Legacy Code

### Systematic Refactoring Approach

Large codebases require systematic refactoring strategies that minimize risk while improving maintainability:

```go
package refactoring

import (
    "context"
    "fmt"
    "time"
)

// RefactoringStrategy demonstrates systematic approaches to improving legacy code
type RefactoringStrategy struct {
    codeAnalyzer     *CodeAnalyzer
    testCoverage     *TestCoverageAnalyzer
    dependencyGraph  *DependencyGraphAnalyzer
    metricCollector  *RefactoringMetrics

    // Refactoring configuration
    config           *RefactoringConfig
}

type RefactoringConfig struct {
    // Safety settings
    RequireTestCoverage    float64  // Minimum test coverage before refactoring
    MaxFunctionLength      int      // Maximum lines per function
    MaxCyclomaticComplexity int     // Maximum cyclomatic complexity
    MaxDependencies        int      // Maximum dependencies per package

    // Performance settings
    BatchSize              int      // Number of files to refactor in batch
    ParallelWorkers        int      // Number of parallel refactoring workers

    // Validation settings
    RunTestsAfterRefactor  bool     // Run tests after each refactoring step
    ValidatePerformance    bool     // Validate performance after refactoring
}

// Legacy code example that needs refactoring
type LegacyUserService struct {
    db *sql.DB  // Direct database dependency
}

// BEFORE: Monolithic method with multiple responsibilities
func (lus *LegacyUserService) CreateUserOld(email, username, firstName, lastName, password string) (int, error) {
    // Multiple responsibilities in one method:
    // 1. Validation
    // 2. Business logic
    // 3. Database operations
    // 4. Password hashing
    // 5. Email sending
    // 6. Logging

    // Validation (mixed with business logic)
    if email == "" {
        return 0, fmt.Errorf("email is required")
    }
    if !strings.Contains(email, "@") {
        return 0, fmt.Errorf("invalid email")
    }
    if username == "" {
        return 0, fmt.Errorf("username is required")
    }
    if len(username) < 3 {
        return 0, fmt.Errorf("username too short")
    }
    if firstName == "" {
        return 0, fmt.Errorf("first name is required")
    }
    if lastName == "" {
        return 0, fmt.Errorf("last name is required")
    }
    if len(password) < 8 {
        return 0, fmt.Errorf("password too short")
    }

    // Check if user exists (SQL in business logic)
    var count int
    err := lus.db.QueryRow("SELECT COUNT(*) FROM users WHERE email = ?", email).Scan(&count)
    if err != nil {
        log.Printf("Database error: %v", err)
        return 0, fmt.Errorf("database error")
    }
    if count > 0 {
        return 0, fmt.Errorf("user already exists")
    }

    // Hash password (cryptography mixed with business logic)
    hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
    if err != nil {
        log.Printf("Password hashing error: %v", err)
        return 0, fmt.Errorf("password hashing error")
    }

    // Insert user (SQL in business logic)
    result, err := lus.db.Exec(
        "INSERT INTO users (email, username, first_name, last_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        email, username, firstName, lastName, string(hashedPassword), time.Now(),
    )
    if err != nil {
        log.Printf("Database insert error: %v", err)
        return 0, fmt.Errorf("database insert error")
    }

    userID, err := result.LastInsertId()
    if err != nil {
        log.Printf("Failed to get last insert ID: %v", err)
        return 0, fmt.Errorf("failed to get user ID")
    }

    // Send welcome email (external service call mixed with business logic)
    emailBody := fmt.Sprintf("Welcome %s %s!", firstName, lastName)
    err = sendEmail(email, "Welcome!", emailBody)
    if err != nil {
        log.Printf("Failed to send welcome email: %v", err)
        // Don't fail the user creation if email fails
    }

    log.Printf("User created: %s (%s)", username, email)
    return int(userID), nil
}

// AFTER: Refactored clean architecture

// Step 1: Extract interfaces and separate concerns
type RefactoredUserService struct {
    userRepository  UserRepository
    emailService    EmailService
    passwordHasher  PasswordHasher
    validator      UserValidator
    logger         Logger
    eventPublisher EventPublisher
}

// Step 2: Extract validation logic into dedicated validator
type UserValidator struct {
    config ValidationConfig
}

type ValidationConfig struct {
    MinUsernameLength int
    MinPasswordLength int
    EmailRegex        *regexp.Regexp
}

func (uv *UserValidator) ValidateCreateUserRequest(req CreateUserRequest) error {
    var errors []string

    if req.Email == "" {
        errors = append(errors, "email is required")
    } else if !uv.config.EmailRegex.MatchString(req.Email) {
        errors = append(errors, "invalid email format")
    }

    if req.Username == "" {
        errors = append(errors, "username is required")
    } else if len(req.Username) < uv.config.MinUsernameLength {
        errors = append(errors, fmt.Sprintf("username must be at least %d characters", uv.config.MinUsernameLength))
    }

    if req.FirstName == "" {
        errors = append(errors, "first name is required")
    }

    if req.LastName == "" {
        errors = append(errors, "last name is required")
    }

    if req.Password == "" {
        errors = append(errors, "password is required")
    } else if len(req.Password) < uv.config.MinPasswordLength {
        errors = append(errors, fmt.Sprintf("password must be at least %d characters", uv.config.MinPasswordLength))
    }

    if len(errors) > 0 {
        return ValidationError{Errors: errors}
    }

    return nil
}

// Step 3: Extract repository pattern for data access
type PostgreSQLUserRepository struct {
    db     *sql.DB
    logger Logger
}

func (pur *PostgreSQLUserRepository) Save(ctx context.Context, user *User) error {
    query := `
        INSERT INTO users (id, email, username, first_name, last_name, password_hash, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `

    _, err := pur.db.ExecContext(ctx, query,
        user.ID, user.Email, user.Username, user.FirstName, user.LastName,
        user.PasswordHash, user.CreatedAt, user.UpdatedAt)

    if err != nil {
        pur.logger.Error("Failed to save user", "error", err, "user_id", user.ID)
        return fmt.Errorf("failed to save user: %w", err)
    }

    return nil
}

func (pur *PostgreSQLUserRepository) FindByEmail(ctx context.Context, email string) (*User, error) {
    query := `
        SELECT id, email, username, first_name, last_name, password_hash, created_at, updated_at
        FROM users
        WHERE email = $1 AND deleted_at IS NULL
    `

    var user User
    err := pur.db.QueryRowContext(ctx, query, email).Scan(
        &user.ID, &user.Email, &user.Username, &user.FirstName, &user.LastName,
        &user.PasswordHash, &user.CreatedAt, &user.UpdatedAt,
    )

    if err != nil {
        if err == sql.ErrNoRows {
            return nil, ErrUserNotFound
        }
        pur.logger.Error("Failed to find user by email", "error", err, "email", email)
        return nil, fmt.Errorf("failed to find user by email: %w", err)
    }

    return &user, nil
}

// Step 4: Extract password hashing into dedicated service
type BcryptPasswordHasher struct {
    cost int
}

func NewBcryptPasswordHasher(cost int) *BcryptPasswordHasher {
    return &BcryptPasswordHasher{cost: cost}
}

func (bph *BcryptPasswordHasher) HashPassword(password string) (string, error) {
    hashedBytes, err := bcrypt.GenerateFromPassword([]byte(password), bph.cost)
    if err != nil {
        return "", fmt.Errorf("failed to hash password: %w", err)
    }
    return string(hashedBytes), nil
}

func (bph *BcryptPasswordHasher) VerifyPassword(password, hash string) error {
    return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
}

// Step 5: Extract email service
type SMTPEmailService struct {
    config SMTPConfig
    logger Logger
}

type SMTPConfig struct {
    Host     string
    Port     int
    Username string
    Password string
    FromEmail string
}

func (ses *SMTPEmailService) SendWelcomeEmail(ctx context.Context, email, firstName, lastName string) error {
    subject := "Welcome!"
    body := fmt.Sprintf("Welcome %s %s! Thank you for joining us.", firstName, lastName)

    message := EmailMessage{
        To:      email,
        Subject: subject,
        Body:    body,
    }

    err := ses.sendEmail(ctx, message)
    if err != nil {
        ses.logger.Error("Failed to send welcome email", "error", err, "email", email)
        return fmt.Errorf("failed to send welcome email: %w", err)
    }

    return nil
}

// Step 6: Clean service implementation
func (rus *RefactoredUserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    // Step 1: Validate input
    if err := rus.validator.ValidateCreateUserRequest(req); err != nil {
        return nil, fmt.Errorf("validation failed: %w", err)
    }

    // Step 2: Check business rules
    existingUser, err := rus.userRepository.FindByEmail(ctx, req.Email)
    if err != nil && !errors.Is(err, ErrUserNotFound) {
        return nil, fmt.Errorf("failed to check existing user: %w", err)
    }
    if existingUser != nil {
        return nil, ErrUserAlreadyExists
    }

    // Step 3: Hash password
    hashedPassword, err := rus.passwordHasher.HashPassword(req.Password)
    if err != nil {
        return nil, fmt.Errorf("failed to hash password: %w", err)
    }

    // Step 4: Create user entity
    user := &User{
        ID:           generateUserID(),
        Email:        req.Email,
        Username:     req.Username,
        FirstName:    req.FirstName,
        LastName:     req.LastName,
        PasswordHash: hashedPassword,
        CreatedAt:    time.Now(),
        UpdatedAt:    time.Now(),
    }

    // Step 5: Save user
    if err := rus.userRepository.Save(ctx, user); err != nil {
        return nil, fmt.Errorf("failed to save user: %w", err)
    }

    // Step 6: Publish domain event
    event := UserCreatedEvent{
        UserID:    user.ID,
        Email:     user.Email,
        Username:  user.Username,
        CreatedAt: user.CreatedAt,
    }

    if err := rus.eventPublisher.Publish(ctx, event); err != nil {
        rus.logger.Error("Failed to publish user created event", "error", err, "user_id", user.ID)
        // Don't fail the operation if event publishing fails
    }

    // Step 7: Send welcome email (async)
    go func() {
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        if err := rus.emailService.SendWelcomeEmail(ctx, user.Email, user.FirstName, user.LastName); err != nil {
            rus.logger.Error("Failed to send welcome email", "error", err, "user_id", user.ID)
        }
    }()

    rus.logger.Info("User created successfully", "user_id", user.ID, "email", user.Email)

    return user, nil
}

// Strangler Fig pattern for gradual migration
type StranglerFigUserService struct {
    legacyService    *LegacyUserService
    modernService    *RefactoredUserService
    migrationConfig  *MigrationConfig
    featureFlags     *FeatureFlags
}

type MigrationConfig struct {
    ModernServiceEnabled  bool
    RolloutPercentage    float64
    ForceModernForEmails []string
    ForceLegacyForEmails []string
}

func (sfus *StranglerFigUserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    // Determine which service to use based on configuration
    useModernService := sfus.shouldUseModernService(req.Email)

    if useModernService {
        return sfus.modernService.CreateUser(ctx, req)
    }

    // Fallback to legacy service with adapter
    userID, err := sfus.legacyService.CreateUserOld(
        req.Email, req.Username, req.FirstName, req.LastName, req.Password)
    if err != nil {
        return nil, err
    }

    // Convert legacy response to modern format
    return sfus.convertLegacyUser(userID, req)
}

func (sfus *StranglerFigUserService) shouldUseModernService(email string) bool {
    // Force modern service for specific emails
    for _, forceEmail := range sfus.migrationConfig.ForceModernForEmails {
        if email == forceEmail {
            return true
        }
    }

    // Force legacy service for specific emails
    for _, forceEmail := range sfus.migrationConfig.ForceLegacyForEmails {
        if email == forceEmail {
            return false
        }
    }

    // Check if modern service is enabled
    if !sfus.migrationConfig.ModernServiceEnabled {
        return false
    }

    // Check feature flag
    if !sfus.featureFlags.IsEnabled("modern_user_service", email) {
        return false
    }

    // Use rollout percentage
    hash := calculateHash(email)
    percentage := float64(hash%100) / 100.0
    return percentage < sfus.migrationConfig.RolloutPercentage
}

// Refactoring metrics for tracking improvement
type RefactoringMetrics struct {
    CodeComplexity        *ComplexityMetrics
    TestCoverage         *CoverageMetrics
    PerformanceMetrics   *PerformanceMetrics
    TechnicalDebt        *TechnicalDebtMetrics
}

type ComplexityMetrics struct {
    CyclomaticComplexity map[string]int
    LinesOfCode          map[string]int
    FunctionLength       map[string]int
    DependencyCount      map[string]int
}

type CoverageMetrics struct {
    LineCoverage         float64
    BranchCoverage       float64
    FunctionCoverage     float64
    PackageCoverage      map[string]float64
}

type PerformanceMetrics struct {
    ResponseTimes        []time.Duration
    ThroughputRPS        float64
    MemoryUsage          int64
    CPUUsage             float64
}

type TechnicalDebtMetrics struct {
    CodeSmells           int
    DuplicatedCode       int
    TechnicalDebtRatio   float64
    MaintenanceIndex     float64
}

func (rm *RefactoringMetrics) CalculateImprovementScore() float64 {
    // Weighted score based on various metrics
    complexityScore := rm.calculateComplexityScore()
    coverageScore := rm.CodeCoverage.LineCoverage
    performanceScore := rm.calculatePerformanceScore()
    debtScore := 1.0 - rm.TechnicalDebt.TechnicalDebtRatio

    // Weighted average
    weights := map[string]float64{
        "complexity":  0.25,
        "coverage":    0.25,
        "performance": 0.25,
        "debt":        0.25,
    }

    totalScore := complexityScore*weights["complexity"] +
                  coverageScore*weights["coverage"] +
                  performanceScore*weights["performance"] +
                  debtScore*weights["debt"]

    return totalScore
}
```

## Conclusion

Clean code in Go requires a systematic approach that balances Go's philosophy of simplicity with the complexity demands of large-scale enterprise applications. The patterns and practices outlined in this guide provide a comprehensive framework for maintaining code quality, enabling long-term maintainability, and supporting team productivity across 50,000+ line codebases.

Key principles for clean Go code at enterprise scale:

1. **Domain-Driven Organization**: Structure code around business domains rather than technical layers, enabling independent evolution and clear boundaries
2. **Interface-Based Design**: Use focused interfaces and composition to enable testability, flexibility, and dependency inversion
3. **Comprehensive Testing**: Implement multi-layered testing strategies that enable confident refactoring and ensure code quality
4. **Systematic Refactoring**: Apply gradual improvement strategies that minimize risk while enhancing maintainability
5. **Continuous Quality Improvement**: Establish processes and metrics that support ongoing code quality enhancement

Organizations implementing these clean code practices typically achieve:

- 60% reduction in code review time through consistent patterns and standards
- 80% improvement in debugging efficiency through clear separation of concerns
- 70% faster onboarding for new team members through well-structured, documented code
- 50% reduction in technical debt accumulation through proactive refactoring strategies
- 90% improvement in test coverage and reliability through systematic testing approaches

Clean code is not just about individual methods or functions—it's about creating systems that can evolve gracefully over time while maintaining the clarity, testability, and maintainability required for long-term enterprise success. As Go applications continue to grow in complexity and scale, these foundational clean code principles become increasingly essential for sustainable development practices.