---
title: "Implementing the Repository Pattern in Go Across Database Types"
date: 2027-04-08T09:00:00-05:00
draft: false
tags: ["Go", "Repository Pattern", "Database", "PostgreSQL", "MongoDB", "Neo4j", "Redis", "Design Patterns"]
categories: ["Software Architecture", "Go Programming"]
---

The repository pattern remains one of the most powerful architectural patterns for separating business logic from data access concerns. In Go applications, a well-implemented repository layer can dramatically improve maintainability, testability, and flexibility when working with various database technologies. This comprehensive guide explores implementing the repository pattern in Go across different database paradigms, with practical examples, advanced techniques, and real-world considerations.

## Table of Contents

1. [Understanding the Repository Pattern](#understanding-the-repository-pattern)
2. [Core Repository Pattern Implementation in Go](#core-repository-pattern-implementation-in-go)
3. [Relational Databases with Go](#relational-databases-with-go)
4. [Document Databases with Go](#document-databases-with-go)
5. [Graph Databases with Go](#graph-databases-with-go)
6. [Key-Value Stores with Go](#key-value-stores-with-go)
7. [Repository Composition and Inheritance](#repository-composition-and-inheritance)
8. [Testing Repository Implementations](#testing-repository-implementations)
9. [Advanced Repository Techniques](#advanced-repository-techniques)
10. [Multi-Database Repositories](#multi-database-repositories)
11. [Performance Considerations](#performance-considerations)
12. [Conclusion](#conclusion)

## Understanding the Repository Pattern

The repository pattern serves as an intermediary between the domain model and data access layers in an application.

### Core Principles

1. **Abstraction of Data Storage**: Repositories abstract the details of data storage, retrieval, and manipulation, allowing business logic to work with domain objects without knowing how they're persisted.

2. **Domain-Focused Interface**: A repository provides methods that align with domain concepts rather than database operations.

3. **Separation of Concerns**: With repositories, your application's business logic remains clean and separated from persistence details.

4. **Enhanced Testability**: Using interfaces for repositories makes it easy to substitute mock implementations during testing.

### The Repository in a Clean Architecture

In a clean architecture, the repository sits at the boundary between the domain and infrastructure layers:

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│                  │     │                  │     │                  │
│  Domain Layer    │     │  Application     │     │  Infrastructure  │
│  (Entities,      │◄────┤  Layer           │◄────┤  Layer           │
│   Value Objects) │     │  (Use Cases)     │     │  (Repositories,  │
│                  │     │                  │     │   DB Adapters)   │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

## Core Repository Pattern Implementation in Go

Let's establish a foundation for the repository pattern in Go with a generic approach.

### Domain Entity and Repository Interface

First, we define a domain entity and its repository interface:

```go
// User represents a user in our system
type User struct {
    ID       string
    Username string
    Email    string
    Created  time.Time
}

// UserRepository defines operations for working with users
type UserRepository interface {
    Create(ctx context.Context, user User) (User, error)
    FindByID(ctx context.Context, id string) (User, error)
    FindByEmail(ctx context.Context, email string) (User, error)
    Update(ctx context.Context, user User) error
    Delete(ctx context.Context, id string) error
    List(ctx context.Context, limit, offset int) ([]User, error)
}
```

### Generic Repository Structure

A generic repository structure can also be defined to reduce duplication:

```go
// Repository defines common operations available for all entities
type Repository[T any, ID comparable] interface {
    Create(ctx context.Context, entity T) (T, error)
    FindByID(ctx context.Context, id ID) (T, error)
    Update(ctx context.Context, entity T) error
    Delete(ctx context.Context, id ID) error
    List(ctx context.Context, limit, offset int) ([]T, error)
}
```

This generic approach leverages Go's type parameters introduced in Go 1.18, allowing for type-safe repository implementations.

## Relational Databases with Go

Relational databases like PostgreSQL, MySQL, and SQLite organize data into structured tables with predefined schemas. Let's implement the repository pattern for a relational database using both raw SQL and an ORM.

### Repository Implementation with Raw SQL

```go
// SQLUserRepository implements UserRepository using raw SQL
type SQLUserRepository struct {
    db *sql.DB
}

// NewSQLUserRepository creates a new SQLUserRepository
func NewSQLUserRepository(db *sql.DB) *SQLUserRepository {
    return &SQLUserRepository{db: db}
}

// Create adds a new user to the database
func (r *SQLUserRepository) Create(ctx context.Context, user User) (User, error) {
    if user.ID == "" {
        user.ID = uuid.New().String()
    }
    
    if user.Created.IsZero() {
        user.Created = time.Now()
    }
    
    query := `
        INSERT INTO users (id, username, email, created)
        VALUES ($1, $2, $3, $4)
        RETURNING id, username, email, created
    `
    
    err := r.db.QueryRowContext(
        ctx, 
        query, 
        user.ID, 
        user.Username, 
        user.Email, 
        user.Created,
    ).Scan(&user.ID, &user.Username, &user.Email, &user.Created)
    
    if err != nil {
        return User{}, fmt.Errorf("failed to create user: %w", err)
    }
    
    return user, nil
}

// FindByID retrieves a user by ID
func (r *SQLUserRepository) FindByID(ctx context.Context, id string) (User, error) {
    query := `
        SELECT id, username, email, created
        FROM users
        WHERE id = $1
    `
    
    var user User
    err := r.db.QueryRowContext(ctx, query, id).Scan(
        &user.ID,
        &user.Username,
        &user.Email,
        &user.Created,
    )
    
    if err != nil {
        if err == sql.ErrNoRows {
            return User{}, fmt.Errorf("user not found: %w", err)
        }
        return User{}, fmt.Errorf("failed to find user: %w", err)
    }
    
    return user, nil
}

// Update modifies an existing user
func (r *SQLUserRepository) Update(ctx context.Context, user User) error {
    query := `
        UPDATE users
        SET username = $1, email = $2
        WHERE id = $3
    `
    
    result, err := r.db.ExecContext(ctx, query, user.Username, user.Email, user.ID)
    if err != nil {
        return fmt.Errorf("failed to update user: %w", err)
    }
    
    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("failed to get rows affected: %w", err)
    }
    
    if rowsAffected == 0 {
        return fmt.Errorf("user not found")
    }
    
    return nil
}

// Delete removes a user by ID
func (r *SQLUserRepository) Delete(ctx context.Context, id string) error {
    query := `DELETE FROM users WHERE id = $1`
    
    result, err := r.db.ExecContext(ctx, query, id)
    if err != nil {
        return fmt.Errorf("failed to delete user: %w", err)
    }
    
    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("failed to get rows affected: %w", err)
    }
    
    if rowsAffected == 0 {
        return fmt.Errorf("user not found")
    }
    
    return nil
}

// List retrieves users with pagination
func (r *SQLUserRepository) List(ctx context.Context, limit, offset int) ([]User, error) {
    query := `
        SELECT id, username, email, created
        FROM users
        ORDER BY created DESC
        LIMIT $1 OFFSET $2
    `
    
    rows, err := r.db.QueryContext(ctx, query, limit, offset)
    if err != nil {
        return nil, fmt.Errorf("failed to list users: %w", err)
    }
    defer rows.Close()
    
    var users []User
    for rows.Next() {
        var user User
        if err := rows.Scan(&user.ID, &user.Username, &user.Email, &user.Created); err != nil {
            return nil, fmt.Errorf("failed to scan user: %w", err)
        }
        users = append(users, user)
    }
    
    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("error iterating users: %w", err)
    }
    
    return users, nil
}

// FindByEmail retrieves a user by email
func (r *SQLUserRepository) FindByEmail(ctx context.Context, email string) (User, error) {
    query := `
        SELECT id, username, email, created
        FROM users
        WHERE email = $1
    `
    
    var user User
    err := r.db.QueryRowContext(ctx, query, email).Scan(
        &user.ID,
        &user.Username,
        &user.Email,
        &user.Created,
    )
    
    if err != nil {
        if err == sql.ErrNoRows {
            return User{}, fmt.Errorf("user not found: %w", err)
        }
        return User{}, fmt.Errorf("failed to find user by email: %w", err)
    }
    
    return user, nil
}
```

### Repository Implementation with GORM

[GORM](https://gorm.io/) is a popular ORM for Go that simplifies database operations. Here's how to implement our repository with GORM:

```go
// GormUserRepository implements UserRepository using GORM
type GormUserRepository struct {
    db *gorm.DB
}

// GormUser is the GORM model for User
type GormUser struct {
    ID       string `gorm:"primarykey"`
    Username string `gorm:"uniqueIndex"`
    Email    string `gorm:"uniqueIndex"`
    Created  time.Time
}

// ToEntity converts GormUser to User domain entity
func (g *GormUser) ToEntity() User {
    return User{
        ID:       g.ID,
        Username: g.Username,
        Email:    g.Email,
        Created:  g.Created,
    }
}

// FromEntity creates GormUser from User entity
func FromEntity(user User) GormUser {
    return GormUser{
        ID:       user.ID,
        Username: user.Username,
        Email:    user.Email,
        Created:  user.Created,
    }
}

// NewGormUserRepository creates a new GormUserRepository
func NewGormUserRepository(db *gorm.DB) *GormUserRepository {
    return &GormUserRepository{db: db}
}

// Create adds a new user to the database
func (r *GormUserRepository) Create(ctx context.Context, user User) (User, error) {
    if user.ID == "" {
        user.ID = uuid.New().String()
    }
    
    if user.Created.IsZero() {
        user.Created = time.Now()
    }
    
    gormUser := FromEntity(user)
    
    result := r.db.WithContext(ctx).Create(&gormUser)
    if result.Error != nil {
        return User{}, fmt.Errorf("failed to create user: %w", result.Error)
    }
    
    return gormUser.ToEntity(), nil
}

// FindByID retrieves a user by ID
func (r *GormUserRepository) FindByID(ctx context.Context, id string) (User, error) {
    var gormUser GormUser
    
    result := r.db.WithContext(ctx).First(&gormUser, "id = ?", id)
    if result.Error != nil {
        if errors.Is(result.Error, gorm.ErrRecordNotFound) {
            return User{}, fmt.Errorf("user not found: %w", result.Error)
        }
        return User{}, fmt.Errorf("failed to find user: %w", result.Error)
    }
    
    return gormUser.ToEntity(), nil
}

// Update modifies an existing user
func (r *GormUserRepository) Update(ctx context.Context, user User) error {
    gormUser := FromEntity(user)
    
    result := r.db.WithContext(ctx).Model(&gormUser).
        Where("id = ?", user.ID).
        Updates(map[string]interface{}{
            "username": user.Username,
            "email":    user.Email,
        })
    
    if result.Error != nil {
        return fmt.Errorf("failed to update user: %w", result.Error)
    }
    
    if result.RowsAffected == 0 {
        return fmt.Errorf("user not found")
    }
    
    return nil
}

// Delete removes a user by ID
func (r *GormUserRepository) Delete(ctx context.Context, id string) error {
    result := r.db.WithContext(ctx).Delete(&GormUser{}, "id = ?", id)
    
    if result.Error != nil {
        return fmt.Errorf("failed to delete user: %w", result.Error)
    }
    
    if result.RowsAffected == 0 {
        return fmt.Errorf("user not found")
    }
    
    return nil
}

// List retrieves users with pagination
func (r *GormUserRepository) List(ctx context.Context, limit, offset int) ([]User, error) {
    var gormUsers []GormUser
    
    result := r.db.WithContext(ctx).
        Order("created DESC").
        Limit(limit).
        Offset(offset).
        Find(&gormUsers)
    
    if result.Error != nil {
        return nil, fmt.Errorf("failed to list users: %w", result.Error)
    }
    
    users := make([]User, len(gormUsers))
    for i, gormUser := range gormUsers {
        users[i] = gormUser.ToEntity()
    }
    
    return users, nil
}

// FindByEmail retrieves a user by email
func (r *GormUserRepository) FindByEmail(ctx context.Context, email string) (User, error) {
    var gormUser GormUser
    
    result := r.db.WithContext(ctx).First(&gormUser, "email = ?", email)
    if result.Error != nil {
        if errors.Is(result.Error, gorm.ErrRecordNotFound) {
            return User{}, fmt.Errorf("user not found: %w", result.Error)
        }
        return User{}, fmt.Errorf("failed to find user by email: %w", result.Error)
    }
    
    return gormUser.ToEntity(), nil
}
```

### Transactions with the Repository Pattern

Transactions are essential for maintaining data integrity. Here's how to implement transaction support in our repository:

```go
// TransactionManager defines methods for managing database transactions
type TransactionManager interface {
    WithTransaction(ctx context.Context, fn func(ctx context.Context) error) error
}

// SQLTransactionManager implements TransactionManager for SQL databases
type SQLTransactionManager struct {
    db *sql.DB
}

// NewSQLTransactionManager creates a new SQLTransactionManager
func NewSQLTransactionManager(db *sql.DB) *SQLTransactionManager {
    return &SQLTransactionManager{db: db}
}

// WithTransaction executes the given function in a transaction
func (m *SQLTransactionManager) WithTransaction(ctx context.Context, fn func(ctx context.Context) error) error {
    tx, err := m.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("failed to begin transaction: %w", err)
    }
    
    // Create a context with the transaction
    txCtx := context.WithValue(ctx, "tx", tx)
    
    // Execute the function
    if err := fn(txCtx); err != nil {
        // Rollback on error
        if rbErr := tx.Rollback(); rbErr != nil {
            return fmt.Errorf("error rolling back transaction: %v (original error: %w)", rbErr, err)
        }
        return err
    }
    
    // Commit the transaction
    if err := tx.Commit(); err != nil {
        return fmt.Errorf("failed to commit transaction: %w", err)
    }
    
    return nil
}

// Example usage of the transaction manager
func RegisterUserWithTransaction(ctx context.Context, repo UserRepository, txManager TransactionManager, user User) error {
    return txManager.WithTransaction(ctx, func(txCtx context.Context) error {
        // Create the user
        createdUser, err := repo.Create(txCtx, user)
        if err != nil {
            return err
        }
        
        // Perform additional operations in the same transaction
        // e.g., create default user settings
        // userSettingsRepo.Create(txCtx, UserSettings{UserID: createdUser.ID})
        
        return nil
    })
}
```

## Document Databases with Go

Document databases like MongoDB store data as flexible, JSON-like documents without requiring a fixed schema. Let's implement the repository pattern for MongoDB.

### Repository Implementation with MongoDB

```go
// MongoUserRepository implements UserRepository using MongoDB
type MongoUserRepository struct {
    collection *mongo.Collection
}

// NewMongoUserRepository creates a new MongoUserRepository
func NewMongoUserRepository(collection *mongo.Collection) *MongoUserRepository {
    return &MongoUserRepository{
        collection: collection,
    }
}

// Create adds a new user to the database
func (r *MongoUserRepository) Create(ctx context.Context, user User) (User, error) {
    if user.ID == "" {
        user.ID = primitive.NewObjectID().Hex()
    }
    
    if user.Created.IsZero() {
        user.Created = time.Now()
    }
    
    // Convert string ID to ObjectID for MongoDB
    objectID, err := primitive.ObjectIDFromHex(user.ID)
    if err != nil {
        // If ID is not a valid ObjectID, create a new one
        objectID = primitive.NewObjectID()
        user.ID = objectID.Hex()
    }
    
    // Create document with MongoDB _id field
    document := bson.M{
        "_id":      objectID,
        "username": user.Username,
        "email":    user.Email,
        "created":  user.Created,
    }
    
    _, err = r.collection.InsertOne(ctx, document)
    if err != nil {
        return User{}, fmt.Errorf("failed to create user: %w", err)
    }
    
    return user, nil
}

// FindByID retrieves a user by ID
func (r *MongoUserRepository) FindByID(ctx context.Context, id string) (User, error) {
    objectID, err := primitive.ObjectIDFromHex(id)
    if err != nil {
        return User{}, fmt.Errorf("invalid ID format: %w", err)
    }
    
    var result bson.M
    err = r.collection.FindOne(ctx, bson.M{"_id": objectID}).Decode(&result)
    if err != nil {
        if errors.Is(err, mongo.ErrNoDocuments) {
            return User{}, fmt.Errorf("user not found: %w", err)
        }
        return User{}, fmt.Errorf("failed to find user: %w", err)
    }
    
    user := User{
        ID:       objectID.Hex(),
        Username: result["username"].(string),
        Email:    result["email"].(string),
        Created:  result["created"].(primitive.DateTime).Time(),
    }
    
    return user, nil
}

// Update modifies an existing user
func (r *MongoUserRepository) Update(ctx context.Context, user User) error {
    objectID, err := primitive.ObjectIDFromHex(user.ID)
    if err != nil {
        return fmt.Errorf("invalid ID format: %w", err)
    }
    
    update := bson.M{
        "$set": bson.M{
            "username": user.Username,
            "email":    user.Email,
        },
    }
    
    result, err := r.collection.UpdateOne(ctx, bson.M{"_id": objectID}, update)
    if err != nil {
        return fmt.Errorf("failed to update user: %w", err)
    }
    
    if result.MatchedCount == 0 {
        return fmt.Errorf("user not found")
    }
    
    return nil
}

// Delete removes a user by ID
func (r *MongoUserRepository) Delete(ctx context.Context, id string) error {
    objectID, err := primitive.ObjectIDFromHex(id)
    if err != nil {
        return fmt.Errorf("invalid ID format: %w", err)
    }
    
    result, err := r.collection.DeleteOne(ctx, bson.M{"_id": objectID})
    if err != nil {
        return fmt.Errorf("failed to delete user: %w", err)
    }
    
    if result.DeletedCount == 0 {
        return fmt.Errorf("user not found")
    }
    
    return nil
}

// List retrieves users with pagination
func (r *MongoUserRepository) List(ctx context.Context, limit, offset int) ([]User, error) {
    opts := options.Find().
        SetSort(bson.M{"created": -1}).
        SetLimit(int64(limit)).
        SetSkip(int64(offset))
    
    cursor, err := r.collection.Find(ctx, bson.M{}, opts)
    if err != nil {
        return nil, fmt.Errorf("failed to list users: %w", err)
    }
    defer cursor.Close(ctx)
    
    var results []bson.M
    if err := cursor.All(ctx, &results); err != nil {
        return nil, fmt.Errorf("failed to decode users: %w", err)
    }
    
    users := make([]User, len(results))
    for i, result := range results {
        objectID := result["_id"].(primitive.ObjectID)
        users[i] = User{
            ID:       objectID.Hex(),
            Username: result["username"].(string),
            Email:    result["email"].(string),
            Created:  result["created"].(primitive.DateTime).Time(),
        }
    }
    
    return users, nil
}

// FindByEmail retrieves a user by email
func (r *MongoUserRepository) FindByEmail(ctx context.Context, email string) (User, error) {
    var result bson.M
    err := r.collection.FindOne(ctx, bson.M{"email": email}).Decode(&result)
    if err != nil {
        if errors.Is(err, mongo.ErrNoDocuments) {
            return User{}, fmt.Errorf("user not found: %w", err)
        }
        return User{}, fmt.Errorf("failed to find user by email: %w", err)
    }
    
    objectID := result["_id"].(primitive.ObjectID)
    user := User{
        ID:       objectID.Hex(),
        Username: result["username"].(string),
        Email:    result["email"].(string),
        Created:  result["created"].(primitive.DateTime).Time(),
    }
    
    return user, nil
}
```

### Handling MongoDB Transactions

MongoDB supports multi-document transactions in replica sets:

```go
// MongoTransactionManager implements TransactionManager for MongoDB
type MongoTransactionManager struct {
    client *mongo.Client
}

// NewMongoTransactionManager creates a new MongoTransactionManager
func NewMongoTransactionManager(client *mongo.Client) *MongoTransactionManager {
    return &MongoTransactionManager{client: client}
}

// WithTransaction executes the given function in a transaction
func (m *MongoTransactionManager) WithTransaction(ctx context.Context, fn func(ctx context.Context) error) error {
    // Start a session
    session, err := m.client.StartSession()
    if err != nil {
        return fmt.Errorf("failed to start session: %w", err)
    }
    defer session.EndSession(ctx)
    
    // Execute the transaction
    _, err = session.WithTransaction(ctx, func(sessCtx mongo.SessionContext) (interface{}, error) {
        if err := fn(sessCtx); err != nil {
            return nil, err
        }
        return nil, nil
    })
    
    return err
}
```

## Graph Databases with Go

Graph databases like Neo4j model data as nodes, relationships, and properties. They're excellent for highly interconnected data. Let's implement the repository pattern for Neo4j.

### Repository Implementation with Neo4j

First, let's define user and friendship repositories:

```go
// UserRepository for Neo4j
type UserRepository interface {
    Create(ctx context.Context, user User) (User, error)
    FindByID(ctx context.Context, id string) (User, error)
    FindByEmail(ctx context.Context, email string) (User, error)
    Update(ctx context.Context, user User) error
    Delete(ctx context.Context, id string) error
    List(ctx context.Context, limit, offset int) ([]User, error)
}

// FriendshipRepository defines methods for managing user friendships
type FriendshipRepository interface {
    CreateFriendship(ctx context.Context, userID1, userID2 string) error
    DeleteFriendship(ctx context.Context, userID1, userID2 string) error
    GetFriends(ctx context.Context, userID string, limit, offset int) ([]User, error)
    AreFriends(ctx context.Context, userID1, userID2 string) (bool, error)
}
```

Now, let's implement these repositories with Neo4j:

```go
// Neo4jUserRepository implements UserRepository using Neo4j
type Neo4jUserRepository struct {
    driver neo4j.Driver
}

// NewNeo4jUserRepository creates a new Neo4jUserRepository
func NewNeo4jUserRepository(driver neo4j.Driver) *Neo4jUserRepository {
    return &Neo4jUserRepository{driver: driver}
}

// Create adds a new user to the database
func (r *Neo4jUserRepository) Create(ctx context.Context, user User) (User, error) {
    if user.ID == "" {
        user.ID = uuid.New().String()
    }
    
    if user.Created.IsZero() {
        user.Created = time.Now()
    }
    
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        CREATE (u:User {
            id: $id,
            username: $username,
            email: $email,
            created: $created
        })
        RETURN u.id, u.username, u.email, u.created
    `, map[string]interface{}{
        "id":       user.ID,
        "username": user.Username,
        "email":    user.Email,
        "created":  user.Created.Format(time.RFC3339),
    })
    
    if err != nil {
        return User{}, fmt.Errorf("failed to create user: %w", err)
    }
    
    // Extract result
    if result.Next(ctx) {
        record := result.Record()
        
        // Parse created time
        createdStr, _ := record.Get("u.created")
        created, _ := time.Parse(time.RFC3339, createdStr.(string))
        
        return User{
            ID:       record.Values[0].(string),
            Username: record.Values[1].(string),
            Email:    record.Values[2].(string),
            Created:  created,
        }, nil
    }
    
    return User{}, fmt.Errorf("failed to retrieve created user")
}

// FindByID retrieves a user by ID
func (r *Neo4jUserRepository) FindByID(ctx context.Context, id string) (User, error) {
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u:User {id: $id})
        RETURN u.id, u.username, u.email, u.created
    `, map[string]interface{}{
        "id": id,
    })
    
    if err != nil {
        return User{}, fmt.Errorf("failed to find user: %w", err)
    }
    
    if result.Next(ctx) {
        record := result.Record()
        
        // Parse created time
        createdStr, _ := record.Get("u.created")
        created, _ := time.Parse(time.RFC3339, createdStr.(string))
        
        return User{
            ID:       record.Values[0].(string),
            Username: record.Values[1].(string),
            Email:    record.Values[2].(string),
            Created:  created,
        }, nil
    }
    
    return User{}, fmt.Errorf("user not found")
}

// Update modifies an existing user
func (r *Neo4jUserRepository) Update(ctx context.Context, user User) error {
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u:User {id: $id})
        SET u.username = $username, u.email = $email
        RETURN u
    `, map[string]interface{}{
        "id":       user.ID,
        "username": user.Username,
        "email":    user.Email,
    })
    
    if err != nil {
        return fmt.Errorf("failed to update user: %w", err)
    }
    
    // Check if user exists
    if !result.Next(ctx) {
        return fmt.Errorf("user not found")
    }
    
    return nil
}

// Delete removes a user by ID
func (r *Neo4jUserRepository) Delete(ctx context.Context, id string) error {
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u:User {id: $id})
        DETACH DELETE u
        RETURN count(u) as deleted
    `, map[string]interface{}{
        "id": id,
    })
    
    if err != nil {
        return fmt.Errorf("failed to delete user: %w", err)
    }
    
    if result.Next(ctx) {
        deleted, _ := result.Record().Get("deleted")
        if deleted.(int64) == 0 {
            return fmt.Errorf("user not found")
        }
    }
    
    return nil
}

// List retrieves users with pagination
func (r *Neo4jUserRepository) List(ctx context.Context, limit, offset int) ([]User, error) {
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u:User)
        RETURN u.id, u.username, u.email, u.created
        ORDER BY u.created DESC
        SKIP $skip
        LIMIT $limit
    `, map[string]interface{}{
        "skip":  offset,
        "limit": limit,
    })
    
    if err != nil {
        return nil, fmt.Errorf("failed to list users: %w", err)
    }
    
    var users []User
    for result.Next(ctx) {
        record := result.Record()
        
        // Parse created time
        createdStr, _ := record.Get("u.created")
        created, _ := time.Parse(time.RFC3339, createdStr.(string))
        
        users = append(users, User{
            ID:       record.Values[0].(string),
            Username: record.Values[1].(string),
            Email:    record.Values[2].(string),
            Created:  created,
        })
    }
    
    return users, nil
}

// FindByEmail retrieves a user by email
func (r *Neo4jUserRepository) FindByEmail(ctx context.Context, email string) (User, error) {
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u:User {email: $email})
        RETURN u.id, u.username, u.email, u.created
    `, map[string]interface{}{
        "email": email,
    })
    
    if err != nil {
        return User{}, fmt.Errorf("failed to find user by email: %w", err)
    }
    
    if result.Next(ctx) {
        record := result.Record()
        
        // Parse created time
        createdStr, _ := record.Get("u.created")
        created, _ := time.Parse(time.RFC3339, createdStr.(string))
        
        return User{
            ID:       record.Values[0].(string),
            Username: record.Values[1].(string),
            Email:    record.Values[2].(string),
            Created:  created,
        }, nil
    }
    
    return User{}, fmt.Errorf("user not found")
}
```

Now, let's implement the friendship repository:

```go
// Neo4jFriendshipRepository implements FriendshipRepository using Neo4j
type Neo4jFriendshipRepository struct {
    driver neo4j.Driver
}

// NewNeo4jFriendshipRepository creates a new Neo4jFriendshipRepository
func NewNeo4jFriendshipRepository(driver neo4j.Driver) *Neo4jFriendshipRepository {
    return &Neo4jFriendshipRepository{driver: driver}
}

// CreateFriendship establishes a friendship between two users
func (r *Neo4jFriendshipRepository) CreateFriendship(ctx context.Context, userID1, userID2 string) error {
    if userID1 == userID2 {
        return fmt.Errorf("users cannot be friends with themselves")
    }
    
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u1:User {id: $userID1})
        MATCH (u2:User {id: $userID2})
        WHERE u1 <> u2
        MERGE (u1)-[r:FRIEND]->(u2)
        RETURN count(r) as relationship_count
    `, map[string]interface{}{
        "userID1": userID1,
        "userID2": userID2,
    })
    
    if err != nil {
        return fmt.Errorf("failed to create friendship: %w", err)
    }
    
    if !result.Next(ctx) {
        return fmt.Errorf("failed to verify friendship creation")
    }
    
    return nil
}

// DeleteFriendship removes a friendship between two users
func (r *Neo4jFriendshipRepository) DeleteFriendship(ctx context.Context, userID1, userID2 string) error {
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u1:User {id: $userID1})-[r:FRIEND]-(u2:User {id: $userID2})
        DELETE r
        RETURN count(r) as deleted_count
    `, map[string]interface{}{
        "userID1": userID1,
        "userID2": userID2,
    })
    
    if err != nil {
        return fmt.Errorf("failed to delete friendship: %w", err)
    }
    
    if result.Next(ctx) {
        deletedCount, _ := result.Record().Get("deleted_count")
        if deletedCount.(int64) == 0 {
            return fmt.Errorf("friendship not found")
        }
    }
    
    return nil
}

// GetFriends retrieves friends of a user with pagination
func (r *Neo4jFriendshipRepository) GetFriends(ctx context.Context, userID string, limit, offset int) ([]User, error) {
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u:User {id: $userID})-[:FRIEND]-(friend:User)
        RETURN friend.id, friend.username, friend.email, friend.created
        ORDER BY friend.username
        SKIP $skip
        LIMIT $limit
    `, map[string]interface{}{
        "userID": userID,
        "skip":   offset,
        "limit":  limit,
    })
    
    if err != nil {
        return nil, fmt.Errorf("failed to get friends: %w", err)
    }
    
    var friends []User
    for result.Next(ctx) {
        record := result.Record()
        
        // Parse created time
        createdStr, _ := record.Get("friend.created")
        created, _ := time.Parse(time.RFC3339, createdStr.(string))
        
        friends = append(friends, User{
            ID:       record.Values[0].(string),
            Username: record.Values[1].(string),
            Email:    record.Values[2].(string),
            Created:  created,
        })
    }
    
    return friends, nil
}

// AreFriends checks if two users are friends
func (r *Neo4jFriendshipRepository) AreFriends(ctx context.Context, userID1, userID2 string) (bool, error) {
    session := r.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
    defer session.Close(ctx)
    
    result, err := session.Run(ctx, `
        MATCH (u1:User {id: $userID1})-[r:FRIEND]-(u2:User {id: $userID2})
        RETURN count(r) as relationship_count
    `, map[string]interface{}{
        "userID1": userID1,
        "userID2": userID2,
    })
    
    if err != nil {
        return false, fmt.Errorf("failed to check friendship: %w", err)
    }
    
    if result.Next(ctx) {
        count, _ := result.Record().Get("relationship_count")
        return count.(int64) > 0, nil
    }
    
    return false, nil
}
```

## Key-Value Stores with Go

Key-value stores like Redis excel at simple data storage with fast access times. Let's implement the repository pattern for Redis.

### Repository Implementation with Redis

Since Redis is primarily a key-value store, our repository will focus on efficient key design:

```go
// RedisUserRepository implements UserRepository using Redis
type RedisUserRepository struct {
    client *redis.Client
}

// NewRedisUserRepository creates a new RedisUserRepository
func NewRedisUserRepository(client *redis.Client) *RedisUserRepository {
    return &RedisUserRepository{client: client}
}

// userKey generates a Redis key for a user by ID
func userKey(id string) string {
    return fmt.Sprintf("user:%s", id)
}

// userEmailKey generates a Redis key for user email lookup
func userEmailKey(email string) string {
    return fmt.Sprintf("user:email:%s", email)
}

// usersKey returns the key for the sorted set of users
func usersKey() string {
    return "users"
}

// Create adds a new user to Redis
func (r *RedisUserRepository) Create(ctx context.Context, user User) (User, error) {
    if user.ID == "" {
        user.ID = uuid.New().String()
    }
    
    if user.Created.IsZero() {
        user.Created = time.Now()
    }
    
    // Serialize user to JSON
    userData, err := json.Marshal(user)
    if err != nil {
        return User{}, fmt.Errorf("failed to marshal user: %w", err)
    }
    
    // Use a pipeline for atomic operations
    pipe := r.client.Pipeline()
    
    // Store user data
    pipe.Set(ctx, userKey(user.ID), userData, 0)
    
    // Create an index by email
    pipe.Set(ctx, userEmailKey(user.Email), user.ID, 0)
    
    // Add to sorted set for pagination, sorted by creation time
    pipe.ZAdd(ctx, usersKey(), &redis.Z{
        Score:  float64(user.Created.Unix()),
        Member: user.ID,
    })
    
    // Execute pipeline
    _, err = pipe.Exec(ctx)
    if err != nil {
        return User{}, fmt.Errorf("failed to create user: %w", err)
    }
    
    return user, nil
}

// FindByID retrieves a user by ID
func (r *RedisUserRepository) FindByID(ctx context.Context, id string) (User, error) {
    userData, err := r.client.Get(ctx, userKey(id)).Result()
    if err != nil {
        if err == redis.Nil {
            return User{}, fmt.Errorf("user not found")
        }
        return User{}, fmt.Errorf("failed to find user: %w", err)
    }
    
    var user User
    if err := json.Unmarshal([]byte(userData), &user); err != nil {
        return User{}, fmt.Errorf("failed to unmarshal user: %w", err)
    }
    
    return user, nil
}

// Update modifies an existing user
func (r *RedisUserRepository) Update(ctx context.Context, user User) error {
    // Check if user exists
    exists, err := r.client.Exists(ctx, userKey(user.ID)).Result()
    if err != nil {
        return fmt.Errorf("failed to check if user exists: %w", err)
    }
    
    if exists == 0 {
        return fmt.Errorf("user not found")
    }
    
    // Get current user to check if email changed
    currentData, err := r.client.Get(ctx, userKey(user.ID)).Result()
    if err != nil {
        return fmt.Errorf("failed to get current user: %w", err)
    }
    
    var currentUser User
    if err := json.Unmarshal([]byte(currentData), &currentUser); err != nil {
        return fmt.Errorf("failed to unmarshal current user: %w", err)
    }
    
    // Serialize updated user
    userData, err := json.Marshal(user)
    if err != nil {
        return fmt.Errorf("failed to marshal user: %w", err)
    }
    
    // Use pipeline for atomic operations
    pipe := r.client.Pipeline()
    
    // Update user data
    pipe.Set(ctx, userKey(user.ID), userData, 0)
    
    // Update email index if email changed
    if currentUser.Email != user.Email {
        pipe.Del(ctx, userEmailKey(currentUser.Email))
        pipe.Set(ctx, userEmailKey(user.Email), user.ID, 0)
    }
    
    // Execute pipeline
    _, err = pipe.Exec(ctx)
    if err != nil {
        return fmt.Errorf("failed to update user: %w", err)
    }
    
    return nil
}

// Delete removes a user
func (r *RedisUserRepository) Delete(ctx context.Context, id string) error {
    // Get user first to find the email
    userData, err := r.client.Get(ctx, userKey(id)).Result()
    if err != nil {
        if err == redis.Nil {
            return fmt.Errorf("user not found")
        }
        return fmt.Errorf("failed to get user for deletion: %w", err)
    }
    
    var user User
    if err := json.Unmarshal([]byte(userData), &user); err != nil {
        return fmt.Errorf("failed to unmarshal user for deletion: %w", err)
    }
    
    // Use pipeline for atomic operations
    pipe := r.client.Pipeline()
    
    // Remove user data
    pipe.Del(ctx, userKey(id))
    
    // Remove email index
    pipe.Del(ctx, userEmailKey(user.Email))
    
    // Remove from sorted set
    pipe.ZRem(ctx, usersKey(), id)
    
    // Execute pipeline
    _, err = pipe.Exec(ctx)
    if err != nil {
        return fmt.Errorf("failed to delete user: %w", err)
    }
    
    return nil
}

// List retrieves users with pagination, sorted by creation time (newest first)
func (r *RedisUserRepository) List(ctx context.Context, limit, offset int) ([]User, error) {
    // Get user IDs from sorted set (reversed for newest first)
    ids, err := r.client.ZRevRange(ctx, usersKey(), int64(offset), int64(offset+limit-1)).Result()
    if err != nil {
        return nil, fmt.Errorf("failed to list user IDs: %w", err)
    }
    
    if len(ids) == 0 {
        return []User{}, nil
    }
    
    // Use pipeline to get all users in parallel
    pipe := r.client.Pipeline()
    cmds := make(map[string]*redis.StringCmd)
    
    for _, id := range ids {
        cmds[id] = pipe.Get(ctx, userKey(id))
    }
    
    _, err = pipe.Exec(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to get users in batch: %w", err)
    }
    
    // Process results
    users := make([]User, 0, len(ids))
    for _, id := range ids {
        userData, err := cmds[id].Result()
        if err != nil {
            // Skip users that might have been deleted
            if err == redis.Nil {
                continue
            }
            return nil, fmt.Errorf("failed to get user %s: %w", id, err)
        }
        
        var user User
        if err := json.Unmarshal([]byte(userData), &user); err != nil {
            return nil, fmt.Errorf("failed to unmarshal user %s: %w", id, err)
        }
        
        users = append(users, user)
    }
    
    return users, nil
}

// FindByEmail retrieves a user by email
func (r *RedisUserRepository) FindByEmail(ctx context.Context, email string) (User, error) {
    // Get user ID from email index
    id, err := r.client.Get(ctx, userEmailKey(email)).Result()
    if err != nil {
        if err == redis.Nil {
            return User{}, fmt.Errorf("user not found")
        }
        return User{}, fmt.Errorf("failed to find user by email: %w", err)
    }
    
    // Get user data
    return r.FindByID(ctx, id)
}
```

## Repository Composition and Inheritance

To reduce code duplication, we can use composition and inheritance patterns:

### Base Repository Implementation

```go
// BaseRepository provides common functionality for repositories
type BaseRepository[T any, ID comparable] struct {
    entityName string
}

// NewBaseRepository creates a new BaseRepository
func NewBaseRepository[T any, ID comparable](entityName string) *BaseRepository[T, ID] {
    return &BaseRepository[T, ID]{
        entityName: entityName,
    }
}

// NotFoundError returns a standardized not found error
func (r *BaseRepository[T, ID]) NotFoundError(id ID) error {
    return fmt.Errorf("%s with ID %v not found", r.entityName, id)
}

// ValidationError returns a standardized validation error
func (r *BaseRepository[T, ID]) ValidationError(msg string) error {
    return fmt.Errorf("validation error: %s", msg)
}

// DatabaseError standardizes database errors
func (r *BaseRepository[T, ID]) DatabaseError(operation string, err error) error {
    return fmt.Errorf("database error during %s operation: %w", operation, err)
}
```

### Using the Base Repository

```go
// SQLUserRepositoryV2 uses composition with BaseRepository
type SQLUserRepositoryV2 struct {
    *BaseRepository[User, string]
    db *sql.DB
}

// NewSQLUserRepositoryV2 creates a new SQLUserRepositoryV2
func NewSQLUserRepositoryV2(db *sql.DB) *SQLUserRepositoryV2 {
    return &SQLUserRepositoryV2{
        BaseRepository: NewBaseRepository[User, string]("User"),
        db:             db,
    }
}

// FindByID retrieves a user by ID
func (r *SQLUserRepositoryV2) FindByID(ctx context.Context, id string) (User, error) {
    var user User
    err := r.db.QueryRowContext(ctx, `
        SELECT id, username, email, created
        FROM users
        WHERE id = $1
    `, id).Scan(&user.ID, &user.Username, &user.Email, &user.Created)
    
    if err != nil {
        if err == sql.ErrNoRows {
            return User{}, r.NotFoundError(id)
        }
        return User{}, r.DatabaseError("FindByID", err)
    }
    
    return user, nil
}

// Other methods would follow a similar pattern, leveraging the BaseRepository
```

## Testing Repository Implementations

Testing repositories is crucial for ensuring data access reliability. Let's explore strategies for testing our repositories:

### Using Interfaces for Mocking

```go
// UserRepositoryMock is a mock implementation of UserRepository
type UserRepositoryMock struct {
    users       map[string]User
    emailToID   map[string]string
    createFunc  func(ctx context.Context, user User) (User, error)
    findByIDFunc func(ctx context.Context, id string) (User, error)
    // Other mock functions...
}

// NewUserRepositoryMock creates a new UserRepositoryMock
func NewUserRepositoryMock() *UserRepositoryMock {
    return &UserRepositoryMock{
        users:     make(map[string]User),
        emailToID: make(map[string]string),
    }
}

// Create implements UserRepository.Create
func (m *UserRepositoryMock) Create(ctx context.Context, user User) (User, error) {
    if m.createFunc != nil {
        return m.createFunc(ctx, user)
    }
    
    if user.ID == "" {
        user.ID = uuid.New().String()
    }
    
    if user.Created.IsZero() {
        user.Created = time.Now()
    }
    
    if _, exists := m.emailToID[user.Email]; exists {
        return User{}, fmt.Errorf("user with email %s already exists", user.Email)
    }
    
    m.users[user.ID] = user
    m.emailToID[user.Email] = user.ID
    
    return user, nil
}

// FindByID implements UserRepository.FindByID
func (m *UserRepositoryMock) FindByID(ctx context.Context, id string) (User, error) {
    if m.findByIDFunc != nil {
        return m.findByIDFunc(ctx, id)
    }
    
    user, exists := m.users[id]
    if !exists {
        return User{}, fmt.Errorf("user not found")
    }
    
    return user, nil
}

// Implement other repository methods similarly
```

### Integration Tests with Real Databases

```go
func TestSQLUserRepository_Integration(t *testing.T) {
    // Skip if not running integration tests
    if testing.Short() {
        t.Skip("Skipping integration test")
    }
    
    // Connect to test database
    db, err := sql.Open("postgres", "postgres://postgres:postgres@localhost:5432/testdb?sslmode=disable")
    if err != nil {
        t.Fatalf("Failed to connect to test database: %v", err)
    }
    defer db.Close()
    
    // Setup test table
    _, err = db.Exec(`
        DROP TABLE IF EXISTS users;
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            created TIMESTAMP NOT NULL
        )
    `)
    if err != nil {
        t.Fatalf("Failed to create test table: %v", err)
    }
    
    // Create repository
    repo := NewSQLUserRepository(db)
    
    // Run tests
    t.Run("Create", func(t *testing.T) {
        user := User{
            Username: "testuser",
            Email:    "test@example.com",
        }
        
        created, err := repo.Create(context.Background(), user)
        require.NoError(t, err)
        require.NotEmpty(t, created.ID)
        require.Equal(t, user.Username, created.Username)
        require.Equal(t, user.Email, created.Email)
        require.False(t, created.Created.IsZero())
    })
    
    // Add more test cases for other repository methods
}
```

### Using Testcontainers for Database Tests

The [testcontainers-go](https://github.com/testcontainers/testcontainers-go) library provides ephemeral database containers for tests:

```go
func TestPostgresUserRepository(t *testing.T) {
    // Skip if not running integration tests
    if testing.Short() {
        t.Skip("Skipping integration test")
    }
    
    ctx := context.Background()
    
    // Start PostgreSQL container
    postgres, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image:        "postgres:14",
            ExposedPorts: []string{"5432/tcp"},
            Env: map[string]string{
                "POSTGRES_PASSWORD": "postgres",
                "POSTGRES_USER":     "postgres",
                "POSTGRES_DB":       "testdb",
            },
            WaitingFor: wait.ForLog("database system is ready to accept connections"),
        },
        Started: true,
    })
    if err != nil {
        t.Fatalf("Failed to start container: %v", err)
    }
    defer postgres.Terminate(ctx)
    
    // Get connection details
    host, err := postgres.Host(ctx)
    if err != nil {
        t.Fatalf("Failed to get container host: %v", err)
    }
    
    port, err := postgres.MappedPort(ctx, "5432")
    if err != nil {
        t.Fatalf("Failed to get container port: %v", err)
    }
    
    // Connect to database
    dsn := fmt.Sprintf("postgres://postgres:postgres@%s:%s/testdb?sslmode=disable", host, port.Port())
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        t.Fatalf("Failed to connect to database: %v", err)
    }
    defer db.Close()
    
    // Setup test table
    _, err = db.Exec(`
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            created TIMESTAMP NOT NULL
        )
    `)
    if err != nil {
        t.Fatalf("Failed to create test table: %v", err)
    }
    
    // Create repository and run tests
    repo := NewSQLUserRepository(db)
    
    // Run test cases similar to the previous example
}
```

## Advanced Repository Techniques

Let's explore some advanced techniques for repository implementation:

### Caching Layer

Adding a caching layer can significantly improve performance:

```go
// CachedUserRepository adds caching to any UserRepository implementation
type CachedUserRepository struct {
    repo  UserRepository
    cache *cache.Cache // github.com/patrickmn/go-cache
}

