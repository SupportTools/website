---
title: "Implementing SOLID Principles in Go: A Practical Guide with Real-World Examples"
date: 2026-09-10T09:00:00-05:00
draft: false
tags: ["golang", "solid principles", "software architecture", "clean code", "best practices"]
categories: ["Development", "Go", "Software Design"]
---

## Introduction

The SOLID principles are fundamental guidelines for writing maintainable, extensible, and robust software. While these principles originated in object-oriented programming, they apply equally well to Go, despite its different approach to types and interfaces. This article expands on each SOLID principle with practical Go examples and explores how they can be effectively implemented in real-world applications.

## S - Single Responsibility Principle (SRP)

**"A module should have one, and only one, reason to change."**

The Single Responsibility Principle advises that a function, struct, or package should have a single, well-defined responsibility. This makes your code more modular, easier to understand, and simpler to maintain.

### Advanced SRP Example: User Service

Let's examine a more complex scenario where we're building a user management service. Instead of simply breaking down a function, we'll create distinct components with clear responsibilities:

```go
// user.go - Data model
type User struct {
    ID       string
    Email    string
    Password string
    Name     string
    Role     string
    Created  time.Time
}

// validator.go - Validation logic
type UserValidator struct {
    emailRegex *regexp.Regexp
}

func NewUserValidator() *UserValidator {
    return &UserValidator{
        emailRegex: regexp.MustCompile(`^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,4}$`),
    }
}

func (v *UserValidator) ValidateUser(user User) error {
    if user.Email == "" || !v.emailRegex.MatchString(user.Email) {
        return errors.New("invalid email format")
    }
    if len(user.Password) < 8 {
        return errors.New("password too short")
    }
    if user.Name == "" {
        return errors.New("name cannot be empty")
    }
    return nil
}

// repository.go - Data persistence
type UserRepository interface {
    Save(user User) error
    FindByEmail(email string) (User, error)
}

type PostgresUserRepository struct {
    db *sql.DB
}

func (r *PostgresUserRepository) Save(user User) error {
    // Implementation for saving to PostgreSQL
    return nil
}

func (r *PostgresUserRepository) FindByEmail(email string) (User, error) {
    // Implementation for finding by email in PostgreSQL
    return User{}, nil
}

// notification.go - User notifications
type NotificationService interface {
    SendWelcomeEmail(email, name string) error
}

type EmailNotificationService struct {
    smtpServer string
    from       string
}

func (s *EmailNotificationService) SendWelcomeEmail(email, name string) error {
    // Implementation for sending email
    return nil
}

// service.go - Business logic orchestration
type UserService struct {
    validator     *UserValidator
    repository    UserRepository
    notifications NotificationService
}

func NewUserService(
    validator *UserValidator,
    repository UserRepository,
    notifications NotificationService,
) *UserService {
    return &UserService{
        validator:     validator,
        repository:    repository,
        notifications: notifications,
    }
}

func (s *UserService) RegisterUser(user User) error {
    // 1. Validate user
    if err := s.validator.ValidateUser(user); err != nil {
        return fmt.Errorf("validation error: %w", err)
    }
    
    // 2. Check if user already exists
    existingUser, err := s.repository.FindByEmail(user.Email)
    if err == nil && existingUser.ID != "" {
        return errors.New("user with this email already exists")
    }
    
    // 3. Save user
    if err := s.repository.Save(user); err != nil {
        return fmt.Errorf("failed to save user: %w", err)
    }
    
    // 4. Send welcome email
    if err := s.notifications.SendWelcomeEmail(user.Email, user.Name); err != nil {
        log.Printf("Failed to send welcome email: %v", err)
        // We continue despite email failure
    }
    
    return nil
}
```

In this implementation:

1. Each component has a single responsibility: validation, storage, notification, or business logic.
2. The `UserService` orchestrates these components without implementing their details.
3. Changes to email validation don't affect the database operations.
4. We can easily swap out the notification service implementation without touching the rest of the code.

### SRP Benefits in Go

Go's package system naturally encourages SRP. Well-designed Go applications often have small, focused packages with clear boundaries. The standard library itself follows this principle—for example, separate packages handle HTTP serving, JSON parsing, and database operations.

