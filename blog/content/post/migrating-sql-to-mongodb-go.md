---
title: "Migrating from SQL to MongoDB in Go: A Comprehensive Guide"
date: 2027-02-23T09:00:00-05:00
draft: false
tags: ["Go", "MongoDB", "SQL", "Database", "Migration", "NoSQL"]
categories: ["Database Migration", "Go Programming"]
---

Database migration is one of the most challenging technical transitions a growing application can face. When your Go application outgrows its relational database structure, MongoDB offers a scalable, flexible alternative that can better accommodate evolving data requirements. This comprehensive guide explores the entire migration process from SQL to MongoDB in Go applications, including data modeling strategies, code refactoring techniques, performance optimization approaches, and real-world migration patterns.

## Table of Contents

1. [Why Migrate from SQL to MongoDB?](#why-migrate-from-sql-to-mongodb)
2. [Rethinking Your Data Model](#rethinking-your-data-model)
3. [Refactoring Your Go Code](#refactoring-your-go-code)
4. [Managing Database Connections](#managing-database-connections)
5. [Migrating Existing Data](#migrating-existing-data)
6. [Query and Index Migration](#query-and-index-migration)
7. [Handling Transactions](#handling-transactions)
8. [Migration Testing Strategies](#migration-testing-strategies)
9. [Performance Considerations](#performance-considerations)
10. [MongoDB Best Practices in Go](#mongodb-best-practices-in-go)
11. [Common Pitfalls and Solutions](#common-pitfalls-and-solutions)
12. [Case Study: E-commerce Platform Migration](#case-study-e-commerce-platform-migration)
13. [Conclusion](#conclusion)

## Why Migrate from SQL to MongoDB?

Before diving into the technical aspects, it's important to understand when migrating to MongoDB makes sense for your Go application:

### Scalability Advantages

MongoDB's horizontal scaling capabilities enable your application to grow beyond the limits of a single server:

- **Sharding**: MongoDB can automatically distribute data across multiple machines
- **Replica Sets**: Built-in replication for high availability
- **Zone Sharding**: Geographically distribute data for global applications

### Schema Flexibility

Unlike SQL's rigid tables, MongoDB's document model allows:

- **Schema Evolution**: Add or remove fields without downtime or migrations
- **Heterogeneous Data**: Store varying document structures in the same collection
- **Embedded Documents**: Represent complex hierarchical relationships naturally

### Performance Benefits

For certain workloads, MongoDB can significantly outperform SQL databases:

- **Document-Oriented Storage**: Data that's accessed together stays together
- **Memory-Mapped Files**: Efficient caching of frequently accessed data
- **Indexing**: Support for various index types including compound, geospatial, and text

### Business Considerations

Beyond technical factors, consider:

- **Development Speed**: Faster iterations when requirements change frequently
- **Operational Costs**: Potential reductions in database administration overhead
- **Ecosystem Integration**: Better fit for microservices and modern architectural patterns

## Rethinking Your Data Model

The most fundamental change when migrating from SQL to MongoDB is shifting your data modeling approach:

### From Normalization to Embedding

SQL databases emphasize normalization to reduce redundancy:

```sql
CREATE TABLE users (
    id INT PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(100) UNIQUE
);

CREATE TABLE orders (
    id INT PRIMARY KEY,
    user_id INT,
    amount DECIMAL(10, 2),
    created_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE order_items (
    id INT PRIMARY KEY,
    order_id INT,
    product_id INT,
    quantity INT,
    price DECIMAL(10, 2),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);
```

MongoDB encourages embedding related data in a single document when it makes sense:

```go
type User struct {
    ID       primitive.ObjectID `bson:"_id"`
    Name     string             `bson:"name"`
    Email    string             `bson:"email"`
    // Orders could be embedded or referenced based on access patterns
}

type Order struct {
    ID        primitive.ObjectID `bson:"_id"`
    UserID    primitive.ObjectID `bson:"user_id"`
    Amount    float64            `bson:"amount"`
    CreatedAt time.Time          `bson:"created_at"`
    Items     []OrderItem        `bson:"items"` // Embedded items
}

type OrderItem struct {
    ProductID primitive.ObjectID `bson:"product_id"`
    Name      string             `bson:"name"`
    Quantity  int                `bson:"quantity"`
    Price     float64            `bson:"price"`
}
```

### Embedding vs. Referencing

The decision to embed documents or use references depends on several factors:

1. **Data Size**: If embedded data could grow very large, use references
2. **Access Patterns**: Embed data that's frequently accessed together
3. **Update Frequency**: Reference data that changes independently
4. **Relationship Cardinality**: One-to-many relationships can be embedded; many-to-many typically use references

### Sample Decision Matrix

| Relationship Type | Access Pattern | Size | Recommendation |
|-------------------|----------------|------|----------------|
| User → Profile | Always together | Small | Embed |
| Order → Items | Usually together | Medium | Embed |
| Product → Reviews | Sometimes separate | Large/Growing | Reference |
| User → Orders | Often separate | Large/Growing | Reference |
| Blog Post → Tags | Mixed | Small | Embed |

### Example: Converting a Blog Schema

SQL Schema:

```sql
CREATE TABLE posts (
    id INT PRIMARY KEY,
    title VARCHAR(200),
    content TEXT,
    author_id INT,
    published_at TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE comments (
    id INT PRIMARY KEY,
    post_id INT,
    user_id INT,
    content TEXT,
    created_at TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE tags (
    id INT PRIMARY KEY,
    name VARCHAR(50)
);

CREATE TABLE post_tags (
    post_id INT,
    tag_id INT,
    PRIMARY KEY (post_id, tag_id),
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (tag_id) REFERENCES tags(id)
);
```

MongoDB Schema:

```go
type Post struct {
    ID          primitive.ObjectID `bson:"_id"`
    Title       string             `bson:"title"`
    Content     string             `bson:"content"`
    AuthorID    primitive.ObjectID `bson:"author_id"`
    PublishedAt time.Time          `bson:"published_at"`
    Comments    []Comment          `bson:"comments"` // Embedded comments
    Tags        []string           `bson:"tags"`     // Embedded tags
}

type Comment struct {
    ID        primitive.ObjectID `bson:"_id"`
    UserID    primitive.ObjectID `bson:"user_id"`
    UserName  string             `bson:"user_name"` // Denormalized for display
    Content   string             `bson:"content"`
    CreatedAt time.Time          `bson:"created_at"`
}
```

In this example:
- Comments are embedded since they're always viewed with posts
- Tags are embedded as strings since they're lightweight
- Author information is referenced since users exist independently
- User names are denormalized into comments for display efficiency

## Refactoring Your Go Code

Converting your Go codebase to work with MongoDB requires changes at various layers:

### Repository Layer Refactoring

Assuming you have a repository pattern, here's how it might change:

SQL Repository:

```go
type PostRepository struct {
    db *sql.DB
}

func (r *PostRepository) GetByID(id int) (*Post, error) {
    var post Post
    err := r.db.QueryRow("SELECT id, title, content, author_id, published_at FROM posts WHERE id = ?", id).
        Scan(&post.ID, &post.Title, &post.Content, &post.AuthorID, &post.PublishedAt)
    if err != nil {
        return nil, err
    }
    
    // Fetch comments in a separate query
    rows, err := r.db.Query("SELECT id, user_id, content, created_at FROM comments WHERE post_id = ?", id)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    
    for rows.Next() {
        var comment Comment
        if err := rows.Scan(&comment.ID, &comment.UserID, &comment.Content, &comment.CreatedAt); err != nil {
            return nil, err
        }
        post.Comments = append(post.Comments, comment)
    }
    
    // Fetch tags in another query
    rows, err = r.db.Query(`
        SELECT t.id, t.name FROM tags t
        JOIN post_tags pt ON t.id = pt.tag_id
        WHERE pt.post_id = ?
    `, id)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    
    for rows.Next() {
        var tag Tag
        if err := rows.Scan(&tag.ID, &tag.Name); err != nil {
            return nil, err
        }
        post.Tags = append(post.Tags, tag)
    }
    
    return &post, nil
}
```

MongoDB Repository:

```go
type PostRepository struct {
    collection *mongo.Collection
}

func (r *PostRepository) GetByID(id primitive.ObjectID) (*Post, error) {
    ctx := context.Background()
    var post Post
    
    err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&post)
    if err != nil {
        if err == mongo.ErrNoDocuments {
            return nil, fmt.Errorf("post not found")
        }
        return nil, err
    }
    
    return &post, nil
}
```

Notice how the MongoDB version is significantly simpler because:
1. Related data is embedded in a single document
2. No need for multiple queries and joins
3. MongoDB's Decode method handles mapping to struct fields

### CRUD Operations Comparison

| Operation | SQL | MongoDB |
|-----------|-----|---------|
| Create | INSERT INTO posts VALUES (...) | collection.InsertOne(ctx, post) |
| Read | SELECT * FROM posts WHERE id = ? | collection.FindOne(ctx, bson.M{"_id": id}) |
| Update | UPDATE posts SET title = ? WHERE id = ? | collection.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": bson.M{"title": title}}) |
| Delete | DELETE FROM posts WHERE id = ? | collection.DeleteOne(ctx, bson.M{"_id": id}) |

### Controller Adaptations

Your API controllers likely won't need major changes, but you'll need to update ID handling:

```go
// SQL controller example
func (c *Controller) GetPost(w http.ResponseWriter, r *http.Request) {
    idStr := chi.URLParam(r, "id")
    id, err := strconv.Atoi(idStr)
    if err != nil {
        http.Error(w, "Invalid ID", http.StatusBadRequest)
        return
    }
    
    post, err := c.postRepo.GetByID(id)
    // ...
}

// MongoDB controller example
func (c *Controller) GetPost(w http.ResponseWriter, r *http.Request) {
    idStr := chi.URLParam(r, "id")
    id, err := primitive.ObjectIDFromHex(idStr)
    if err != nil {
        http.Error(w, "Invalid ID", http.StatusBadRequest)
        return
    }
    
    post, err := c.postRepo.GetByID(id)
    // ...
}
```

## Managing Database Connections

MongoDB connections in Go work differently than SQL connections:

### SQL Connection Pool

```go
func setupSQLDB() (*sql.DB, error) {
    db, err := sql.Open("mysql", "user:password@tcp(localhost:3306)/database")
    if err != nil {
        return nil, err
    }
    
    // Configure connection pool
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(25)
    db.SetConnMaxLifetime(5 * time.Minute)
    
    // Check connection
    if err := db.Ping(); err != nil {
        return nil, err
    }
    
    return db, nil
}
```

### MongoDB Connection Pool

```go
func setupMongoDB() (*mongo.Client, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    
    // Connection options
    clientOptions := options.Client().
        ApplyURI("mongodb://localhost:27017").
        SetMaxPoolSize(100).
        SetMinPoolSize(10).
        SetMaxConnIdleTime(5 * time.Minute)
    
    // Connect to MongoDB
    client, err := mongo.Connect(ctx, clientOptions)
    if err != nil {
        return nil, err
    }
    
    // Check connection
    if err := client.Ping(ctx, nil); err != nil {
        return nil, err
    }
    
    return client, nil
}
```

### Context Management

MongoDB operations require context for timeout management and cancellation:

```go
func (r *PostRepository) FindWithTimeout(query bson.M) ([]Post, error) {
    // Create context with timeout
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    
    // Execute query with context
    cursor, err := r.collection.Find(ctx, query)
    if err != nil {
        return nil, err
    }
    defer cursor.Close(ctx)
    
    // Process results
    var posts []Post
    if err := cursor.All(ctx, &posts); err != nil {
        return nil, err
    }
    
    return posts, nil
}
```

## Migrating Existing Data

Moving data from SQL to MongoDB requires careful planning and execution:

### General Migration Steps

1. **Extract**: Pull data from SQL database
2. **Transform**: Convert relational data to document format
3. **Load**: Insert transformed data into MongoDB
4. **Verify**: Validate data integrity
5. **Sync**: Keep databases in sync during transition

### Simple Migration Tool Example

```go
func migrateUsers(sqlDB *sql.DB, mongoDB *mongo.Database) error {
    // Step 1: Extract users from SQL
    rows, err := sqlDB.Query("SELECT id, name, email, created_at FROM users")
    if err != nil {
        return err
    }
    defer rows.Close()
    
    // Step 2: Transform and load in batches
    var users []interface{}
    batchSize := 1000
    
    for rows.Next() {
        var user struct {
            ID        int
            Name      string
            Email     string
            CreatedAt time.Time
        }
        
        if err := rows.Scan(&user.ID, &user.Name, &user.Email, &user.CreatedAt); err != nil {
            return err
        }
        
        // Transform to MongoDB document
        mongoUser := bson.M{
            "_id":        primitive.NewObjectID(),
            "legacy_id":  user.ID,           // Keep original ID for reference
            "name":       user.Name,
            "email":      user.Email,
            "created_at": user.CreatedAt,
        }
        
        users = append(users, mongoUser)
        
        // Insert in batches
        if len(users) >= batchSize {
            if err := insertBatch(mongoDB.Collection("users"), users); err != nil {
                return err
            }
            users = users[:0] // Reset slice
        }
    }
    
    // Insert any remaining users
    if len(users) > 0 {
        if err := insertBatch(mongoDB.Collection("users"), users); err != nil {
            return err
        }
    }
    
    return nil
}

func insertBatch(collection *mongo.Collection, docs []interface{}) error {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    
    _, err := collection.InsertMany(ctx, docs)
    return err
}
```

### Handling Relationships

For more complex migrations involving relationships, you'll need to implement a strategy:

```go
func migratePostsWithComments(sqlDB *sql.DB, mongoDB *mongo.Database) error {
    // Create ID mapping - critical for maintaining relationships
    userIDMap := make(map[int]primitive.ObjectID)
    
    // Step 1: Query posts with comments in a single join
    rows, err := sqlDB.Query(`
        SELECT p.id, p.title, p.content, p.author_id, p.published_at,
               c.id, c.user_id, c.content, c.created_at
        FROM posts p
        LEFT JOIN comments c ON p.id = c.post_id
        ORDER BY p.id, c.created_at
    `)
    if err != nil {
        return err
    }
    defer rows.Close()
    
    // Step 2: Process and group by post
    postMap := make(map[int]*bson.M)
    commentMap := make(map[int][]bson.M)
    
    for rows.Next() {
        var (
            postID, authorID, commentID, commentUserID int
            postTitle, postContent, commentContent     string
            postPublishedAt, commentCreatedAt          time.Time
        )
        
        // Handle nullable comment fields
        var nullableCommentID, nullableUserID sql.NullInt64
        var nullableContent sql.NullString
        var nullableCreatedAt sql.NullTime
        
        err := rows.Scan(
            &postID, &postTitle, &postContent, &authorID, &postPublishedAt,
            &nullableCommentID, &nullableUserID, &nullableContent, &nullableCreatedAt,
        )
        if err != nil {
            return err
        }
        
        // Create post document if it doesn't exist
        if _, exists := postMap[postID]; !exists {
            // Lookup or generate MongoDB ObjectID for author
            authorObjectID, exists := userIDMap[authorID]
            if !exists {
                // In practice, you'd look this up from your users migration
                authorObjectID = primitive.NewObjectID()
                userIDMap[authorID] = authorObjectID
            }
            
            postMap[postID] = &bson.M{
                "_id":         primitive.NewObjectID(),
                "legacy_id":   postID,
                "title":       postTitle,
                "content":     postContent,
                "author_id":   authorObjectID,
                "published_at": postPublishedAt,
                "comments":    []bson.M{}, // Will be populated later
            }
        }
        
        // Add comment if it exists
        if nullableCommentID.Valid {
            commentID = int(nullableCommentID.Int64)
            commentUserID = int(nullableUserID.Int64)
            commentContent = nullableContent.String
            commentCreatedAt = nullableCreatedAt.Time
            
            // Lookup or generate MongoDB ObjectID for comment user
            userObjectID, exists := userIDMap[commentUserID]
            if !exists {
                userObjectID = primitive.NewObjectID()
                userIDMap[commentUserID] = userObjectID
            }
            
            comment := bson.M{
                "_id":        primitive.NewObjectID(),
                "legacy_id":  commentID,
                "user_id":    userObjectID,
                "content":    commentContent,
                "created_at": commentCreatedAt,
            }
            
            commentMap[postID] = append(commentMap[postID], comment)
        }
    }
    
    // Step 3: Combine posts with their comments
    posts := make([]interface{}, 0, len(postMap))
    for postID, postDoc := range postMap {
        (*postDoc)["comments"] = commentMap[postID]
        posts = append(posts, *postDoc)
    }
    
    // Step 4: Insert posts with embedded comments
    ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
    defer cancel()
    
    _, err = mongoDB.Collection("posts").InsertMany(ctx, posts)
    return err
}
```

### Using MongoDB's Change Streams for Sync

During a phased migration, you may need to keep both databases in sync:

```go
func syncNewPostsToMongoDB(sqlDB *sql.DB, mongoDB *mongo.Database) {
    // Set up a table to track synchronized records
    _, err := sqlDB.Exec(`
        CREATE TABLE IF NOT EXISTS sync_status (
            table_name VARCHAR(50),
            last_id INT,
            last_sync TIMESTAMP
        )
    `)
    if err != nil {
        log.Fatal(err)
    }
    
    for {
        // Get last synced post ID
        var lastID int
        err := sqlDB.QueryRow("SELECT last_id FROM sync_status WHERE table_name = 'posts'").Scan(&lastID)
        if err != nil && err != sql.ErrNoRows {
            log.Printf("Error getting last sync status: %v", err)
            time.Sleep(5 * time.Second)
            continue
        }
        
        // Query new posts
        rows, err := sqlDB.Query("SELECT id, title, content, author_id, published_at FROM posts WHERE id > ? ORDER BY id LIMIT 100", lastID)
        if err != nil {
            log.Printf("Error querying posts: %v", err)
            time.Sleep(5 * time.Second)
            continue
        }
        
        // Process and insert new posts
        var posts []interface{}
        var maxID int
        
        for rows.Next() {
            var post struct {
                ID          int
                Title       string
                Content     string
                AuthorID    int
                PublishedAt time.Time
            }
            
            if err := rows.Scan(&post.ID, &post.Title, &post.Content, &post.AuthorID, &post.PublishedAt); err != nil {
                log.Printf("Error scanning post: %v", err)
                continue
            }
            
            if post.ID > maxID {
                maxID = post.ID
            }
            
            // Convert to MongoDB document
            // ... (similar to previous examples)
            
            posts = append(posts, bson.M{
                "_id":         primitive.NewObjectID(),
                "legacy_id":   post.ID,
                "title":       post.Title,
                "content":     post.Content,
                "author_id":   post.AuthorID, // You'd need to map this to an ObjectID
                "published_at": post.PublishedAt,
                "comments":    []bson.M{},
            })
        }
        rows.Close()
        
        // Insert to MongoDB if we have new posts
        if len(posts) > 0 {
            ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
            _, err = mongoDB.Collection("posts").InsertMany(ctx, posts)
            cancel()
            
            if err != nil {
                log.Printf("Error inserting to MongoDB: %v", err)
                time.Sleep(5 * time.Second)
                continue
            }
            
            // Update sync status
            _, err = sqlDB.Exec("INSERT INTO sync_status (table_name, last_id, last_sync) VALUES ('posts', ?, NOW()) ON DUPLICATE KEY UPDATE last_id = ?, last_sync = NOW()", maxID, maxID)
            if err != nil {
                log.Printf("Error updating sync status: %v", err)
            }
        }
        
        // Wait before next sync
        time.Sleep(10 * time.Second)
    }
}
```

## Query and Index Migration

Converting your SQL queries to MongoDB requires understanding MongoDB's query language:

### Basic Query Translation

| SQL Query | MongoDB Query |
|-----------|---------------|
| SELECT * FROM users WHERE status = 'active' | collection.Find(bson.M{"status": "active"}) |
| SELECT * FROM users WHERE age > 21 | collection.Find(bson.M{"age": bson.M{"$gt": 21}}) |
| SELECT * FROM users WHERE status IN ('active', 'pending') | collection.Find(bson.M{"status": bson.M{"$in": []string{"active", "pending"}}}) |
| SELECT * FROM users ORDER BY created_at DESC LIMIT 10 | collection.Find(bson.M{}).Sort(bson.M{"created_at": -1}).Limit(10) |

### Complex Query Examples

1. **SQL Joins → MongoDB Lookup**

   SQL:
   ```sql
   SELECT u.name, p.title
   FROM users u
   JOIN posts p ON u.id = p.author_id
   WHERE u.status = 'active'
   ```

   MongoDB Aggregation:
   ```go
   pipeline := mongo.Pipeline{
       {{"$match", bson.M{"status": "active"}}},
       {{"$lookup", bson.M{
           "from":         "posts",
           "localField":   "_id",
           "foreignField": "author_id",
           "as":           "user_posts",
       }}},
       {{"$unwind", "$user_posts"}},
       {{"$project", bson.M{
           "_id":       0,
           "name":      1,
           "postTitle": "$user_posts.title",
       }}},
   }
   
   cursor, err := collection.Aggregate(context.Background(), pipeline)
   ```

2. **SQL Subquery → MongoDB Aggregation**

   SQL:
   ```sql
   SELECT u.name, 
          (SELECT COUNT(*) FROM posts WHERE author_id = u.id) as post_count
   FROM users u
   WHERE u.status = 'active'
   ```

   MongoDB Aggregation:
   ```go
   pipeline := mongo.Pipeline{
       {{"$match", bson.M{"status": "active"}}},
       {{"$lookup", bson.M{
           "from":         "posts",
           "localField":   "_id",
           "foreignField": "author_id",
           "as":           "user_posts",
       }}},
       {{"$project", bson.M{
           "name":      1,
           "post_count": bson.M{"$size": "$user_posts"},
       }}},
   }
   ```

3. **SQL GROUP BY → MongoDB Group**

   SQL:
   ```sql
   SELECT category, COUNT(*) as post_count, AVG(views) as avg_views
   FROM posts
   GROUP BY category
   HAVING COUNT(*) > 5
   ORDER BY post_count DESC
   ```

   MongoDB Aggregation:
   ```go
   pipeline := mongo.Pipeline{
       {{"$group", bson.M{
           "_id":       "$category",
           "post_count": bson.M{"$sum": 1},
           "avg_views":  bson.M{"$avg": "$views"},
       }}},
       {{"$match", bson.M{"post_count": bson.M{"$gt": 5}}}},
       {{"$sort", bson.M{"post_count": -1}}},
       {{"$project", bson.M{
           "_id":       0,
           "category":  "$_id",
           "post_count": 1,
           "avg_views":  1,
       }}},
   }
   ```

### Index Migration

Properly migrating indexes is crucial for maintaining performance:

```go
func migrateIndexes(mongoClient *mongo.Client) error {
    // Create a unique index on users.email
    indexModel := mongo.IndexModel{
        Keys:    bson.D{{"email", 1}},
        Options: options.Index().SetUnique(true),
    }
    
    _, err := mongoClient.Database("myapp").Collection("users").Indexes().CreateOne(
        context.Background(), 
        indexModel,
    )
    if err != nil {
        return fmt.Errorf("failed to create unique index on users.email: %w", err)
    }
    
    // Create a compound index on posts collection
    compoundIndex := mongo.IndexModel{
        Keys: bson.D{
            {"author_id", 1},
            {"created_at", -1},
        },
        Options: options.Index().SetName("author_created_index"),
    }
    
    _, err = mongoClient.Database("myapp").Collection("posts").Indexes().CreateOne(
        context.Background(),
        compoundIndex,
    )
    if err != nil {
        return fmt.Errorf("failed to create compound index on posts: %w", err)
    }
    
    // Create a text index for search
    textIndex := mongo.IndexModel{
        Keys: bson.D{{"title", "text"}, {"content", "text"}},
        Options: options.Index().SetName("content_search_index"),
    }
    
    _, err = mongoClient.Database("myapp").Collection("posts").Indexes().CreateOne(
        context.Background(),
        textIndex,
    )
    if err != nil {
        return fmt.Errorf("failed to create text index on posts: %w", err)
    }
    
    return nil
}
```

## Handling Transactions

MongoDB supports multi-document transactions starting from version 4.0:

### SQL Transaction Migration

SQL transaction:

```go
func createPostWithComments(db *sql.DB, post Post, comments []Comment) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()
    
    // Insert post
    result, err := tx.Exec("INSERT INTO posts (title, content, author_id) VALUES (?, ?, ?)",
        post.Title, post.Content, post.AuthorID)
    if err != nil {
        return err
    }
    
    postID, err := result.LastInsertId()
    if err != nil {
        return err
    }
    
    // Insert comments
    for _, comment := range comments {
        _, err := tx.Exec("INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)",
            postID, comment.UserID, comment.Content)
        if err != nil {
            return err
        }
    }
    
    return tx.Commit()
}
```

MongoDB transaction:

```go
func createPostWithComments(client *mongo.Client, post Post, comments []Comment) error {
    // Start a session
    session, err := client.StartSession()
    if err != nil {
        return err
    }
    defer session.EndSession(context.Background())
    
    // Start a transaction
    callback := func(sessionContext mongo.SessionContext) (interface{}, error) {
        // Insert post
        post.ID = primitive.NewObjectID()
        postResult, err := client.Database("myapp").Collection("posts").InsertOne(
            sessionContext,
            post,
        )
        if err != nil {
            return nil, err
        }
        
        // For separate collections approach:
        if len(comments) > 0 {
            // Set post ID in comments
            for i := range comments {
                comments[i].ID = primitive.NewObjectID()
                comments[i].PostID = post.ID
            }
            
            // Convert to interface slice
            commentDocs := make([]interface{}, len(comments))
            for i, comment := range comments {
                commentDocs[i] = comment
            }
            
            // Insert comments
            _, err = client.Database("myapp").Collection("comments").InsertMany(
                sessionContext,
                commentDocs,
            )
            if err != nil {
                return nil, err
            }
        }
        
        return postResult.InsertedID, nil
    }
    
    // Execute the transaction
    _, err = session.WithTransaction(context.Background(), callback)
    return err
}
```

### When to Use Transactions

MongoDB transactions have more overhead compared to SQL transactions. Use them only when necessary:

- **Embedded Documents**: If you embed related data, you often don't need transactions
- **Independent Updates**: Single document atomicity is guaranteed by MongoDB
- **Performance**: Transactions can impact performance, especially in sharded clusters

## Migration Testing Strategies

Thorough testing is essential for a successful migration:

### Dual-Write Testing

During the transition phase, write to both databases and verify consistency:

```go
func createUserWithDualWrite(sqlDB *sql.DB, mongoDB *mongo.Database, user User) error {
    // Begin SQL transaction
    tx, err := sqlDB.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()
    
    // Insert into SQL
    result, err := tx.Exec("INSERT INTO users (name, email) VALUES (?, ?)",
        user.Name, user.Email)
    if err != nil {
        return err
    }
    
    sqlID, err := result.LastInsertId()
    if err != nil {
        return err
    }
    
    // Commit SQL transaction
    if err := tx.Commit(); err != nil {
        return err
    }
    
    // Generate MongoDB ID and insert into MongoDB
    user.ID = primitive.NewObjectID()
    user.LegacyID = int(sqlID)
    
    _, err = mongoDB.Collection("users").InsertOne(context.Background(), user)
    if err != nil {
        // Log MongoDB error but don't fail the request
        log.Printf("MongoDB insert failed: %v", err)
    }
    
    return nil
}
```

### Functional Testing

Implement comprehensive test cases that validate both databases:

```go
func TestUserCreation(t *testing.T) {
    // Setup test databases
    sqlDB := setupTestSQLDB(t)
    mongoDB := setupTestMongoDB(t)
    defer cleanupTestDatabases(t, sqlDB, mongoDB)
    
    // Create user service with dual-write capability
    userService := NewUserServiceWithDualWrite(sqlDB, mongoDB)
    
    // Test user creation
    user := User{
        Name:  "Test User",
        Email: "test@example.com",
    }
    
    err := userService.CreateUser(user)
    require.NoError(t, err)
    
    // Verify SQL database
    var sqlUser User
    err = sqlDB.QueryRow("SELECT id, name, email FROM users WHERE email = ?", user.Email).
        Scan(&sqlUser.LegacyID, &sqlUser.Name, &sqlUser.Email)
    require.NoError(t, err)
    require.Equal(t, user.Name, sqlUser.Name)
    
    // Verify MongoDB
    var mongoUser User
    err = mongoDB.Collection("users").FindOne(
        context.Background(),
        bson.M{"email": user.Email},
    ).Decode(&mongoUser)
    require.NoError(t, err)
    require.Equal(t, user.Name, mongoUser.Name)
    require.Equal(t, sqlUser.LegacyID, mongoUser.LegacyID)
}
```

### Load Testing

Validate performance under load:

```go
func runLoadTest(sqlRepo, mongoRepo Repository) {
    // Setup test parameters
    userCount := 1000
    concurrency := 10
    var wg sync.WaitGroup
    
    // Start load test
    sqlStartTime := time.Now()
    wg.Add(concurrency)
    
    for i := 0; i < concurrency; i++ {
        go func(workerID int) {
            defer wg.Done()
            start := workerID * (userCount / concurrency)
            end := start + (userCount / concurrency)
            
            for j := start; j < end; j++ {
                user := generateTestUser(j)
                sqlRepo.CreateUser(user)
            }
        }(i)
    }
    
    wg.Wait()
    sqlDuration := time.Since(sqlStartTime)
    
    // MongoDB load test
    mongoStartTime := time.Now()
    wg.Add(concurrency)
    
    for i := 0; i < concurrency; i++ {
        go func(workerID int) {
            defer wg.Done()
            start := workerID * (userCount / concurrency)
            end := start + (userCount / concurrency)
            
            for j := start; j < end; j++ {
                user := generateTestUser(j)
                mongoRepo.CreateUser(user)
            }
        }(i)
    }
    
    wg.Wait()
    mongoDuration := time.Since(mongoStartTime)
    
    // Compare results
    fmt.Printf("SQL: %d ops in %v (%.2f ops/sec)\n", 
        userCount, sqlDuration, float64(userCount)/sqlDuration.Seconds())
    fmt.Printf("MongoDB: %d ops in %v (%.2f ops/sec)\n", 
        userCount, mongoDuration, float64(userCount)/mongoDuration.Seconds())
}
```

## Performance Considerations

Optimizing MongoDB performance requires different strategies than SQL:

### Common MongoDB Optimization Techniques

1. **Proper Indexing**

   ```go
   // Create indexes for common query patterns
   func createIndexes(db *mongo.Database) error {
       // Create a compound index with a hint on sorting
       indexModel := mongo.IndexModel{
           Keys: bson.D{
               {"user_id", 1},
               {"created_at", -1},
           },
       }
       
       _, err := db.Collection("orders").Indexes().CreateOne(context.Background(), indexModel)
       return err
   }
   ```

2. **Projection to Limit Retrieved Fields**

   ```go
   // Only fetch the fields you need
   opts := options.Find().SetProjection(bson.M{
       "title": 1,
       "author.name": 1,
       "_id": 0,
   })
   
   cursor, err := collection.Find(context.Background(), filter, opts)
   ```

3. **Bulk Operations for Better Performance**

   ```go
   // Use bulk writes for batch operations
   var models []mongo.WriteModel
   
   for _, item := range items {
       model := mongo.NewUpdateOneModel().
           SetFilter(bson.M{"_id": item.ID}).
           SetUpdate(bson.M{"$set": bson.M{"status": "processed"}})
       
       models = append(models, model)
   }
   
   opts := options.BulkWrite().SetOrdered(false)
   result, err := collection.BulkWrite(context.Background(), models, opts)
   ```

4. **Use Aggregation Pipeline for Complex Queries**

   ```go
   // Use aggregation pipeline instead of multiple queries
   pipeline := mongo.Pipeline{
       {{"$match", bson.M{"status": "completed"}}},
       {{"$group", bson.M{
           "_id": "$user_id",
           "order_count": bson.M{"$sum": 1},
           "total_spent": bson.M{"$sum": "$amount"},
       }}},
       {{"$sort", bson.M{"total_spent": -1}}},
       {{"$limit", 100}},
   }
   
   cursor, err := collection.Aggregate(context.Background(), pipeline)
   ```

5. **Use Query Hints When Necessary**

   ```go
   // Force MongoDB to use a specific index
   opts := options.Find().SetHint(bson.D{{"user_id", 1}, {"created_at", -1}})
   cursor, err := collection.Find(context.Background(), filter, opts)
   ```

### Monitoring Performance

Implement monitoring to identify performance issues:

```go
func monitorQueryPerformance(collection *mongo.Collection, query bson.M) {
    ctx := context.Background()
    
    // Get explain plan
    opts := options.Explain().SetVerbose(true)
    result, err := collection.Find(ctx, query).Explain(ctx, opts)
    if err != nil {
        log.Printf("Error getting explain plan: %v", err)
        return
    }
    
    // Analyze execution plan
    var explainResult bson.M
    bson.Unmarshal(result, &explainResult)
    
    // Check if we're using an index
    executionStats, ok := explainResult["executionStats"].(bson.M)
    if !ok {
        log.Println("No execution stats available")
        return
    }
    
    totalDocsExamined := executionStats["totalDocsExamined"].(int64)
    nReturned := executionStats["nReturned"].(int64)
    executionTimeMillis := executionStats["executionTimeMillis"].(int64)
    
    log.Printf("Query stats: examined=%d, returned=%d, time=%dms", 
        totalDocsExamined, nReturned, executionTimeMillis)
    
    // Check for collection scan (missing index)
    if totalDocsExamined > 100 && totalDocsExamined > nReturned*10 {
        log.Printf("WARNING: Possible missing index. Examining %d docs to return %d results", 
            totalDocsExamined, nReturned)
    }
}
```

## MongoDB Best Practices in Go

Follow these best practices for optimal MongoDB usage with Go:

### Efficient Document Design

```go
// Good: Logical embedding of related data
type Order struct {
    ID          primitive.ObjectID `bson:"_id"`
    CustomerID  primitive.ObjectID `bson:"customer_id"`
    Status      string             `bson:"status"`
    Total       float64            `bson:"total"`
    Items       []OrderItem        `bson:"items"` // Embedded items
    ShippingAddress Address        `bson:"shipping_address"`
    BillingAddress  Address        `bson:"billing_address"`
    CreatedAt    time.Time         `bson:"created_at"`
    UpdatedAt    time.Time         `bson:"updated_at"`
}

// Bad: Embedding too much data
type Customer struct {
    ID         primitive.ObjectID `bson:"_id"`
    Name       string             `bson:"name"`
    Email      string             `bson:"email"`
    Orders     []Order            `bson:"orders"` // This could grow too large
    Addresses  []Address          `bson:"addresses"`
    PaymentMethods []PaymentMethod `bson:"payment_methods"`
    // ...many more fields
}
```

### Proper Error Handling

```go
func getUserByEmail(collection *mongo.Collection, email string) (*User, error) {
    var user User
    err := collection.FindOne(context.Background(), bson.M{"email": email}).Decode(&user)
    
    if err != nil {
        if err == mongo.ErrNoDocuments {
            // Handle "not found" case specifically
            return nil, ErrUserNotFound
        }
        // Handle other errors
        return nil, fmt.Errorf("database error: %w", err)
    }
    
    return &user, nil
}
```

### Connection Management

```go
// Create a singleton MongoDB client
var (
    mongoClient *mongo.Client
    clientOnce  sync.Once
    clientErr   error
)

func GetMongoClient() (*mongo.Client, error) {
    clientOnce.Do(func() {
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        
        client, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURI))
        if err != nil {
            clientErr = err
            return
        }
        
        // Ping to verify connection
        if err = client.Ping(ctx, nil); err != nil {
            clientErr = err
            return
        }
        
        mongoClient = client
    })
    
    return mongoClient, clientErr
}

// Graceful shutdown
func Shutdown() {
    if mongoClient != nil {
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        
        if err := mongoClient.Disconnect(ctx); err != nil {
            log.Printf("Error disconnecting from MongoDB: %v", err)
        }
    }
}
```

### Bulk Operations

```go
func bulkUpdateProducts(collection *mongo.Collection, updates []ProductUpdate) error {
    if len(updates) == 0 {
        return nil
    }
    
    models := make([]mongo.WriteModel, len(updates))
    for i, update := range updates {
        models[i] = mongo.NewUpdateOneModel().
            SetFilter(bson.M{"_id": update.ID}).
            SetUpdate(bson.M{
                "$set": bson.M{
                    "price": update.NewPrice,
                    "stock": update.NewStock,
                    "updated_at": time.Now(),
                },
            })
    }
    
    opts := options.BulkWrite().SetOrdered(false)
    result, err := collection.BulkWrite(context.Background(), models, opts)
    if err != nil {
        return fmt.Errorf("bulk update failed: %w", err)
    }
    
    log.Printf("Updated %d products", result.ModifiedCount)
    return nil
}
```

## Common Pitfalls and Solutions

Here are common issues encountered during SQL to MongoDB migrations and their solutions:

### 1. Document Size Limitations

**Problem**: MongoDB has a 16MB document size limit.

**Solution**: Use references for large or growing subdocuments:

```go
// Instead of embedding all reviews
type Product struct {
    ID      primitive.ObjectID `bson:"_id"`
    Name    string             `bson:"name"`
    // Don't do this if potentially thousands of reviews
    // Reviews []Review         `bson:"reviews"` 
}

// Create a separate reviews collection with references
type Review struct {
    ID        primitive.ObjectID `bson:"_id"`
    ProductID primitive.ObjectID `bson:"product_id"` 
    UserID    primitive.ObjectID `bson:"user_id"`
    Rating    int                `bson:"rating"`
    Comment   string             `bson:"comment"`
    CreatedAt time.Time          `bson:"created_at"`
}
```

### 2. Schema Validation Challenges

**Problem**: MongoDB's schemaless nature can lead to inconsistent data.

**Solution**: Use MongoDB's schema validation:

```go
func createCollectionWithValidation(db *mongo.Database, name string) error {
    validator := bson.M{
        "$jsonSchema": bson.M{
            "bsonType": "object",
            "required": []string{"name", "email", "created_at"},
            "properties": bson.M{
                "name": bson.M{
                    "bsonType": "string",
                    "description": "must be a string and is required",
                },
                "email": bson.M{
                    "bsonType": "string",
                    "pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
                    "description": "must be a valid email address and is required",
                },
                "created_at": bson.M{
                    "bsonType": "date",
                    "description": "must be a date and is required",
                },
            },
        },
    }
    
    opts := options.CreateCollection().SetValidator(validator)
    return db.CreateCollection(context.Background(), name, opts)
}
```

### 3. Query Performance Degradation

**Problem**: Inefficient queries after migration lead to performance issues.

**Solution**: Use the MongoDB profiler to identify slow queries:

```go
func enableProfiler(db *mongo.Database) error {
    // Enable profiler for slow queries (>100ms)
    return db.RunCommand(
        context.Background(),
        bson.D{
            {"profile", 1},
            {"slowms", 100},
        },
    ).Err()
}

func getSlowQueries(db *mongo.Database) ([]bson.M, error) {
    cursor, err := db.Collection("system.profile").Find(
        context.Background(),
        bson.M{},
        options.Find().SetSort(bson.M{"millis": -1}).SetLimit(10),
    )
    if err != nil {
        return nil, err
    }
    defer cursor.Close(context.Background())
    
    var results []bson.M
    if err := cursor.All(context.Background(), &results); err != nil {
        return nil, err
    }
    
    return results, nil
}
```

### 4. Transaction Limitations

**Problem**: MongoDB transactions have limitations compared to SQL transactions.

**Solution**: Design with document-oriented patterns that minimize transaction needs:

```go
// Instead of updating multiple collections in a transaction
func approveOrder(collection *mongo.Collection, orderID primitive.ObjectID) error {
    // Update the order status and inventory in a single document update
    update := bson.M{
        "$set": bson.M{
            "status": "approved",
            "approved_at": time.Now(),
        },
        "$inc": bson.M{
            "inventory_reserved": -1, // Decrement inventory as part of the same operation
        },
    }
    
    result, err := collection.UpdateOne(
        context.Background(),
        bson.M{"_id": orderID},
        update,
    )
    if err != nil {
        return err
    }
    
    if result.ModifiedCount == 0 {
        return fmt.Errorf("order not found or already processed")
    }
    
    return nil
}
```

### 5. ObjectID vs. Integer ID Confusion

**Problem**: Moving from auto-increment IDs to MongoDB's ObjectIDs can cause confusion.

**Solution**: Implement ID conversion utilities:

```go
// ID conversion utilities
type IDConverter struct {
    // Map SQL IDs to MongoDB ObjectIDs
    sqlToMongoMap map[int]primitive.ObjectID
    // Keep track of the reverse mapping
    mongoToSqlMap map[string]int
    mu            sync.RWMutex
}

func NewIDConverter() *IDConverter {
    return &IDConverter{
        sqlToMongoMap: make(map[int]primitive.ObjectID),
        mongoToSqlMap: make(map[string]int),
    }
}

func (c *IDConverter) RegisterID(sqlID int, mongoID primitive.ObjectID) {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    c.sqlToMongoMap[sqlID] = mongoID
    c.mongoToSqlMap[mongoID.Hex()] = sqlID
}

func (c *IDConverter) GetMongoID(sqlID int) (primitive.ObjectID, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    
    id, ok := c.sqlToMongoMap[sqlID]
    return id, ok
}

func (c *IDConverter) GetSQLID(mongoID primitive.ObjectID) (int, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    
    id, ok := c.mongoToSqlMap[mongoID.Hex()]
    return id, ok
}
```

## Case Study: E-commerce Platform Migration

Let's examine a real-world case study of migrating an e-commerce platform from PostgreSQL to MongoDB:

### Company Background

- Mid-sized e-commerce platform with 500,000 monthly active users
- Product catalog with 50,000+ items and growing
- Order processing system handling 1,000+ orders per day
- Existing PostgreSQL database approaching scaling limits

### Migration Challenges

1. **Complex Product Data**: Variable attributes for different product categories
2. **Order History**: Need to maintain complete historical order data
3. **Inventory Management**: Real-time inventory updates across multiple channels
4. **Search Requirements**: Advanced product search functionality
5. **Zero Downtime Requirement**: Migration without service interruption

### Migration Strategy

The team decided on a phased approach:

1. **Phase 1**: Migrate read-only product catalog to MongoDB
2. **Phase 2**: Implement dual-write for orders and inventory
3. **Phase 3**: Migrate historical order data
4. **Phase 4**: Switch to MongoDB as primary database

### Technical Implementation

**1. Product Catalog Migration**

The product schema was transformed from normalized tables to a flexible document model:

```go
// Original SQL schema (simplified)
/*
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    description TEXT,
    base_price DECIMAL(10,2),
    category_id INT,
    brand_id INT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE product_attributes (
    product_id INT,
    attribute_name VARCHAR(100),
    attribute_value TEXT,
    PRIMARY KEY (product_id, attribute_name),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE product_variants (
    id SERIAL PRIMARY KEY,
    product_id INT,
    sku VARCHAR(50),
    price DECIMAL(10,2),
    stock INT,
    FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE variant_attributes (
    variant_id INT,
    attribute_name VARCHAR(100),
    attribute_value TEXT,
    PRIMARY KEY (variant_id, attribute_name),
    FOREIGN KEY (variant_id) REFERENCES product_variants(id)
);
*/

// MongoDB product model
type Product struct {
    ID          primitive.ObjectID `bson:"_id"`
    LegacyID    int                `bson:"legacy_id"`
    Name        string             `bson:"name"`
    Description string             `bson:"description"`
    BasePrice   float64            `bson:"base_price"`
    Category    string             `bson:"category"`
    Brand       string             `bson:"brand"`
    Attributes  map[string]interface{} `bson:"attributes"` // Flexible attributes
    Variants    []ProductVariant   `bson:"variants"`
    Images      []string           `bson:"images"`
    CreatedAt   time.Time          `bson:"created_at"`
    UpdatedAt   time.Time          `bson:"updated_at"`
}

type ProductVariant struct {
    ID         primitive.ObjectID  `bson:"_id"`
    SKU        string              `bson:"sku"`
    Price      float64             `bson:"price"`
    Stock      int                 `bson:"stock"`
    Attributes map[string]interface{} `bson:"attributes"`
}
```

The migration script processed products in batches:

```go
func migrateProducts(sqlDB *sql.DB, mongodb *mongo.Database, batchSize int) error {
    // Get total product count
    var total int
    err := sqlDB.QueryRow("SELECT COUNT(*) FROM products").Scan(&total)
    if err != nil {
        return err
    }
    
    log.Printf("Migrating %d products in batches of %d", total, batchSize)
    
    for offset := 0; offset < total; offset += batchSize {
        log.Printf("Processing batch %d/%d", offset/batchSize+1, (total+batchSize-1)/batchSize)
        
        // Query products with all related data
        products, err := fetchProductBatch(sqlDB, offset, batchSize)
        if err != nil {
            return err
        }
        
        // Transform to MongoDB format
        mongoProducts := make([]interface{}, len(products))
        for i, p := range products {
            mongoProducts[i] = transformProductToMongo(p)
        }
        
        // Insert batch into MongoDB
        if len(mongoProducts) > 0 {
            _, err = mongodb.Collection("products").InsertMany(
                context.Background(),
                mongoProducts,
            )
            if err != nil {
                return fmt.Errorf("failed to insert products: %w", err)
            }
        }
    }
    
    return nil
}
```

**2. Order Processing with Dual-Write**

The team implemented a dual-write pattern for order processing:

```go
func createOrder(orderService *OrderService, order Order) error {
    // Begin database transaction
    ctx := context.Background()
    sqlTx, err := orderService.sqlDB.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer sqlTx.Rollback()
    
    // Insert order into SQL database
    var orderID int64
    err = sqlTx.QueryRowContext(ctx, `
        INSERT INTO orders (user_id, status, total, shipping_address, billing_address, created_at)
        VALUES (?, ?, ?, ?, ?, NOW())
        RETURNING id
    `, order.UserID, order.Status, order.Total, order.ShippingAddress, order.BillingAddress).Scan(&orderID)
    if err != nil {
        return err
    }
    
    // Insert order items
    for _, item := range order.Items {
        _, err = sqlTx.ExecContext(ctx, `
            INSERT INTO order_items (order_id, product_id, variant_id, quantity, price)
            VALUES (?, ?, ?, ?, ?)
        `, orderID, item.ProductID, item.VariantID, item.Quantity, item.Price)
        if err != nil {
            return err
        }
    }
    
    // Commit SQL transaction
    if err = sqlTx.Commit(); err != nil {
        return err
    }
    
    // Now write to MongoDB
    mongoOrder := transformOrderToMongo(order, orderID)
    
    _, err = orderService.mongoCollection.InsertOne(ctx, mongoOrder)
    if err != nil {
        // Log MongoDB error but don't fail the order
        // This is a critical decision - we prioritize SQL as source of truth during migration
        log.Printf("Error writing order to MongoDB (will be synced later): %v", err)
        
        // Queue for retry
        orderService.failedWrites <- mongoOrder
    }
    
    return nil
}
```

**3. Background Sync Process**

To ensure consistency, a background process synchronized data:

```go
func startSyncProcess(sqlDB *sql.DB, mongoDB *mongo.Database) {
    go func() {
        ticker := time.NewTicker(5 * time.Minute)
        defer ticker.Stop()
        
        for {
            select {
            case <-ticker.C:
                if err := syncOrderData(sqlDB, mongoDB); err != nil {
                    log.Printf("Error syncing order data: %v", err)
                }
            }
        }
    }()
}

func syncOrderData(sqlDB *sql.DB, mongoDB *mongo.Database) error {
    // Get last synced order ID
    var lastSyncedID int
    err := mongoDB.Collection("sync_state").FindOne(
        context.Background(),
        bson.M{"collection": "orders"},
    ).Decode(&struct {
        LastID int `bson:"last_id"`
    }{&lastSyncedID})
    
    if err != nil && err != mongo.ErrNoDocuments {
        return err
    }
    
    // Fetch new orders from SQL
    rows, err := sqlDB.Query(`
        SELECT id, user_id, status, total, created_at
        FROM orders
        WHERE id > $1
        ORDER BY id
        LIMIT 1000
    `, lastSyncedID)
    if err != nil {
        return err
    }
    defer rows.Close()
    
    var orders []interface{}
    var maxID int
    
    // Process orders and order items
    // ... (detailed implementation omitted for brevity)
    
    // Update sync state
    _, err = mongoDB.Collection("sync_state").UpdateOne(
        context.Background(),
        bson.M{"collection": "orders"},
        bson.M{"$set": bson.M{"last_id": maxID}},
        options.Update().SetUpsert(true),
    )
    
    return err
}
```

### Migration Results

The migration yielded significant benefits:

1. **Performance Improvements**:
   - Product page load times reduced by 45%
   - Order processing throughput increased by 60%
   - Search response times improved by 30%

2. **Operational Benefits**:
   - Database storage requirements reduced by 25%
   - Schema changes no longer required downtime
   - Development velocity increased due to flexible schema

3. **Scaling Capabilities**:
   - Able to handle 3x previous peak load without scaling issues
   - Horizontal scaling now possible for future growth
   - Simplified regional data distribution

4. **Lessons Learned**:
   - Dual-write pattern was essential for zero-downtime migration
   - Data modeling decisions had the biggest impact on performance
   - Proper indexing in MongoDB was critical for query performance
   - Some complex SQL queries were challenging to translate to MongoDB

## Conclusion

Migrating from SQL to MongoDB in a Go application is a significant undertaking that requires careful planning, execution, and monitoring. When done correctly, the benefits can include improved scalability, increased development velocity, and better performance for certain workloads.

Key takeaways from this guide:

1. **Start with data modeling**: Rethink your schema from document-oriented perspective
2. **Implement proper testing**: Use dual-write patterns and comprehensive validation
3. **Focus on indexing**: Proper MongoDB indexes are critical for performance
4. **Consider transactions carefully**: Design to minimize cross-document transactions
5. **Plan for gradual migration**: Use a phased approach with fallback options

For Go developers, MongoDB offers excellent native drivers and strong integration with the language's concurrency model. With proper implementation, your migration can unlock new capabilities while maintaining the performance and reliability your application requires.

---

*Have you migrated from SQL to MongoDB in your Go applications? Share your experiences and lessons learned in the comments below!*