// NewCachedUserRepository creates a new CachedUserRepository
func NewCachedUserRepository(repo UserRepository) *CachedUserRepository {
    return &CachedUserRepository{
        repo:  repo,
        cache: cache.New(5*time.Minute, 10*time.Minute),
    }
}

// userCacheKey generates a cache key for a user
func userCacheKey(id string) string {
    return fmt.Sprintf("user:%s", id)
}

// emailCacheKey generates a cache key for user lookup by email
func emailCacheKey(email string) string {
    return fmt.Sprintf("user:email:%s", email)
}

// Create adds a new user and updates the cache
func (r *CachedUserRepository) Create(ctx context.Context, user User) (User, error) {
    created, err := r.repo.Create(ctx, user)
    if err != nil {
        return User{}, err
    }
    
    r.cache.Set(userCacheKey(created.ID), created, cache.DefaultExpiration)
    r.cache.Set(emailCacheKey(created.Email), created, cache.DefaultExpiration)
    
    return created, nil
}

// FindByID retrieves a user by ID, using cache if available
func (r *CachedUserRepository) FindByID(ctx context.Context, id string) (User, error) {
    // Check cache first
    if cached, found := r.cache.Get(userCacheKey(id)); found {
        return cached.(User), nil
    }
    
    // Cache miss, get from repository
    user, err := r.repo.FindByID(ctx, id)
    if err != nil {
        return User{}, err
    }
    
    // Update cache
    r.cache.Set(userCacheKey(id), user, cache.DefaultExpiration)
    
    return user, nil
}