## O - Open-Closed Principle (OCP)

**"Software entities should be open for extension, but closed for modification."**

The Open-Closed Principle suggests that code should be designed so that you can add new functionality without changing existing code. This principle is particularly important for maintaining stability in evolving codebases.

### Advanced OCP Example: Data Export System

Let's implement a data export system that follows OCP. We'll start with an interface that defines the contract for all exporters:

```go
// exporter.go
type DataExporter interface {
    Export(data []byte) (string, error)
    FileExtension() string
}

// Concrete implementation for JSON export
type JSONExporter struct{}

func (e JSONExporter) Export(data []byte) (string, error) {
    var obj interface{}
    if err := json.Unmarshal(data, &obj); err != nil {
        return "", fmt.Errorf("invalid JSON data: %w", err)
    }
    
    formatted, err := json.MarshalIndent(obj, "", "  ")
    if err != nil {
        return "", fmt.Errorf("error formatting JSON: %w", err)
    }
    
    return string(formatted), nil
}

func (e JSONExporter) FileExtension() string {
    return "json"
}

// Concrete implementation for CSV export
type CSVExporter struct {
    Delimiter rune
}

func (e CSVExporter) Export(data []byte) (string, error) {
    // Implementation details for CSV conversion
    return "csv data here", nil
}

func (e CSVExporter) FileExtension() string {
    return "csv"
}

// Service that uses exporters
type ExportService struct {
    exporters map[string]DataExporter
}

func NewExportService() *ExportService {
    service := &ExportService{
        exporters: make(map[string]DataExporter),
    }
    
    // Register default exporters
    service.RegisterExporter("json", JSONExporter{})
    service.RegisterExporter("csv", CSVExporter{Delimiter: ','})
    
    return service
}

func (s *ExportService) RegisterExporter(format string, exporter DataExporter) {
    s.exporters[format] = exporter
}

func (s *ExportService) ExportData(format string, data []byte) (string, string, error) {
    exporter, exists := s.exporters[format]
    if !exists {
        return "", "", fmt.Errorf("unsupported export format: %s", format)
    }
    
    result, err := exporter.Export(data)
    if err != nil {
        return "", "", err
    }
    
    return result, exporter.FileExtension(), nil
}
```

Now, when we want to add support for a new export format (like XML or PDF), we don't need to modify the existing code. We simply:

1. Create a new struct that implements the `DataExporter` interface
2. Register it with the `ExportService`

```go
// New implementation for XML export
type XMLExporter struct{}

func (e XMLExporter) Export(data []byte) (string, error) {
    // XML conversion logic
    return "<xml>data</xml>", nil
}

func (e XMLExporter) FileExtension() string {
    return "xml"
}

// Register the new exporter
func main() {
    service := NewExportService()
    service.RegisterExporter("xml", XMLExporter{})
    
    // Now we can export to XML without modifying existing code
    xmlData, ext, err := service.ExportData("xml", []byte(`{"name":"John"}`))
    if err != nil {
        log.Fatalf("Export failed: %v", err)
    }
    
    fmt.Printf("Exported to %s.%s: %s\n", "output", ext, xmlData)
}
```

### OCP in Go's Standard Library

Go's `io` package is an excellent example of OCP. The `io.Reader` and `io.Writer` interfaces allow you to write functions that work with any type implementing these interfaces, from files to network connections, without modifying the original code.

## L - Liskov Substitution Principle (LSP)

**"Objects of a superclass should be replaceable with objects of a subclass without affecting the correctness of the program."**

While Go doesn't have classes in the traditional sense, the Liskov Substitution Principle applies to interfaces and any type that implements them. Any concrete implementation should satisfy the expectations set by the interface.

### Advanced LSP Example: Storage Systems

Let's implement a file storage system where different storage providers (local, S3, GCS) must be interchangeable:

```go
// storage.go
type FileStorage interface {
    Save(path string, data []byte) error
    Load(path string) ([]byte, error)
    Delete(path string) error
    Exists(path string) (bool, error)
}

// Implementation for local filesystem
type LocalStorage struct {
    BasePath string
}

func (s *LocalStorage) fullPath(path string) string {
    return filepath.Join(s.BasePath, path)
}

func (s *LocalStorage) Save(path string, data []byte) error {
    fullPath := s.fullPath(path)
    
    // Create directory if it doesn't exist
    dir := filepath.Dir(fullPath)
    if err := os.MkdirAll(dir, 0755); err != nil {
        return fmt.Errorf("failed to create directory: %w", err)
    }
    
    return os.WriteFile(fullPath, data, 0644)
}

func (s *LocalStorage) Load(path string) ([]byte, error) {
    return os.ReadFile(s.fullPath(path))
}

func (s *LocalStorage) Delete(path string) error {
    return os.Remove(s.fullPath(path))
}

func (s *LocalStorage) Exists(path string) (bool, error) {
    _, err := os.Stat(s.fullPath(path))
    if err == nil {
        return true, nil
    }
    if os.IsNotExist(err) {
        return false, nil
    }
    return false, err
}

// Implementation for S3 storage
type S3Storage struct {
    Client    *s3.Client
    BucketName string
}

func (s *S3Storage) Save(path string, data []byte) error {
    // S3 implementation
    return nil
}

func (s *S3Storage) Load(path string) ([]byte, error) {
    // S3 implementation
    return nil, nil
}

func (s *S3Storage) Delete(path string) error {
    // S3 implementation
    return nil
}

func (s *S3Storage) Exists(path string) (bool, error) {
    // S3 implementation
    return false, nil
}
```

Now let's create a service that uses the storage interface:

```go
// file_service.go
type FileService struct {
    storage FileStorage
}

func NewFileService(storage FileStorage) *FileService {
    return &FileService{storage: storage}
}

func (s *FileService) SaveFile(path string, data []byte) error {
    exists, err := s.storage.Exists(path)
    if err != nil {
        return fmt.Errorf("error checking if file exists: %w", err)
    }
    
    if exists {
        return errors.New("file already exists")
    }
    
    return s.storage.Save(path, data)
}

func (s *FileService) GetFile(path string) ([]byte, error) {
    exists, err := s.storage.Exists(path)
    if err != nil {
        return nil, fmt.Errorf("error checking if file exists: %w", err)
    }
    
    if !exists {
        return nil, errors.New("file not found")
    }
    
    return s.storage.Load(path)
}
```

With this design, we can substitute any storage implementation that adheres to the `FileStorage` interface:

```go
func main() {
    // Using local storage
    localStorage := &LocalStorage{BasePath: "/tmp/files"}
    localFileService := NewFileService(localStorage)
    
    // Using S3 storage
    s3Storage := &S3Storage{
        Client:     s3Client,
        BucketName: "my-bucket",
    }
    s3FileService := NewFileService(s3Storage)
    
    // Both services work the same way, following LSP
    data := []byte("Hello, world!")
    
    if err := localFileService.SaveFile("test.txt", data); err != nil {
        log.Fatal(err)
    }
    
    if err := s3FileService.SaveFile("test.txt", data); err != nil {
        log.Fatal(err)
    }
}
```

This demonstrates LSP in action—we can substitute one storage implementation for another without affecting the behavior of the `FileService`.

### LSP Violations to Watch For

When implementing interfaces in Go, be careful to avoid these common LSP violations:

1. **Returning errors under different conditions** than what clients of the interface expect
2. **Partial implementation** where some methods are left with placeholder behavior
3. **Adding side effects** not present in other implementations
4. **Strengthening preconditions** or weakening postconditions

## I - Interface Segregation Principle (ISP)

**"Clients should not be forced to depend on methods they do not use."**

Go's small, focused interfaces are a perfect match for the Interface Segregation Principle. Instead of large interfaces with many methods, prefer smaller interfaces that are specific to client needs.

### Advanced ISP Example: Content Management System

Let's build a content management system with properly segregated interfaces:

```go
// Basic interfaces for different functionalities
type Renderer interface {
    Render(content string) (string, error)
}

type Publisher interface {
    Publish(content string, target string) error
}

type Validator interface {
    Validate(content string) error
}

type Versioner interface {
    SaveVersion(content string) (string, error)
    GetVersion(versionID string) (string, error)
    ListVersions() ([]string, error)
}

// Concrete implementations
type MarkdownRenderer struct{}

func (m MarkdownRenderer) Render(content string) (string, error) {
    // Convert markdown to HTML
    return "HTML content", nil
}

type HTMLRenderer struct{}

func (h HTMLRenderer) Render(content string) (string, error) {
    // Format HTML
    return "Formatted HTML", nil
}

type WebPublisher struct {
    CDNClient  *cdn.Client
    SiteConfig SiteConfig
}

func (w WebPublisher) Publish(content string, target string) error {
    // Publish to web server
    return nil
}

// Content service that uses these interfaces
type ContentService struct {
    renderer   Renderer
    publisher  Publisher
    validator  Validator
    versioner  Versioner
}

// Create specialized services for different content types
type ArticleService struct {
    ContentService
    keywords map[string]struct{} // For SEO
}

func (s *ArticleService) PublishArticle(content, title, target string) error {
    // Article-specific logic
    rendered, err := s.renderer.Render(content)
    if err != nil {
        return err
    }
    
    return s.publisher.Publish(rendered, target)
}

type ImageService struct {
    renderer  Renderer  // We might need this for image captions
    publisher Publisher
    // No need for validator or versioner for images
}

func (s *ImageService) PublishImage(imageData []byte, caption, target string) error {
    // Image-specific publishing logic
    return nil
}
```

This design follows ISP by:

1. Breaking down the CMS functionality into small, focused interfaces
2. Allowing each service to depend only on the interfaces it needs
3. Enabling specialized implementations tailored for different content types

### ISP Best Practices in Go

Go's standard library follows ISP extensively. For example, the `io` package defines `io.Reader`, `io.Writer`, `io.Closer`, etc., as separate interfaces, and then combines them when needed (`io.ReadWriter`, `io.ReadWriteCloser`).

```go
// Follow this pattern in your own code
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}

// Combined interface when needed
type ReadWriter interface {
    Reader
    Writer
}
```

## D - Dependency Inversion Principle (DIP)

**"High-level modules should not depend on low-level modules. Both should depend on abstractions."**

The DIP encourages us to use abstractions (interfaces) to decouple high-level and low-level components, making the system more flexible and easier to test.

### Advanced DIP Example: E-commerce Order Processing

Let's implement a complete order processing system following DIP:

```go
// Models
type Order struct {
    ID         string
    CustomerID string
    Items      []OrderItem
    Total      float64
    Status     string
    CreatedAt  time.Time
}

type OrderItem struct {
    ProductID string
    Quantity  int
    Price     float64
}

// Interfaces for all the dependencies
type OrderRepository interface {
    Save(order Order) error
    FindByID(id string) (Order, error)
    UpdateStatus(id, status string) error
}

type InventoryService interface {
    ReserveItems(items []OrderItem) error
    ReleaseItems(items []OrderItem) error
}

type PaymentProcessor interface {
    ProcessPayment(customerID string, amount float64) (string, error)
    RefundPayment(transactionID string) error
}

type NotificationService interface {
    NotifyOrderStatus(order Order) error
}

// High-level business logic module
type OrderProcessor struct {
    repository     OrderRepository
    inventory      InventoryService
    payment        PaymentProcessor
    notifications  NotificationService
    logger         Logger
}

func NewOrderProcessor(
    repo OrderRepository,
    inventory InventoryService,
    payment PaymentProcessor,
    notifications NotificationService,
    logger Logger,
) *OrderProcessor {
    return &OrderProcessor{
        repository:    repo,
        inventory:     inventory,
        payment:       payment,
        notifications: notifications,
        logger:        logger,
    }
}

func (p *OrderProcessor) ProcessOrder(order Order) error {
    // Step 1: Save the initial order
    if err := p.repository.Save(order); err != nil {
        return fmt.Errorf("failed to save order: %w", err)
    }
    
    // Step 2: Reserve inventory
    if err := p.inventory.ReserveItems(order.Items); err != nil {
        p.logger.Error("Failed to reserve inventory", "order_id", order.ID, "error", err)
        order.Status = "INVENTORY_ERROR"
        p.repository.UpdateStatus(order.ID, "INVENTORY_ERROR")
        p.notifications.NotifyOrderStatus(order)
        return fmt.Errorf("inventory reservation failed: %w", err)
    }
    
    // Step 3: Process payment
    transactionID, err := p.payment.ProcessPayment(order.CustomerID, order.Total)
    if err != nil {
        p.logger.Error("Payment processing failed", "order_id", order.ID, "error", err)
        // Release the previously reserved inventory
        p.inventory.ReleaseItems(order.Items)
        
        order.Status = "PAYMENT_FAILED"
        p.repository.UpdateStatus(order.ID, "PAYMENT_FAILED")
        p.notifications.NotifyOrderStatus(order)
        return fmt.Errorf("payment processing failed: %w", err)
    }
    
    // Step 4: Mark order as successful
    order.Status = "COMPLETED"
    if err := p.repository.UpdateStatus(order.ID, "COMPLETED"); err != nil {
        p.logger.Error("Failed to update order status", "order_id", order.ID, "error", err)
        // Order is still successful, just logging the error
    }
    
    // Step 5: Notify customer
    if err := p.notifications.NotifyOrderStatus(order); err != nil {
        p.logger.Error("Failed to send notification", "order_id", order.ID, "error", err)
        // Just log the error, don't affect the order processing
    }
    
    return nil
}
```

