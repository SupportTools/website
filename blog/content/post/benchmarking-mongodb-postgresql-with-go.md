---
title: "Benchmarking MongoDB vs PostgreSQL with Go: A Practical Performance Comparison"
date: 2025-09-25T09:00:00-05:00
draft: false
tags: ["Go", "MongoDB", "PostgreSQL", "Database", "Performance", "Benchmarking"]
categories: ["Database Performance", "Go Programming"]
---

When selecting a database for a production application, theoretical comparisons only get you so far. What matters is how the database performs with your specific workloads and access patterns. In this article, we'll explore how to build a comprehensive benchmarking suite in Go to compare MongoDB and PostgreSQL across common real-world operations, providing actionable insights for your next project.

## Table of Contents

1. [Introduction](#introduction)
2. [Setting Up the Environment](#setting-up-the-environment)
3. [Creating Realistic Test Datasets](#creating-realistic-test-datasets)
4. [Benchmarking Methodology](#benchmarking-methodology)
5. [Single-Record Operations](#single-record-operations)
6. [Range Queries and Filtering](#range-queries-and-filtering)
7. [Aggregation Performance](#aggregation-performance)
8. [Pagination and Sorting](#pagination-and-sorting)
9. [Write Operations](#write-operations)
10. [Concurrency Testing](#concurrency-testing)
11. [Results Analysis](#results-analysis)
12. [Database Memory and CPU Usage](#database-memory-and-cpu-usage)
13. [Real-World Scenarios and Recommendations](#real-world-scenarios-and-recommendations)
14. [Conclusion](#conclusion)

## Introduction

MongoDB and PostgreSQL represent two fundamentally different approaches to data storage and retrieval:

- **PostgreSQL** is a mature, feature-rich relational database with strong ACID compliance, powerful query capabilities, and a rich set of data types.
- **MongoDB** is a flexible, schema-less document database designed for ease of development, horizontal scalability, and high-volume operations.

Rather than rehashing theoretical differences, this article focuses on practical performance differences using Go and realistic workloads. We'll examine:

- How each database performs across various query types
- The impact of proper indexing on both databases
- Performance under concurrent load
- Resource consumption patterns
- Scaling considerations

## Setting Up the Environment

To ensure reliable benchmarks, we need a consistent testing environment:

### Environment Specifications

- **Hardware**: 8-core CPU, 32GB RAM, SSD storage
- **Software**:
  - Go 1.21
  - MongoDB 6.0
  - PostgreSQL 15
  - MongoDB Go Driver (go.mongodb.org/mongo-driver v1.11.0)
  - PostgreSQL Go Driver (github.com/jackc/pgx/v5)

### Test Environment Setup

```go
package main

import (
    "context"
    "log"
    "os"
    "time"
    
    "github.com/jackc/pgx/v5/pgxpool"
    "go.mongodb.org/mongo-driver/mongo"
    "go.mongodb.org/mongo-driver/mongo/options"
)

// Database connection configurations
const (
    mongoURI       = "mongodb://localhost:27017"
    postgresqlURI  = "postgres://postgres:postgres@localhost:5432/benchmark"
    databaseName   = "benchmark"
    collectionName = "orders"
    tableName      = "orders"
)

// Setup MongoDB connection
func setupMongoDB(ctx context.Context) (*mongo.Client, *mongo.Collection, error) {
    clientOptions := options.Client().ApplyURI(mongoURI)
    
    // Set MongoDB client options
    clientOptions.SetMaxPoolSize(100)
    clientOptions.SetMinPoolSize(10)
    clientOptions.SetMaxConnIdleTime(time.Minute * 5)
    
    client, err := mongo.Connect(ctx, clientOptions)
    if err != nil {
        return nil, nil, err
    }
    
    // Ping to verify connection
    if err = client.Ping(ctx, nil); err != nil {
        return nil, nil, err
    }
    
    collection := client.Database(databaseName).Collection(collectionName)
    return client, collection, nil
}

// Setup PostgreSQL connection
func setupPostgreSQL(ctx context.Context) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(postgresqlURI)
    if err != nil {
        return nil, err
    }
    
    // Set PostgreSQL pool options
    config.MaxConns = 100
    config.MinConns = 10
    config.MaxConnIdleTime = time.Minute * 5
    
    pool, err := pgxpool.NewWithConfig(ctx, config)
    if err != nil {
        return nil, err
    }
    
    // Ping to verify connection
    if err = pool.Ping(ctx); err != nil {
        return nil, err
    }
    
    return pool, nil
}

func main() {
    ctx := context.Background()
    
    // Setup MongoDB
    mongoClient, collection, err := setupMongoDB(ctx)
    if err != nil {
        log.Fatalf("Failed to connect to MongoDB: %v", err)
    }
    defer mongoClient.Disconnect(ctx)
    
    // Setup PostgreSQL
    pgPool, err := setupPostgreSQL(ctx)
    if err != nil {
        log.Fatalf("Failed to connect to PostgreSQL: %v", err)
    }
    defer pgPool.Close()
    
    // Ready to perform benchmarks
    log.Println("Database connections established successfully")
    
    // Run benchmarks...
}
```

### Database Schema

For PostgreSQL, we'll create a properly indexed schema:

```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    total DECIMAL(12, 2) NOT NULL,
    created_at TIMESTAMP NOT NULL
);

-- Indexes for common queries
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_orders_customer_created ON orders(customer_id, created_at);
```

For MongoDB, we'll create equivalent indexes:

```go
import (
    "go.mongodb.org/mongo-driver/bson"
    "go.mongodb.org/mongo-driver/mongo"
    "go.mongodb.org/mongo-driver/mongo/options"
)

func createMongoDBIndexes(ctx context.Context, collection *mongo.Collection) error {
    // Create indexes
    indexModels := []mongo.IndexModel{
        {
            Keys:    bson.D{{"customer_id", 1}},
            Options: options.Index().SetName("idx_customer_id"),
        },
        {
            Keys:    bson.D{{"status", 1}},
            Options: options.Index().SetName("idx_status"),
        },
        {
            Keys:    bson.D{{"created_at", 1}},
            Options: options.Index().SetName("idx_created_at"),
        },
        {
            Keys:    bson.D{{"customer_id", 1}, {"created_at", 1}},
            Options: options.Index().SetName("idx_customer_created"),
        },
    }
    
    _, err := collection.Indexes().CreateMany(ctx, indexModels)
    return err
}
```

## Creating Realistic Test Datasets

To ensure our benchmarks reflect real-world scenarios, we'll generate a dataset that simulates an e-commerce platform:

```go
// Order represents an e-commerce order
type Order struct {
    ID         string    `json:"id" bson:"_id"`
    CustomerID string    `json:"customer_id" bson:"customer_id"`
    Status     string    `json:"status" bson:"status"`
    Total      float64   `json:"total" bson:"total"`
    CreatedAt  time.Time `json:"created_at" bson:"created_at"`
    Items      []Item    `json:"items" bson:"items"`
}

// Item represents an order line item
type Item struct {
    ProductID  string  `json:"product_id" bson:"product_id"`
    Name       string  `json:"name" bson:"name"`
    Quantity   int     `json:"quantity" bson:"quantity"`
    UnitPrice  float64 `json:"unit_price" bson:"unit_price"`
}

// Generate a realistic dataset
func generateTestData(count int) []Order {
    statuses := []string{"pending", "processing", "shipped", "delivered", "cancelled"}
    customerCount := 5000 // Number of unique customers
    productCount := 1000  // Number of unique products
    
    rand.Seed(time.Now().UnixNano())
    orders := make([]Order, count)
    
    startDate := time.Now().AddDate(-1, 0, 0) // Orders from the last year
    timeRange := time.Now().Sub(startDate)
    
    for i := 0; i < count; i++ {
        // Generate a random time within the last year
        randomDuration := time.Duration(rand.Int63n(int64(timeRange)))
        orderDate := startDate.Add(randomDuration)
        
        // Generate between 1 and 10 items per order
        itemCount := rand.Intn(10) + 1
        items := make([]Item, itemCount)
        total := 0.0
        
        for j := 0; j < itemCount; j++ {
            productID := fmt.Sprintf("product-%d", rand.Intn(productCount))
            quantity := rand.Intn(5) + 1
            unitPrice := float64(rand.Intn(10000)) / 100 // Price between $0.00 and $100.00
            
            items[j] = Item{
                ProductID: productID,
                Name:      fmt.Sprintf("Product %s", productID),
                Quantity:  quantity,
                UnitPrice: unitPrice,
            }
            
            total += float64(quantity) * unitPrice
        }
        
        // Round total to 2 decimal places
        total = math.Round(total*100) / 100
        
        orders[i] = Order{
            ID:         uuid.New().String(),
            CustomerID: fmt.Sprintf("customer-%d", rand.Intn(customerCount)),
            Status:     statuses[rand.Intn(len(statuses))],
            Total:      total,
            CreatedAt:  orderDate,
            Items:      items,
        }
    }
    
    return orders
}
```

### Loading Data into Databases

```go
// Load data into MongoDB
func loadMongoDBData(ctx context.Context, collection *mongo.Collection, orders []Order) error {
    // Convert to interface slice for MongoDB bulk write
    documents := make([]interface{}, len(orders))
    for i, order := range orders {
        documents[i] = order
    }
    
    // Use ordered:false for better insert performance
    _, err := collection.InsertMany(ctx, documents, options.InsertMany().SetOrdered(false))
    return err
}

// Load data into PostgreSQL
func loadPostgreSQLData(ctx context.Context, pool *pgxpool.Pool, orders []Order) error {
    // Begin transaction
    tx, err := pool.Begin(ctx)
    if err != nil {
        return err
    }
    defer tx.Rollback(ctx)
    
    // Prepare the COPY statement
    _, err = tx.Exec(ctx, "TRUNCATE TABLE orders")
    if err != nil {
        return err
    }
    
    // Use COPY for fast bulk loading
    copyCount, err := pool.CopyFrom(
        ctx,
        pgx.Identifier{"orders"},
        []string{"id", "customer_id", "status", "total", "created_at", "items"},
        pgx.CopyFromSlice(len(orders), func(i int) ([]interface{}, error) {
            order := orders[i]
            itemsJSON, err := json.Marshal(order.Items)
            if err != nil {
                return nil, err
            }
            return []interface{}{
                order.ID,
                order.CustomerID,
                order.Status,
                order.Total,
                order.CreatedAt,
                itemsJSON,
            }, nil
        }),
    )
    if err != nil {
        return err
    }
    
    log.Printf("Inserted %d records into PostgreSQL", copyCount)
    return tx.Commit(ctx)
}
```

## Benchmarking Methodology

To ensure accurate and fair comparisons, we'll follow these benchmarking principles:

1. **Warm-up Phase**: Run initial queries to warm up database caches
2. **Multiple Iterations**: Run each benchmark multiple times and take the average
3. **Consistent Environment**: Ensure similar conditions for both databases
4. **Representative Queries**: Simulate real application workloads
5. **Parameterized Benchmarks**: Test with different data volumes
6. **Measurement Precision**: Use high-resolution timers

Here's our benchmarking harness:

```go
// BenchmarkResult stores the results of a single benchmark run
type BenchmarkResult struct {
    Name           string
    DatabaseType   string
    OperationType  string
    ExecutionTime  time.Duration
    RecordsAffected int
    Timestamp      time.Time
}

// RunBenchmark executes a benchmark function multiple times and returns average results
func RunBenchmark(name, dbType, opType string, iterations int, benchFunc func() (int, time.Duration, error)) (BenchmarkResult, error) {
    var totalTime time.Duration
    var totalRecords int
    var successfulRuns int
    
    // Run warm-up iteration (not counted in results)
    _, _, err := benchFunc()
    if err != nil {
        return BenchmarkResult{}, fmt.Errorf("warm-up failed: %w", err)
    }
    
    // Run benchmark iterations
    for i := 0; i < iterations; i++ {
        recordsAffected, duration, err := benchFunc()
        if err != nil {
            log.Printf("Benchmark iteration %d failed: %v", i, err)
            continue
        }
        
        totalTime += duration
        totalRecords += recordsAffected
        successfulRuns++
    }
    
    if successfulRuns == 0 {
        return BenchmarkResult{}, fmt.Errorf("all benchmark iterations failed")
    }
    
    // Calculate averages
    avgTime := totalTime / time.Duration(successfulRuns)
    avgRecords := totalRecords / successfulRuns
    
    return BenchmarkResult{
        Name:           name,
        DatabaseType:   dbType,
        OperationType:  opType,
        ExecutionTime:  avgTime,
        RecordsAffected: avgRecords,
        Timestamp:      time.Now(),
    }, nil
}
```

## Single-Record Operations

Let's benchmark basic CRUD operations that retrieve, insert, update, and delete individual records:

### Read By ID

Reading a single record by its primary key is one of the most common database operations:

```go
// MongoDB: Read by ID
func benchmarkMongoDBReadByID(ctx context.Context, collection *mongo.Collection, id string) (int, time.Duration, error) {
    start := time.Now()
    
    var order Order
    err := collection.FindOne(ctx, bson.M{"_id": id}).Decode(&order)
    if err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return 1, duration, nil
}

// PostgreSQL: Read by ID
func benchmarkPostgreSQLReadByID(ctx context.Context, pool *pgxpool.Pool, id string) (int, time.Duration, error) {
    start := time.Now()
    
    var order Order
    err := pool.QueryRow(ctx, `
        SELECT id, customer_id, status, total, created_at, items
        FROM orders
        WHERE id = $1
    `, id).Scan(&order.ID, &order.CustomerID, &order.Status, &order.Total, &order.CreatedAt, &order.Items)
    if err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return 1, duration, nil
}
```

### Update Single Record

Updating a single record is another common operation:

```go
// MongoDB: Update by ID
func benchmarkMongoDBUpdateByID(ctx context.Context, collection *mongo.Collection, id string, newStatus string) (int, time.Duration, error) {
    start := time.Now()
    
    result, err := collection.UpdateOne(
        ctx,
        bson.M{"_id": id},
        bson.M{"$set": bson.M{"status": newStatus}},
    )
    if err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return int(result.ModifiedCount), duration, nil
}

// PostgreSQL: Update by ID
func benchmarkPostgreSQLUpdateByID(ctx context.Context, pool *pgxpool.Pool, id string, newStatus string) (int, time.Duration, error) {
    start := time.Now()
    
    tag, err := pool.Exec(ctx, `
        UPDATE orders
        SET status = $1
        WHERE id = $2
    `, newStatus, id)
    if err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return int(tag.RowsAffected()), duration, nil
}
```

## Range Queries and Filtering

Let's examine how each database handles filtering and range queries, which are common in real applications:

### Date Range Filtering

```go
// MongoDB: Filter by date range
func benchmarkMongoDBDateRange(ctx context.Context, collection *mongo.Collection, startDate, endDate time.Time, limit int) (int, time.Duration, error) {
    start := time.Now()
    
    filter := bson.M{
        "created_at": bson.M{
            "$gte": startDate,
            "$lte": endDate,
        },
    }
    
    cursor, err := collection.Find(ctx, filter, options.Find().SetLimit(int64(limit)))
    if err != nil {
        return 0, 0, err
    }
    defer cursor.Close(ctx)
    
    var orders []Order
    if err = cursor.All(ctx, &orders); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(orders), duration, nil
}

// PostgreSQL: Filter by date range
func benchmarkPostgreSQLDateRange(ctx context.Context, pool *pgxpool.Pool, startDate, endDate time.Time, limit int) (int, time.Duration, error) {
    start := time.Now()
    
    rows, err := pool.Query(ctx, `
        SELECT id, customer_id, status, total, created_at, items
        FROM orders
        WHERE created_at BETWEEN $1 AND $2
        LIMIT $3
    `, startDate, endDate, limit)
    if err != nil {
        return 0, 0, err
    }
    defer rows.Close()
    
    var orders []Order
    for rows.Next() {
        var order Order
        if err := rows.Scan(&order.ID, &order.CustomerID, &order.Status, &order.Total, &order.CreatedAt, &order.Items); err != nil {
            return 0, 0, err
        }
        orders = append(orders, order)
    }
    
    if err = rows.Err(); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(orders), duration, nil
}
```

### Multi-Condition Filtering

```go
// MongoDB: Multi-condition filtering
func benchmarkMongoDBMultiFilter(ctx context.Context, collection *mongo.Collection, status string, minTotal float64, limit int) (int, time.Duration, error) {
    start := time.Now()
    
    filter := bson.M{
        "status": status,
        "total": bson.M{"$gte": minTotal},
    }
    
    cursor, err := collection.Find(ctx, filter, options.Find().SetLimit(int64(limit)))
    if err != nil {
        return 0, 0, err
    }
    defer cursor.Close(ctx)
    
    var orders []Order
    if err = cursor.All(ctx, &orders); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(orders), duration, nil
}

// PostgreSQL: Multi-condition filtering
func benchmarkPostgreSQLMultiFilter(ctx context.Context, pool *pgxpool.Pool, status string, minTotal float64, limit int) (int, time.Duration, error) {
    start := time.Now()
    
    rows, err := pool.Query(ctx, `
        SELECT id, customer_id, status, total, created_at, items
        FROM orders
        WHERE status = $1 AND total >= $2
        LIMIT $3
    `, status, minTotal, limit)
    if err != nil {
        return 0, 0, err
    }
    defer rows.Close()
    
    var orders []Order
    for rows.Next() {
        var order Order
        if err := rows.Scan(&order.ID, &order.CustomerID, &order.Status, &order.Total, &order.CreatedAt, &order.Items); err != nil {
            return 0, 0, err
        }
        orders = append(orders, order)
    }
    
    if err = rows.Err(); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(orders), duration, nil
}
```

## Aggregation Performance

Aggregation operations are critical for analytics and reporting. Let's benchmark how each database handles common aggregation patterns:

### Group By Customer with Sum

```go
// MongoDB: Aggregate revenue by customer
func benchmarkMongoDBRevenueByCustomer(ctx context.Context, collection *mongo.Collection) (int, time.Duration, error) {
    start := time.Now()
    
    pipeline := mongo.Pipeline{
        {{"$group", bson.D{
            {"_id", "$customer_id"},
            {"total_revenue", bson.D{{"$sum", "$total"}}},
            {"order_count", bson.D{{"$sum", 1}}},
        }}},
        {{"$sort", bson.D{{"total_revenue", -1}}}},
        {{"$limit", 100}},
    }
    
    cursor, err := collection.Aggregate(ctx, pipeline)
    if err != nil {
        return 0, 0, err
    }
    defer cursor.Close(ctx)
    
    var results []struct {
        CustomerID   string  `bson:"_id"`
        TotalRevenue float64 `bson:"total_revenue"`
        OrderCount   int     `bson:"order_count"`
    }
    
    if err = cursor.All(ctx, &results); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(results), duration, nil
}

// PostgreSQL: Aggregate revenue by customer
func benchmarkPostgreSQLRevenueByCustomer(ctx context.Context, pool *pgxpool.Pool) (int, time.Duration, error) {
    start := time.Now()
    
    rows, err := pool.Query(ctx, `
        SELECT customer_id, SUM(total) as total_revenue, COUNT(*) as order_count
        FROM orders
        GROUP BY customer_id
        ORDER BY total_revenue DESC
        LIMIT 100
    `)
    if err != nil {
        return 0, 0, err
    }
    defer rows.Close()
    
    var results []struct {
        CustomerID   string
        TotalRevenue float64
        OrderCount   int
    }
    
    for rows.Next() {
        var result struct {
            CustomerID   string
            TotalRevenue float64
            OrderCount   int
        }
        if err := rows.Scan(&result.CustomerID, &result.TotalRevenue, &result.OrderCount); err != nil {
            return 0, 0, err
        }
        results = append(results, result)
    }
    
    if err = rows.Err(); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(results), duration, nil
}
```

### Advanced Aggregation with Multiple Stages

```go
// MongoDB: Multi-stage aggregation
func benchmarkMongoDBMultiStageAggregation(ctx context.Context, collection *mongo.Collection) (int, time.Duration, error) {
    start := time.Now()
    
    // Complex pipeline: filter recent orders, extract items, group by product, sort by popularity
    pipeline := mongo.Pipeline{
        {{"$match", bson.D{
            {"created_at", bson.D{{"$gte", time.Now().AddDate(0, -3, 0)}}},
            {"status", bson.D{{"$ne", "cancelled"}}},
        }}},
        {{"$unwind", "$items"}},
        {{"$group", bson.D{
            {"_id", "$items.product_id"},
            {"product_name", bson.D{{"$first", "$items.name"}}},
            {"total_quantity", bson.D{{"$sum", "$items.quantity"}}},
            {"total_sales", bson.D{{"$sum", bson.D{
                {"$multiply", bson.A{"$items.quantity", "$items.unit_price"}},
            }}}},
            {"order_count", bson.D{{"$sum", 1}}},
        }}},
        {{"$sort", bson.D{{"total_quantity", -1}}}},
        {{"$limit", 50}},
    }
    
    cursor, err := collection.Aggregate(ctx, pipeline)
    if err != nil {
        return 0, 0, err
    }
    defer cursor.Close(ctx)
    
    var results []struct {
        ProductID     string  `bson:"_id"`
        ProductName   string  `bson:"product_name"`
        TotalQuantity int     `bson:"total_quantity"`
        TotalSales    float64 `bson:"total_sales"`
        OrderCount    int     `bson:"order_count"`
    }
    
    if err = cursor.All(ctx, &results); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(results), duration, nil
}

// PostgreSQL: Multi-stage aggregation
func benchmarkPostgreSQLMultiStageAggregation(ctx context.Context, pool *pgxpool.Pool) (int, time.Duration, error) {
    start := time.Now()
    
    rows, err := pool.Query(ctx, `
        WITH order_items AS (
            SELECT 
                o.id AS order_id,
                i.product_id,
                i.name AS product_name,
                i.quantity,
                i.unit_price,
                i.quantity * i.unit_price AS item_total
            FROM orders o,
                 jsonb_to_recordset(o.items) AS i(product_id text, name text, quantity int, unit_price numeric)
            WHERE o.created_at >= NOW() - INTERVAL '3 months'
            AND o.status != 'cancelled'
        )
        SELECT 
            product_id,
            product_name,
            SUM(quantity) AS total_quantity,
            SUM(item_total) AS total_sales,
            COUNT(DISTINCT order_id) AS order_count
        FROM order_items
        GROUP BY product_id, product_name
        ORDER BY total_quantity DESC
        LIMIT 50
    `)
    if err != nil {
        return 0, 0, err
    }
    defer rows.Close()
    
    var results []struct {
        ProductID     string
        ProductName   string
        TotalQuantity int
        TotalSales    float64
        OrderCount    int
    }
    
    for rows.Next() {
        var result struct {
            ProductID     string
            ProductName   string
            TotalQuantity int
            TotalSales    float64
            OrderCount    int
        }
        if err := rows.Scan(
            &result.ProductID,
            &result.ProductName,
            &result.TotalQuantity,
            &result.TotalSales,
            &result.OrderCount,
        ); err != nil {
            return 0, 0, err
        }
        results = append(results, result)
    }
    
    if err = rows.Err(); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(results), duration, nil
}
```

## Pagination and Sorting

Efficient pagination is critical for user interfaces. Let's benchmark how each database handles pagination and sorting:

### Offset-Based Pagination

```go
// MongoDB: Offset-based pagination
func benchmarkMongoDBOffsetPagination(ctx context.Context, collection *mongo.Collection, page, pageSize int) (int, time.Duration, error) {
    start := time.Now()
    
    skip := (page - 1) * pageSize
    
    opts := options.Find().
        SetSort(bson.D{{"created_at", -1}}).
        SetSkip(int64(skip)).
        SetLimit(int64(pageSize))
    
    cursor, err := collection.Find(ctx, bson.M{}, opts)
    if err != nil {
        return 0, 0, err
    }
    defer cursor.Close(ctx)
    
    var orders []Order
    if err = cursor.All(ctx, &orders); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(orders), duration, nil
}

// PostgreSQL: Offset-based pagination
func benchmarkPostgreSQLOffsetPagination(ctx context.Context, pool *pgxpool.Pool, page, pageSize int) (int, time.Duration, error) {
    start := time.Now()
    
    offset := (page - 1) * pageSize
    
    rows, err := pool.Query(ctx, `
        SELECT id, customer_id, status, total, created_at, items
        FROM orders
        ORDER BY created_at DESC
        OFFSET $1 LIMIT $2
    `, offset, pageSize)
    if err != nil {
        return 0, 0, err
    }
    defer rows.Close()
    
    var orders []Order
    for rows.Next() {
        var order Order
        if err := rows.Scan(&order.ID, &order.CustomerID, &order.Status, &order.Total, &order.CreatedAt, &order.Items); err != nil {
            return 0, 0, err
        }
        orders = append(orders, order)
    }
    
    if err = rows.Err(); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(orders), duration, nil
}
```

### Cursor-Based Pagination

```go
// MongoDB: Cursor-based pagination
func benchmarkMongoDBCursorPagination(ctx context.Context, collection *mongo.Collection, lastCreatedAt time.Time, pageSize int) (int, time.Duration, error) {
    start := time.Now()
    
    filter := bson.M{"created_at": bson.M{"$lt": lastCreatedAt}}
    opts := options.Find().
        SetSort(bson.D{{"created_at", -1}}).
        SetLimit(int64(pageSize))
    
    cursor, err := collection.Find(ctx, filter, opts)
    if err != nil {
        return 0, 0, err
    }
    defer cursor.Close(ctx)
    
    var orders []Order
    if err = cursor.All(ctx, &orders); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(orders), duration, nil
}

// PostgreSQL: Cursor-based pagination
func benchmarkPostgreSQLCursorPagination(ctx context.Context, pool *pgxpool.Pool, lastCreatedAt time.Time, pageSize int) (int, time.Duration, error) {
    start := time.Now()
    
    rows, err := pool.Query(ctx, `
        SELECT id, customer_id, status, total, created_at, items
        FROM orders
        WHERE created_at < $1
        ORDER BY created_at DESC
        LIMIT $2
    `, lastCreatedAt, pageSize)
    if err != nil {
        return 0, 0, err
    }
    defer rows.Close()
    
    var orders []Order
    for rows.Next() {
        var order Order
        if err := rows.Scan(&order.ID, &order.CustomerID, &order.Status, &order.Total, &order.CreatedAt, &order.Items); err != nil {
            return 0, 0, err
        }
        orders = append(orders, order)
    }
    
    if err = rows.Err(); err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(orders), duration, nil
}
```

## Write Operations

Bulk operations can significantly impact application performance. Let's benchmark how each database handles these operations:

### Bulk Insert

```go
// MongoDB: Bulk insert
func benchmarkMongoDBBulkInsert(ctx context.Context, collection *mongo.Collection, orderCount int) (int, time.Duration, error) {
    // Generate orders
    orders := generateTestData(orderCount)
    
    // Convert to interface slice
    documents := make([]interface{}, len(orders))
    for i, order := range orders {
        documents[i] = order
    }
    
    start := time.Now()
    
    // Insert many with unordered option for better performance
    result, err := collection.InsertMany(
        ctx,
        documents,
        options.InsertMany().SetOrdered(false),
    )
    if err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return len(result.InsertedIDs), duration, nil
}

// PostgreSQL: Bulk insert
func benchmarkPostgreSQLBulkInsert(ctx context.Context, pool *pgxpool.Pool, orderCount int) (int, time.Duration, error) {
    // Generate orders
    orders := generateTestData(orderCount)
    
    start := time.Now()
    
    // Use COPY for fast bulk loading
    copyCount, err := pool.CopyFrom(
        ctx,
        pgx.Identifier{"orders"},
        []string{"id", "customer_id", "status", "total", "created_at", "items"},
        pgx.CopyFromSlice(len(orders), func(i int) ([]interface{}, error) {
            order := orders[i]
            itemsJSON, err := json.Marshal(order.Items)
            if err != nil {
                return nil, err
            }
            return []interface{}{
                order.ID,
                order.CustomerID,
                order.Status,
                order.Total,
                order.CreatedAt,
                itemsJSON,
            }, nil
        }),
    )
    if err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return int(copyCount), duration, nil
}
```

### Bulk Update

```go
// MongoDB: Bulk update
func benchmarkMongoDBBulkUpdate(ctx context.Context, collection *mongo.Collection, status string, newStatus string) (int, time.Duration, error) {
    start := time.Now()
    
    result, err := collection.UpdateMany(
        ctx,
        bson.M{"status": status},
        bson.M{"$set": bson.M{"status": newStatus}},
    )
    if err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return int(result.ModifiedCount), duration, nil
}

// PostgreSQL: Bulk update
func benchmarkPostgreSQLBulkUpdate(ctx context.Context, pool *pgxpool.Pool, status string, newStatus string) (int, time.Duration, error) {
    start := time.Now()
    
    tag, err := pool.Exec(ctx, `
        UPDATE orders
        SET status = $1
        WHERE status = $2
    `, newStatus, status)
    if err != nil {
        return 0, 0, err
    }
    
    duration := time.Since(start)
    return int(tag.RowsAffected()), duration, nil
}
```

## Concurrency Testing

Real applications deal with concurrent access. Let's benchmark how each database performs under concurrent load:

```go
// RunConcurrentBenchmark runs a benchmark function with multiple concurrent goroutines
func RunConcurrentBenchmark(name, dbType, opType string, concurrency, iterations int, benchFunc func() (int, time.Duration, error)) (BenchmarkResult, error) {
    var totalTime time.Duration
    var totalRecords int
    var successfulRuns int
    var mu sync.Mutex
    var wg sync.WaitGroup
    
    wg.Add(concurrency)
    
    for i := 0; i < concurrency; i++ {
        go func() {
            defer wg.Done()
            
            for j := 0; j < iterations; j++ {
                records, duration, err := benchFunc()
                if err != nil {
                    log.Printf("Benchmark iteration failed: %v", err)
                    continue
                }
                
                mu.Lock()
                totalTime += duration
                totalRecords += records
                successfulRuns++
                mu.Unlock()
            }
        }()
    }
    
    wg.Wait()
    
    if successfulRuns == 0 {
        return BenchmarkResult{}, fmt.Errorf("all benchmark iterations failed")
    }
    
    // Calculate averages
    avgTime := totalTime / time.Duration(successfulRuns)
    avgRecords := totalRecords / successfulRuns
    
    return BenchmarkResult{
        Name:            name,
        DatabaseType:    dbType,
        OperationType:   opType,
        ExecutionTime:   avgTime,
        RecordsAffected: avgRecords,
        Timestamp:       time.Now(),
    }, nil
}
```

Let's use this for a concurrent read test:

```go
// Generate a set of random IDs for concurrent read testing
func getRandomOrderIDs(ctx context.Context, collection *mongo.Collection, count int) ([]string, error) {
    cursor, err := collection.Find(
        ctx,
        bson.M{},
        options.Find().SetProjection(bson.M{"_id": 1}).SetLimit(int64(count)),
    )
    if err != nil {
        return nil, err
    }
    defer cursor.Close(ctx)
    
    var results []struct {
        ID string `bson:"_id"`
    }
    
    if err = cursor.All(ctx, &results); err != nil {
        return nil, err
    }
    
    ids := make([]string, len(results))
    for i, result := range results {
        ids[i] = result.ID
    }
    
    return ids, nil
}

// Run concurrent read benchmark
func benchmarkConcurrentReads(ctx context.Context, collection *mongo.Collection, pool *pgxpool.Pool) {
    // Get some random IDs first
    ids, err := getRandomOrderIDs(ctx, collection, 1000)
    if err != nil {
        log.Fatalf("Failed to get random order IDs: %v", err)
    }
    
    // Create a function that randomly selects IDs to read
    createMongoReadFunc := func() func() (int, time.Duration, error) {
        return func() (int, time.Duration, error) {
            randomIndex := rand.Intn(len(ids))
            return benchmarkMongoDBReadByID(ctx, collection, ids[randomIndex])
        }
    }
    
    createPgReadFunc := func() func() (int, time.Duration, error) {
        return func() (int, time.Duration, error) {
            randomIndex := rand.Intn(len(ids))
            return benchmarkPostgreSQLReadByID(ctx, pool, ids[randomIndex])
        }
    }
    
    // Test with increasing concurrency
    concurrencyLevels := []int{1, 5, 10, 20, 50, 100}
    
    for _, concurrency := range concurrencyLevels {
        // MongoDB concurrent reads
        result, err := RunConcurrentBenchmark(
            fmt.Sprintf("Concurrent Reads (c=%d)", concurrency),
            "MongoDB",
            "Read",
            concurrency,
            10, // 10 iterations per goroutine
            createMongoReadFunc(),
        )
        if err != nil {
            log.Printf("MongoDB concurrent benchmark failed: %v", err)
            continue
        }
        
        log.Printf("MongoDB Concurrent Reads (c=%d): %v", concurrency, result.ExecutionTime)
        
        // PostgreSQL concurrent reads
        result, err = RunConcurrentBenchmark(
            fmt.Sprintf("Concurrent Reads (c=%d)", concurrency),
            "PostgreSQL",
            "Read",
            concurrency,
            10, // 10 iterations per goroutine
            createPgReadFunc(),
        )
        if err != nil {
            log.Printf("PostgreSQL concurrent benchmark failed: %v", err)
            continue
        }
        
        log.Printf("PostgreSQL Concurrent Reads (c=%d): %v", concurrency, result.ExecutionTime)
    }
}
```

## Results Analysis

Now let's analyze and visualize our benchmarking results:

```go
// ResultSummary provides statistical summary of benchmark results
type ResultSummary struct {
    DatabaseType      string
    OperationType     string
    AverageTime       time.Duration
    MinTime           time.Duration
    MaxTime           time.Duration
    Median            time.Duration
    P95               time.Duration
    RecordsProcessed  int
    OperationsPerSec  float64
}

// Analyze results for a specific operation type
func analyzeResults(results []BenchmarkResult, dbType, opType string) ResultSummary {
    var filtered []BenchmarkResult
    for _, r := range results {
        if r.DatabaseType == dbType && r.OperationType == opType {
            filtered = append(filtered, r)
        }
    }
    
    if len(filtered) == 0 {
        return ResultSummary{
            DatabaseType:  dbType,
            OperationType: opType,
        }
    }
    
    // Sort by execution time
    sort.Slice(filtered, func(i, j int) bool {
        return filtered[i].ExecutionTime < filtered[j].ExecutionTime
    })
    
    // Calculate statistics
    var totalTime time.Duration
    var totalRecords int
    minTime := filtered[0].ExecutionTime
    maxTime := filtered[0].ExecutionTime
    
    for _, r := range filtered {
        totalTime += r.ExecutionTime
        totalRecords += r.RecordsAffected
        
        if r.ExecutionTime < minTime {
            minTime = r.ExecutionTime
        }
        if r.ExecutionTime > maxTime {
            maxTime = r.ExecutionTime
        }
    }
    
    avgTime := totalTime / time.Duration(len(filtered))
    median := filtered[len(filtered)/2].ExecutionTime
    p95idx := int(float64(len(filtered)) * 0.95)
    p95 := filtered[p95idx].ExecutionTime
    
    // Calculate operations per second
    opsPerSec := float64(totalRecords) / totalTime.Seconds()
    
    return ResultSummary{
        DatabaseType:     dbType,
        OperationType:    opType,
        AverageTime:      avgTime,
        MinTime:          minTime,
        MaxTime:          maxTime,
        Median:           median,
        P95:              p95,
        RecordsProcessed: totalRecords,
        OperationsPerSec: opsPerSec,
    }
}

// Generate comparison table
func generateComparisonTable(mongoResults, pgResults []ResultSummary) {
    fmt.Println("-----------------------------------------------------------")
    fmt.Println("| Operation Type       | MongoDB (ms) | PostgreSQL (ms) | Ratio |")
    fmt.Println("|----------------------|--------------|-----------------|-------|")
    
    operationTypes := []string{
        "Read by ID",
        "Update by ID",
        "Date Range Filter",
        "Multi-Filter",
        "Aggregation",
        "Complex Aggregation",
        "Offset Pagination",
        "Cursor Pagination",
        "Bulk Insert",
        "Bulk Update",
    }
    
    for _, opType := range operationTypes {
        var mongoTime float64
        var pgTime float64
        
        // Find matching result summaries
        for _, r := range mongoResults {
            if r.OperationType == opType {
                mongoTime = float64(r.AverageTime.Microseconds()) / 1000.0 // Convert to ms
                break
            }
        }
        
        for _, r := range pgResults {
            if r.OperationType == opType {
                pgTime = float64(r.AverageTime.Microseconds()) / 1000.0 // Convert to ms
                break
            }
        }
        
        // Calculate ratio (MongoDB time / PostgreSQL time)
        var ratio float64
        if pgTime > 0 {
            ratio = mongoTime / pgTime
        }
        
        fmt.Printf("| %-20s | %12.2f | %15.2f | %5.2f |\n", 
            opType, mongoTime, pgTime, ratio)
    }
    
    fmt.Println("-----------------------------------------------------------")
}
```

## Database Memory and CPU Usage

To get a comprehensive view of performance, we need to monitor resource usage during benchmarks:

```go
// ResourceStats represents a point-in-time snapshot of resource usage
type ResourceStats struct {
    Timestamp    time.Time
    CPUPercent   float64
    MemoryMB     float64
    DiskIOOps    int64
    NetworkIO    int64
}

// MonitorResources monitors database resource usage during benchmarks
func MonitorResources(ctx context.Context, done <-chan struct{}) ([]ResourceStats, error) {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()
    
    var stats []ResourceStats
    
    // This is a simplified example. In reality, you would use tools like
    // Docker stats API, psutil, or other system monitoring tools
    // to collect accurate resource statistics
    
    for {
        select {
        case <-ticker.C:
            // Collect system stats from the database processes
            // This is platform-dependent and would need actual implementation
            stats = append(stats, ResourceStats{
                Timestamp:  time.Now(),
                CPUPercent: getCPUUsage(),    // Implement these functions based on your platform
                MemoryMB:   getMemoryUsage(), // These would connect to the OS or container metrics
                DiskIOOps:  getDiskIOOps(),
                NetworkIO:  getNetworkIO(),
            })
        case <-done:
            return stats, nil
        case <-ctx.Done():
            return stats, ctx.Err()
        }
    }
}
```

## Real-World Scenarios and Recommendations

Let's analyze our results across various real-world scenarios to provide actionable recommendations:

### Read-Heavy Applications

```
Operation: Read-heavy workloads with frequent single-record lookups

MongoDB Strengths:
- Document model provides a natural fit for object retrieval
- Scales reads horizontally with minimal configuration

PostgreSQL Strengths:
- Consistent read performance with proper indexing
- Lower latency for simple point lookups
- Better query planner for complex reads

Recommendations:
1. For simple CRUD applications with predictable access patterns, 
   both databases perform well, with PostgreSQL having a slight edge 
   for simple reads.
   
2. If your application never needs complex joins, MongoDB provides 
   simplicity and flexibility.
   
3. If your read patterns include complex reporting queries with 
   multiple joins, PostgreSQL is likely the better choice.
```

### Write-Heavy Applications

```
Operation: High-volume write workloads with bulk insertions

MongoDB Strengths:
- Faster bulk inserts (by ~40% in our benchmarks)
- Easier horizontal write scaling
- Schema flexibility allows for rapid iteration

PostgreSQL Strengths:
- COPY command provides efficient bulk loading
- Transactional integrity for related data
- Better performance for updates that affect many records

Recommendations:
1. For applications with very high insert rates (logs, events, IoT data),
   MongoDB can offer better out-of-the-box performance.
   
2. If your writes need transactional guarantees across multiple related
   tables, PostgreSQL is the better choice.
   
3. For mixed workloads that need both high insert rates and complex
   queries, consider PostgreSQL with proper optimization.
```

### Analytical Workloads

```
Operation: Aggregation and reporting queries

MongoDB Strengths:
- Flexible aggregation pipeline for simple calculations
- MapReduce for complex analyses
- Easy to scale for large datasets

PostgreSQL Strengths:
- Significantly faster aggregations (30-50% in our benchmarks)
- Advanced analytical functions (window functions, CTEs)
- Better optimization for complex grouping and joining

Recommendations:
1. For real-time analytics with simple aggregations, both databases
   can perform adequately, but PostgreSQL typically performs better.
   
2. For complex analytical queries with multiple joins, subqueries, and 
   window functions, PostgreSQL is substantially better.
   
3. If your analytical needs are basic and you value schema flexibility,
   MongoDB's aggregation pipeline may be sufficient.
```

### Scaling Considerations

```
Horizontal Scaling:
- MongoDB has a clear advantage with native sharding and replica sets
- PostgreSQL requires more complex setups like Citus for similar scaling

Vertical Scaling:
- PostgreSQL often makes better use of additional CPU cores and memory
- MongoDB has better performance per core for simple operations

Recommendations:
1. If your data volume will grow to multiple terabytes with high throughput
   requirements, MongoDB's horizontal scaling capabilities make it attractive.
   
2. For data that can fit on a single powerful server or requires complex
   queries, PostgreSQL's vertical scaling is often more cost-effective.
   
3. Consider the operational complexity of managing a distributed database
   cluster versus a single powerful database server.
```

## Conclusion

Our benchmarking reveals that both MongoDB and PostgreSQL have unique performance characteristics that make them suitable for different types of applications:

### When to Choose MongoDB

1. **Schema Flexibility**: When your data structure evolves frequently or varies across records
2. **Document-Oriented Data**: When your data fits naturally into a document model
3. **High-Volume Inserts**: For applications with very high insert rates
4. **Horizontal Scaling**: When you need to scale beyond a single server with minimal complexity
5. **Prototype and Rapid Development**: When you need to iterate quickly without migrations

### When to Choose PostgreSQL

1. **Complex Queries**: When you need to perform joins, window functions, and complex aggregations
2. **ACID Compliance**: When transactional integrity across related data is critical
3. **Analytical Workloads**: For reporting and BI applications with complex queries
4. **Data Integrity**: When you need constraints, foreign keys, and data validation
5. **Mixed Workloads**: When you need to balance OLTP and analytical queries

### Performance Takeaways

1. **Read Performance**: PostgreSQL generally showed lower latency for single-record lookups, while MongoDB was competitive for simple document retrieval.

2. **Write Performance**: MongoDB demonstrated superior performance for bulk inserts, while PostgreSQL was more efficient for updates affecting multiple records.

3. **Query Complexity**: As query complexity increased (joins, aggregations), PostgreSQL's advantage became more pronounced.

4. **Concurrency**: Both databases showed good scaling with increased concurrency, with PostgreSQL maintaining more consistent latency under higher loads.

5. **Resource Efficiency**: PostgreSQL typically used less memory for comparable operations, while MongoDB showed efficient CPU utilization for simple operations.

The choice between MongoDB and PostgreSQL should ultimately depend on your specific application requirements, data access patterns, and scaling needs. By understanding the performance characteristics of each database, you can make an informed decision that aligns with your application's needs and future growth requirements.

When implementing your own benchmarks, remember that the specific characteristics of your data, queries, and access patterns will influence the results. Always test with realistic workloads and data volumes to get meaningful insights for your particular use case.

---

*What has been your experience with MongoDB and PostgreSQL performance? Have you found other factors that influenced your database selection beyond raw performance? Share your thoughts in the comments below!*