// Update modifies a user and updates the cache
func (r *CachedUserRepository) Update(ctx context.Context, user User) error {
    // Get existing user for email change detection
    existing, err := r.repo.FindByID(ctx, user.ID)
    if err != nil {
        return err
    }
    
    // Update in repository
    if err := r.repo.Update(ctx, user); err != nil {
        return err
    }
    
    // Update cache
    r.cache.Set(userCacheKey(user.ID), user, cache.DefaultExpiration)
    
    // If email changed, update email cache key
    if existing.Email != user.Email {
        r.cache.Delete(emailCacheKey(existing.Email))
        r.cache.Set(emailCacheKey(user.Email), user, cache.DefaultExpiration)
    }
    
    return nil
}

// Delete removes a user and clears the cache
func (r *CachedUserRepository) Delete(ctx context.Context, id string) error {
    // Get user for email cache key
    user, err := r.repo.FindByID(ctx, id)
    if err != nil {
        return err
    }
    
    // Delete from repository
    if err := r.repo.Delete(ctx, id); err != nil {
        return err
    }
    
    // Clear cache
    r.cache.Delete(userCacheKey(id))
    r.cache.Delete(emailCacheKey(user.Email))
    
    return nil
}

// Implement other methods similarly...
```

### Query Builder Pattern

For complex query construction, a query builder can help:

```go
// UserQuery represents a query for users
type UserQuery struct {
    UserID    *string
    Email     *string
    Username  *string
    CreatedAfter *time.Time
    CreatedBefore *time.Time
    OrderBy   string
    Order     string
    Limit     int
    Offset    int
}