The main benefits of this DIP implementation:

1. **Testability**: We can easily mock each dependency for testing.
2. **Flexibility**: We can swap implementations without changing the `OrderProcessor`.
3. **Focus**: Each component focuses on its specific responsibility.

Let's look at how we might implement and inject these dependencies:

```go
func main() {
    // Database connection
    db := connectToDatabase()
    
    // Create concrete implementations
    orderRepo := postgres.NewOrderRepository(db)
    inventoryService := NewInventoryService(db)
    paymentProcessor := stripe.NewPaymentProcessor(apiKey)
    notificationService := email.NewNotificationService(emailConfig)
    logger := zap.NewProduction()
    
    // Inject dependencies
    orderProcessor := NewOrderProcessor(
        orderRepo,
        inventoryService,
        paymentProcessor,
        notificationService,
        logger,
    )
    
    // Use the order processor
    order := Order{
        ID:         uuid.New().String(),
        CustomerID: "cust-123",
        Items: []OrderItem{
            {ProductID: "prod-1", Quantity: 2, Price: 25.99},
            {ProductID: "prod-2", Quantity: 1, Price: 49.99},
        },
        Total:     101.97,
        Status:    "PENDING",
        CreatedAt: time.Now(),
    }
    
    if err := orderProcessor.ProcessOrder(order); err != nil {
        log.Fatalf("Failed to process order: %v", err)
    }
}
```

### Dependency Injection in Go

Go's simplicity makes dependency injection straightforward. You can:

1. **Constructor Injection**: Pass dependencies via constructor functions (as shown above)
2. **Field Injection**: Set dependencies as struct fields after construction
3. **Method Injection**: Pass dependencies as function parameters