// SQLUserQueryBuilder implements a query builder for users
type SQLUserQueryBuilder struct {
    db *sql.DB
}

// NewSQLUserQueryBuilder creates a new SQLUserQueryBuilder
func NewSQLUserQueryBuilder(db *sql.DB) *SQLUserQueryBuilder {
    return &SQLUserQueryBuilder{db: db}
}

// BuildQuery constructs an SQL query from UserQuery
func (b *SQLUserQueryBuilder) BuildQuery(query UserQuery) (string, []interface{}, error) {
    var conditions []string
    var args []interface{}
    var argIndex int = 1
    
    sqlQuery := "SELECT id, username, email, created FROM users"
    
    // Add WHERE conditions
    if query.UserID != nil {
        conditions = append(conditions, fmt.Sprintf("id = $%d", argIndex))
        args = append(args, *query.UserID)
        argIndex++
    }
    
    if query.Email != nil {
        conditions = append(conditions, fmt.Sprintf("email = $%d", argIndex))
        args = append(args, *query.Email)
        argIndex++
    }
    
    if query.Username != nil {
        conditions = append(conditions, fmt.Sprintf("username = $%d", argIndex))
        args = append(args, *query.Username)
        argIndex++
    }
    
    if query.CreatedAfter != nil {
        conditions = append(conditions, fmt.Sprintf("created >= $%d", argIndex))
        args = append(args, *query.CreatedAfter)
        argIndex++
    }
    
    if query.CreatedBefore != nil {
        conditions = append(conditions, fmt.Sprintf("created <= $%d", argIndex))
        args = append(args, *query.CreatedBefore)
        argIndex++
    }
    
    if len(conditions) > 0 {
        sqlQuery += " WHERE " + strings.Join(conditions, " AND ")
    }
    
    // Add ORDER BY
    if query.OrderBy != "" {
        // Validate order by column to prevent SQL injection
        validColumns := map[string]bool{
            "id":       true,
            "username": true,
            "email":    true,
            "created":  true,
        }
        
        if !validColumns[query.OrderBy] {
            return "", nil, fmt.Errorf("invalid order by column: %s", query.OrderBy)
        }
        
        sqlQuery += " ORDER BY " + query.OrderBy
        
        if query.Order != "" {
            if query.Order != "ASC" && query.Order != "DESC" {
                return "", nil, fmt.Errorf("invalid order direction: %s", query.Order)
            }
            sqlQuery += " " + query.Order
        }
    } else {
        // Default ordering
        sqlQuery += " ORDER BY created DESC"
    }
    
    // Add pagination
    if query.Limit > 0 {
        sqlQuery += fmt.Sprintf(" LIMIT $%d", argIndex)
        args = append(args, query.Limit)
        argIndex++
    }
    
    if query.Offset > 0 {
        sqlQuery += fmt.Sprintf(" OFFSET $%d", argIndex)
        args = append(args, query.Offset)
    }
    
    return sqlQuery, args, nil
}

// FindUsers executes a query and returns matching users
func (b *SQLUserQueryBuilder) FindUsers(ctx context.Context, query UserQuery) ([]User, error) {
    sqlQuery, args, err := b.BuildQuery(query)
    if err != nil {
        return nil, err
    }
    
    rows, err := b.db.QueryContext(ctx, sqlQuery, args...)
    if err != nil {
        return nil, fmt.Errorf("failed to execute query: %w", err)
    }
    defer rows.Close()
    
    var users []User
    for rows.Next() {
        var user User
        if err := rows.Scan(&user.ID, &user.Username, &user.Email, &user.Created); err != nil {
            return nil, fmt.Errorf("failed to scan user: %w", err)
        }
        users = append(users, user)
    }
    
    if err := rows.Err(); err != nil {
        return nil, fmt.Errorf("error iterating users: %w", err)
    }
    
    return users, nil
}

// Usage example
func findRecentUsers(ctx context.Context, queryBuilder *SQLUserQueryBuilder) ([]User, error) {
    threeDaysAgo := time.Now().AddDate(0, 0, -3)
    
    query := UserQuery{
        CreatedAfter: &threeDaysAgo,
        OrderBy:      "created",
        Order:        "DESC",
        Limit:        10,
    }
    
    return queryBuilder.FindUsers(ctx, query)
}
```

## Multi-Database Repositories

Sometimes, you might need to store data across multiple databases. Let's implement a repository that spans different database types:

```go
// MultiUserRepository distributes user operations across multiple databases
type MultiUserRepository struct {
    primaryRepo UserRepository // Primary data source
    cacheRepo   UserRepository // Fast cache store (e.g., Redis)
    searchRepo  UserRepository // Search-optimized store (e.g., Elasticsearch)
}