For larger applications, consider using a lightweight DI container like [wire](https://github.com/google/wire) or [dig](https://github.com/uber-go/dig) to manage dependencies.

## Putting It All Together: A Complete Example

Let's combine all SOLID principles in a simple but complete blog API example:

```go
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"
)

// Models
type Post struct {
    ID      string
    Title   string
    Content string
    AuthorID string
    Tags     []string
    Created  time.Time
}

// S: Single Responsibility Principle
// Each interface has a specific responsibility

// Repository interfaces
type PostRepository interface {
    GetByID(id string) (Post, error)
    Save(post Post) error
    Delete(id string) error
    List(limit, offset int) ([]Post, error)
}

// Validation interfaces
type PostValidator interface {
    ValidatePost(post Post) error
}

// Formatting interfaces
type PostFormatter interface {
    FormatPost(post Post) ([]byte, error)
}

// I: Interface Segregation Principle
// Notification interfaces broken down by purpose
type CreationNotifier interface {
    NotifyPostCreation(post Post) error
}

type UpdateNotifier interface {
    NotifyPostUpdate(post Post) error
}

// O: Open-Closed Principle
// Formatter implementations for different output formats
type JSONFormatter struct{}

func (f JSONFormatter) FormatPost(post Post) ([]byte, error) {
    return json.Marshal(post)
}

type XMLFormatter struct{}

func (f XMLFormatter) FormatPost(post Post) ([]byte, error) {
    // XML formatting logic
    return []byte("<post>...</post>"), nil
}

// L: Liskov Substitution Principle
// Different repository implementations can be substituted
type SQLitePostRepository struct {
    db *sql.DB
}

func (r *SQLitePostRepository) GetByID(id string) (Post, error) {
    // SQLite implementation
    return Post{}, nil
}

func (r *SQLitePostRepository) Save(post Post) error {
    // SQLite implementation
    return nil
}

func (r *SQLitePostRepository) Delete(id string) error {
    // SQLite implementation
    return nil
}

func (r *SQLitePostRepository) List(limit, offset int) ([]Post, error) {
    // SQLite implementation
    return []Post{}, nil
}

// D: Dependency Inversion Principle
// High-level component depends on abstractions
type PostService struct {
    repository  PostRepository
    validator   PostValidator
    formatter   PostFormatter
    creationNotifier CreationNotifier
    updateNotifier   UpdateNotifier
}

func NewPostService(
    repo PostRepository,
    validator PostValidator,
    formatter PostFormatter,
    creationNotifier CreationNotifier,
    updateNotifier UpdateNotifier,
) *PostService {
    return &PostService{
        repository:       repo,
        validator:        validator,
        formatter:        formatter,
        creationNotifier: creationNotifier,
        updateNotifier:   updateNotifier,
    }
}

func (s *PostService) CreatePost(post Post) ([]byte, error) {
    // Validate post
    if err := s.validator.ValidatePost(post); err != nil {
        return nil, fmt.Errorf("validation error: %w", err)
    }
    
    // Generate ID and set creation time if not provided
    if post.ID == "" {
        post.ID = uuid.New().String()
    }
    if post.Created.IsZero() {
        post.Created = time.Now()
    }
    
    // Save post
    if err := s.repository.Save(post); err != nil {
        return nil, fmt.Errorf("failed to save post: %w", err)
    }
    
    // Notify about creation (non-blocking)
    go func() {
        if err := s.creationNotifier.NotifyPostCreation(post); err != nil {
            log.Printf("Failed to send creation notification: %v", err)
        }
    }()
    
    // Format and return post
    return s.formatter.FormatPost(post)
}

// HTTP Handler implementation
type PostHandler struct {
    service *PostService
}

func (h *PostHandler) CreatePostHandler(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    
    var post Post
    if err := json.NewDecoder(r.Body).Decode(&post); err != nil {
        http.Error(w, "Invalid request body", http.StatusBadRequest)
        return
    }
    
    formattedPost, err := h.service.CreatePost(post)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    w.Write(formattedPost)
}

// Main function for wiring everything together
func main() {
    // Create dependencies
    db := setupDatabase()
    repository := &SQLitePostRepository{db: db}
    validator := &DefaultPostValidator{}
    formatter := JSONFormatter{}
    creationNotifier := &EmailNotifier{smtpConfig: config.SMTP}
    updateNotifier := &EmailNotifier{smtpConfig: config.SMTP}
    
    // Create service with dependencies injected
    service := NewPostService(
        repository,
        validator,
        formatter,
        creationNotifier,
        updateNotifier,
    )
    
    // Create HTTP handler
    handler := &PostHandler{service: service}
    
    // Setup routes
    http.HandleFunc("/posts", handler.CreatePostHandler)
    
    // Start server
    log.Println("Server starting on :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

## SOLID in the Go Standard Library

The Go standard library itself is an excellent example of SOLID principles in action:

1. **SRP**: Each package has a clear, focused purpose (e.g., `net/http` for HTTP, `encoding/json` for JSON).
2. **OCP**: Interfaces like `io.Reader` allow extending functionality without modification.
3. **LSP**: Types like `bytes.Buffer` and `os.File` can be used interchangeably wherever an `io.Reader` is expected.
4. **ISP**: Small interfaces like `io.Reader`, `io.Writer`, and `io.Closer` are defined separately and combined when needed.
5. **DIP**: High-level functions depend on interfaces rather than concrete implementations (e.g., `http.ServeContent` works with any `io.ReadSeeker`).

## Testing SOLID Go Code

One of the major benefits of following SOLID principles is testability. When your code adheres to these principles, it becomes much easier to write comprehensive tests.

Here's how to test the `PostService` implementation:

```go
func TestPostService_CreatePost(t *testing.T) {
    // Create mocks for dependencies
    mockRepo := &MockPostRepository{}
    mockValidator := &MockPostValidator{}
    mockFormatter := &MockPostFormatter{}
    mockCreationNotifier := &MockCreationNotifier{}
    mockUpdateNotifier := &MockUpdateNotifier{}
    
    // Setup expected behavior
    mockValidator.On("ValidatePost", mock.Anything).Return(nil)
    mockRepo.On("Save", mock.Anything).Return(nil)
    mockFormatter.On("FormatPost", mock.Anything).Return([]byte(`{"id":"test-id"}`), nil)
    mockCreationNotifier.On("NotifyPostCreation", mock.Anything).Return(nil)
    
    // Create service with mocked dependencies
    service := NewPostService(
        mockRepo,
        mockValidator,
        mockFormatter,
        mockCreationNotifier,
        mockUpdateNotifier,
    )
    
    // Test create post
    post := Post{
        Title:    "Test Post",
        Content:  "This is a test post",
        AuthorID: "author-123",
    }
    
    result, err := service.CreatePost(post)
    
    // Assert results
    assert.NoError(t, err)
    assert.Equal(t, []byte(`{"id":"test-id"}`), result)
    
    // Verify interactions
    mockValidator.AssertCalled(t, "ValidatePost", mock.Anything)
    mockRepo.AssertCalled(t, "Save", mock.Anything)
    mockFormatter.AssertCalled(t, "FormatPost", mock.Anything)
    
    // Creation notification is asynchronous, so we need to wait a bit
    time.Sleep(100 * time.Millisecond)
    mockCreationNotifier.AssertCalled(t, "NotifyPostCreation", mock.Anything)
}
```

## Common Pitfalls and Anti-patterns

As you implement SOLID principles in Go, watch out for these common pitfalls:

1. **Interface Pollution**: Creating too many tiny interfaces that don't serve a clear purpose
2. **Over-Engineering**: Adding unnecessary abstractions when a simple function would suffice
3. **Premature Abstraction**: Creating interfaces before you have multiple implementations
4. **Rigid Contracts**: Designing interfaces with too many methods, making them harder to implement
5. **Mock-Driven Development**: Focusing too much on testability at the expense of usable API design

## SOLID in Go Project Structure

SOLID principles can also guide your project structure:

```
my-project/
├── cmd/          # Main applications
│   └── server/   # Entry point
├── internal/     # Private packages
│   ├── domain/   # Business models and interfaces (SRP, ISP)
│   ├── service/  # Business logic (DIP)
│   ├── storage/  # Database implementations (OCP, LSP)
│   └── api/      # HTTP handlers
├── pkg/          # Public packages
│   ├── validator/   # Validation utilities
│   └── formatter/   # Formatting utilities
└── go.mod        # Go module file
```

This structure encourages separation of concerns, dependency inversion, and interface segregation.

## Conclusion

SOLID principles offer valuable guidance for designing Go applications that are maintainable, extensible, and robust. While Go's approach to types, interfaces, and modules differs from traditional object-oriented languages, the principles apply just as effectively.

By focusing on:
- Single, clear responsibilities (SRP)
- Extending rather than modifying (OCP)
- Ensuring substitutability (LSP)
- Creating focused interfaces (ISP)
- Depending on abstractions (DIP)

You can write Go code that's easier to maintain, test, and extend as requirements evolve.

Remember that SOLID principles are guidelines, not strict rules. Apply them thoughtfully based on your specific needs, and don't be afraid to compromise when pragmatism dictates a simpler approach. The ultimate goal is maintainable code that solves real problems efficiently.