// NewMultiUserRepository creates a new MultiUserRepository
func NewMultiUserRepository(
    primaryRepo, cacheRepo, searchRepo UserRepository,
) *MultiUserRepository {
    return &MultiUserRepository{
        primaryRepo: primaryRepo,
        cacheRepo:   cacheRepo,
        searchRepo:  searchRepo,
    }
}

// Create adds a user to all repositories
func (r *MultiUserRepository) Create(ctx context.Context, user User) (User, error) {
    // Create in primary repository first
    created, err := r.primaryRepo.Create(ctx, user)
    if err != nil {
        return User{}, fmt.Errorf("failed to create user in primary repository: %w", err)
    }
    
    // Fan out to other repositories
    var wg sync.WaitGroup
    errCh := make(chan error, 2)
    
    // Add to cache repository
    wg.Add(1)
    go func() {
        defer wg.Done()
        if _, err := r.cacheRepo.Create(ctx, created); err != nil {
            errCh <- fmt.Errorf("failed to create user in cache repository: %w", err)
        }
    }()
    
    // Add to search repository
    wg.Add(1)
    go func() {
        defer wg.Done()
        if _, err := r.searchRepo.Create(ctx, created); err != nil {
            errCh <- fmt.Errorf("failed to create user in search repository: %w", err)
        }
    }()
    
    // Wait for all operations to complete
    wg.Wait()
    close(errCh)
    
    // Log any errors from secondary repositories
    for err := range errCh {
        log.Printf("Warning: %v", err)
    }
    
    return created, nil
}

// FindByID tries to find a user in cache first, then primary
func (r *MultiUserRepository) FindByID(ctx context.Context, id string) (User, error) {
    // Try cache first
    user, err := r.cacheRepo.FindByID(ctx, id)
    if err == nil {
        return user, nil
    }
    
    // Fall back to primary repository
    user, err = r.primaryRepo.FindByID(ctx, id)
    if err != nil {
        return User{}, err
    }
    
    // Update cache in background
    go func() {
        // Use a new context for background operation
        bgCtx := context.Background()
        if _, err := r.cacheRepo.Create(bgCtx, user); err != nil {
            log.Printf("Warning: failed to update user in cache: %v", err)
        }
    }()
    
    return user, nil
}

// All other methods would follow similar patterns of primary operation
// with asynchronous updates to secondary repositories
```

## Performance Considerations

When implementing the repository pattern, consider these performance tips:

### Connection Pooling

```go
func setupPostgresPool() (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig("postgres://postgres:postgres@localhost:5432/myapp")
    if err != nil {
        return nil, err
    }
    
    // Configure connection pool
    config.MaxConns = 10
    config.MinConns = 2
    config.MaxConnLifetime = 15 * time.Minute
    config.MaxConnIdleTime = 5 * time.Minute
    
    // Health check
    config.HealthCheckPeriod = 1 * time.Minute
    
    pool, err := pgxpool.ConnectConfig(context.Background(), config)
    if err != nil {
        return nil, err
    }
    
    return pool, nil
}
```

### Batching Operations

For bulk operations, use batching techniques:

```go
// BulkCreateUsers adds multiple users efficiently
func (r *SQLUserRepository) BulkCreateUsers(ctx context.Context, users []User) error {
    if len(users) == 0 {
        return nil
    }
    
    // Build a multi-value INSERT statement
    var placeholders []string
    var args []interface{}
    argIndex := 1
    
    for _, user := range users {
        if user.ID == "" {
            user.ID = uuid.New().String()
        }
        if user.Created.IsZero() {
            user.Created = time.Now()
        }
        
        placeholder := fmt.Sprintf("($%d, $%d, $%d, $%d)",
            argIndex, argIndex+1, argIndex+2, argIndex+3)
        placeholders = append(placeholders, placeholder)
        
        args = append(args, user.ID, user.Username, user.Email, user.Created)
        argIndex += 4
    }
    
    query := fmt.Sprintf(`
        INSERT INTO users (id, username, email, created)
        VALUES %s
    `, strings.Join(placeholders, ", "))
    
    _, err := r.db.ExecContext(ctx, query, args...)
    if err != nil {
        return fmt.Errorf("failed to bulk create users: %w", err)
    }
    
    return nil
}
```

### Asynchronous Operations

Use background jobs for non-critical operations:

```go
// AsyncUserRepository adds async capabilities to any UserRepository
type AsyncUserRepository struct {
    repo UserRepository
    jobs chan asyncJob
}

type asyncJob struct {
    operation func() error
}

// NewAsyncUserRepository creates a new AsyncUserRepository
func NewAsyncUserRepository(repo UserRepository, workers int) *AsyncUserRepository {
    async := &AsyncUserRepository{
        repo: repo,
        jobs: make(chan asyncJob, 1000), // Buffer up to 1000 jobs
    }
    
    // Start worker goroutines
    for i := 0; i < workers; i++ {
        go async.worker()
    }
    
    return async
}

// worker processes async jobs
func (r *AsyncUserRepository) worker() {
    for job := range r.jobs {
        if err := job.operation(); err != nil {
            log.Printf("Async job error: %v", err)
        }
    }
}

// Delete removes a user synchronously but handles secondary operations async
func (r *AsyncUserRepository) Delete(ctx context.Context, id string) error {
    // Get user for related data
    user, err := r.repo.FindByID(ctx, id)
    if err != nil {
        return err
    }
    
    // Perform the main deletion
    if err := r.repo.Delete(ctx, id); err != nil {
        return err
    }
    
    // Queue async cleanup jobs
    r.jobs <- asyncJob{
        operation: func() error {
            // Delete related data, send notifications, etc.
            return nil
        },
    }
    
    return nil
}
```

## Conclusion

The repository pattern provides a clean, maintainable way to abstract database operations in Go applications. By implementing this pattern across different database types—relational, document, graph, and key-value stores—we can achieve consistent data access while leveraging each database's unique strengths.

Throughout this guide, we've explored:

1. The core principles of the repository pattern and how it fits into clean architecture
2. Concrete implementations for PostgreSQL, MongoDB, Neo4j, and Redis
3. Advanced techniques like caching, query building, and multi-database repositories
4. Testing strategies to ensure repository reliability
5. Performance optimizations for real-world applications

When designing your own repositories, remember these key takeaways:

- **Follow interface-based design**: Define clear interfaces that represent domain operations, not database operations
- **Keep domain logic separate**: Repositories should focus on data access, not business rules
- **Consider performance early**: Connection pooling, batching, and appropriate caching can prevent future bottlenecks
- **Test thoroughly**: Use both unit tests with mocks and integration tests with real or containerized databases
- **Choose the right database**: Select database types based on your data access patterns, not just familiarity

By applying these principles and techniques, you can build robust, flexible data access layers that evolve with your application's needs.

---

*How have you implemented the repository pattern in your Go applications? Share your experiences and challenges in the comments!*