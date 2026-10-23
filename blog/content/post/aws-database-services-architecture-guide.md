---
title: "ElastiCache Redis Replication Group and RDS Proxy Limits"
date: 2025-09-04T09:00:00-05:00
lastmod: 2026-10-23T00:00:00-05:00
description: "Terraform for an ElastiCache replication group (num_cache_clusters explained), RDS Proxy connection limits and the MaxDatabaseConnectionsAllowed metric, with RDS."
author: "Matthew Mattox - mmattox@support.tools"
draft: false
categories: ["AWS", "Databases", "Cloud"]
tags: ["AWS", "RDS", "RDS Proxy", "Redis", "ElastiCache", "Performance Optimization", "Database Architecture", "Scalability", "High Availability", "Connection Pooling"]
---

# ElastiCache Redis Replication Group and RDS Proxy Limits

Two settings cause most of the confusion when you put ElastiCache in front of RDS and RDS Proxy between the application and the database: `num_cache_clusters` on the ElastiCache replication group, and the connection ceiling RDS Proxy reports as `MaxDatabaseConnectionsAllowed`. This page answers both, then shows the full RDS, RDS Proxy and ElastiCache architecture in Terraform.

## Quick answer

**`num_cache_clusters` in `aws_elasticache_replication_group`** is the total number of nodes (one primary plus read replicas) in a replication group with cluster mode disabled. `num_cache_clusters = 3` means one primary and two replicas. It must be at least 2 when `automatic_failover_enabled` or `multi_az_enabled` is true, defaults to 1, and conflicts with `num_node_groups` and `replicas_per_node_group`, which you use instead for cluster mode enabled (sharded) groups.

```hcl
# Cluster mode disabled: 1 primary + 2 replicas
resource "aws_elasticache_replication_group" "cache" {
  replication_group_id       = "app-cache"
  description                = "App cache"
  engine                     = "redis"            # or "valkey"
  node_type                  = "cache.r7g.large"
  num_cache_clusters         = 3
  automatic_failover_enabled = true
  multi_az_enabled           = true
}

# Cluster mode enabled: 2 shards, each with 1 primary + 1 replica
resource "aws_elasticache_replication_group" "sharded" {
  replication_group_id       = "app-cache-sharded"
  description                = "Sharded app cache"
  engine                     = "redis"
  node_type                  = "cache.r7g.large"
  num_node_groups            = 2
  replicas_per_node_group    = 1
  automatic_failover_enabled = true
}
```

ElastiCache also offers Valkey, the open source fork of Redis, as an engine; it uses the same Redis protocol and clients.

**RDS Proxy `MaxDatabaseConnectionsAllowed`** is a CloudWatch metric (namespace `AWS/RDS`, reported every minute) for the maximum number of database connections the proxy may open. It follows from the target group's `max_connections_percent` applied to the database's `max_connections`. If `DatabaseConnections` sits at `MaxDatabaseConnectionsAllowed` and `DatabaseConnectionsBorrowLatency` climbs, clients are queuing for a pooled connection: raise `max_connections_percent`, raise `max_connections` on the database (or move to a larger instance class), or find what is pinning sessions with `DatabaseConnectionsCurrentlySessionPinned`.

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name MaxDatabaseConnectionsAllowed \
  --dimensions Name=ProxyName,Value=app-db-proxy \
  --statistics Sum --period 60 \
  --start-time "$(date -u -d '-1 hour' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)"
```

Use `Sum` for these metrics: a proxy can run on several instances and each publishes its own values.

Related guides on this site:

- [Aurora MySQL blue/green deployments and rollback](/post/aurora-mysql-blue-green-deployment-rollback-strategy/) for upgrading the database behind the proxy.
- [Rising costs of legacy Amazon RDS](/legacy-rds-cost-analysis/) for extended support charges on old engine versions.
- [Redis is open source again](/redis-open-source-again/) for the Redis and Valkey licensing background.

## Introduction to AWS Database Services

AWS provides specialized database services to handle different aspects of data management:

1. **Amazon RDS**: Managed relational database service supporting various engines (MySQL, PostgreSQL, SQL Server, etc.)
2. **Amazon RDS Proxy**: Connection pooling service that sits between applications and RDS instances
3. **Amazon ElastiCache for Redis**: In-memory caching service for high-performance data access

Let's explore how these services work together to create a high-performance, scalable database architecture.

## Amazon RDS: Core Database Foundation

Amazon RDS provides managed relational databases with automated administrative tasks like backups, patch management, and scaling. It offers several advantages over self-managed databases:

### Key RDS Features

- **Multi-AZ Deployments**: Automatic failover to a standby instance in a different Availability Zone for high availability
- **Read Replicas**: Scale read capacity by creating read-only copies of your database
- **Automated Backups**: Point-in-time recovery with automated backups
- **Security**: Network isolation using VPC, encryption at rest, and IAM integration

### Sample RDS Configuration (Terraform)

```hcl
resource "aws_db_instance" "primary" {
  identifier             = "app-primary-db"
  engine                 = "postgres"
  engine_version         = "17"
  instance_class         = "db.r6g.large"
  allocated_storage      = 100
  max_allocated_storage  = 1000
  storage_type           = "gp3"
  storage_encrypted      = true
  
  # High availability configuration
  multi_az               = true
  backup_retention_period = 7
  backup_window          = "03:00-04:00"
  maintenance_window     = "sun:04:30-sun:05:30"
  
  # Performance settings
  performance_insights_enabled = true
  monitoring_interval    = 60
  
  # Network & security
  db_subnet_group_name   = aws_db_subnet_group.primary.name
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  
  # Database parameters
  username               = "dbadmin"
  password               = var.db_password
  parameter_group_name   = aws_db_parameter_group.postgres17.name
  
  deletion_protection    = true
  skip_final_snapshot    = false
  final_snapshot_identifier = "app-primary-final-snapshot"
}

# Create read replicas for handling read traffic
resource "aws_db_instance" "read_replica" {
  count                  = 2
  identifier             = "app-read-replica-${count.index}"
  replicate_source_db    = aws_db_instance.primary.identifier
  instance_class         = "db.r6g.large"
  publicly_accessible    = false
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  parameter_group_name   = aws_db_parameter_group.postgres17_readonly.name
  
  # Performance insights for monitoring read replica performance
  performance_insights_enabled = true
  monitoring_interval    = 60
  
  skip_final_snapshot    = true
}
```

This configuration establishes a robust PostgreSQL database with Multi-AZ deployment for high availability, automatic storage scaling, and two read replicas for scalable read operations.

## Amazon RDS Proxy: Intelligent Connection Management

RDS Proxy solves a critical challenge in database management: connection handling. It maintains a pool of database connections and serves as an intermediary between your application and the database.

### Key Benefits of RDS Proxy

1. **Connection Pooling**: Reduces the number of connections to the database, improving efficiency
2. **Failover Acceleration**: Reduces failover time by up to 66% and preserves application connections
3. **Credential Management**: Integrates with AWS Secrets Manager for secure credential rotation
4. **Reduced Database Load**: Offloads connection management from the database engine

### When to Use RDS Proxy

- Applications with frequent short-lived connections
- Serverless architectures (Lambda functions) connecting to RDS
- Multi-tenant applications with many simultaneous connections
- Applications needing improved failover resilience

### Sample RDS Proxy Configuration (Terraform)

```hcl
# Create a Secrets Manager secret for database credentials
resource "aws_secretsmanager_secret" "db_credentials" {
  name = "app-db-credentials"
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id     = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    username = "dbadmin",
    password = var.db_password
  })
}

# Create the RDS Proxy
resource "aws_db_proxy" "primary" {
  name                   = "app-db-proxy"
  engine_family          = "POSTGRESQL"
  idle_client_timeout    = 1800
  debug_logging          = false
  vpc_security_group_ids = [aws_security_group.proxy_sg.id]
  vpc_subnet_ids         = aws_db_subnet_group.primary.subnet_ids
  
  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db_credentials.arn
  }
  
  tags = {
    Environment = "production"
  }
}

# Associate the proxy with the RDS instance
resource "aws_db_proxy_default_target_group" "primary" {
  db_proxy_name = aws_db_proxy.primary.name
  
  connection_pool_config {
    max_connections_percent      = 100
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "primary" {
  db_proxy_name          = aws_db_proxy.primary.name
  target_group_name      = aws_db_proxy_default_target_group.primary.name
  db_instance_identifier = aws_db_instance.primary.id
}
```

This configuration creates an RDS Proxy for the PostgreSQL database with secure credential management through AWS Secrets Manager and optimal connection pool settings.

## Amazon ElastiCache for Redis: In-Memory Performance

ElastiCache for Redis provides blazing-fast in-memory data storage and retrieval, significantly reducing database load for frequently accessed data.

### Strategic Uses for Redis

1. **Caching Layer**: Store frequently accessed database query results
2. **Session Store**: Maintain user session data
3. **Real-time Analytics**: Process and store real-time metrics
4. **Task Queues**: Implement reliable work queues for background processing
5. **Pub/Sub Messaging**: Enable real-time communication between application components

### Sample ElastiCache for Redis Configuration (Terraform)

```hcl
resource "aws_elasticache_replication_group" "redis_cluster" {
  replication_group_id        = "app-redis-cluster"
  description                 = "Redis cluster for application caching"
  node_type                   = "cache.r6g.large"
  port                        = 6379
  
  # High availability configuration
  num_cache_clusters          = 3
  automatic_failover_enabled  = true
  multi_az_enabled            = true
  
  # Performance and security
  at_rest_encryption_enabled  = true
  transit_encryption_enabled  = true
  auth_token                  = var.redis_auth_token
  
  # Maintenance
  maintenance_window          = "sun:05:00-sun:06:00"
  snapshot_retention_limit    = 7
  snapshot_window             = "00:00-01:00"
  
  # Network
  subnet_group_name           = aws_elasticache_subnet_group.redis.name
  security_group_ids          = [aws_security_group.redis_sg.id]
  
  parameter_group_name        = aws_elasticache_parameter_group.redis_params.name
  
  tags = {
    Environment = "production"
  }
}
```

This configuration establishes a Redis cluster with three nodes across multiple Availability Zones for high availability, with encryption and scheduled maintenance.

## Integrated Architecture: RDS + RDS Proxy + Redis

Now let's examine how these three services can be combined to create a high-performance, scalable database architecture:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Application    │────▶│   ElastiCache   │     │   RDS Proxy     │
│  (ECS/EKS/EC2)  │     │   (Redis)       │     │                 │
│                 │     │                 │     │                 │
└────────┬────────┘     └─────────────────┘     └────────┬────────┘
         │                      ▲                        │
         │                      │                        │
         │                      │                        ▼
         │               ┌──────┴───────┐      ┌─────────────────┐
         │               │              │      │                 │
         └──────────────▶│  Cache       │      │   RDS Primary   │
                         │  Miss        │      │   Instance      │
                         │              │      │                 │
                         └──────────────┘      └────────┬────────┘
                                                        │
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │                 │
                                               │   RDS Read      │
                                               │   Replicas      │
                                               │                 │
                                               └─────────────────┘
```

### How the Components Work Together

1. **Initial Data Request Flow**:
   - Application first checks Redis cache for data
   - If data exists (cache hit), it's returned immediately
   - If data doesn't exist (cache miss), request continues to database

2. **Database Connection Handling**:
   - Application connects to RDS Proxy instead of directly to RDS
   - RDS Proxy maintains a pool of connections to the database
   - For read-heavy operations, RDS Proxy can route to read replicas
   - For write operations, requests go to the primary instance

3. **Data Storage Strategy**:
   - **Redis**: Stores frequently accessed data, session information, and real-time analytics
   - **RDS**: Stores all persistent data with ACID compliance

4. **Performance Optimization**:
   - Use Redis for data that's read frequently but updated infrequently
   - Implement write-through or write-behind caching strategies
   - Configure appropriate TTL (Time-To-Live) for cached data

### Example Application Code (Node.js)

```javascript
const { Client } = require('pg');
const Redis = require('ioredis');
const AWS = require('aws-sdk');

// Initialize Redis client
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  password: process.env.REDIS_AUTH_TOKEN,
  tls: {}
});

// Database connection via RDS Proxy
async function getDbConnection() {
  // Get database credentials from Secrets Manager
  const secretsManager = new AWS.SecretsManager();
  const secretData = await secretsManager.getSecretValue({
    SecretId: process.env.DB_SECRET_ARN
  }).promise();
  
  const { username, password } = JSON.parse(secretData.SecretString);
  
  // Connect to database via RDS Proxy
  const client = new Client({
    host: process.env.DB_PROXY_ENDPOINT,
    port: 5432,
    database: 'app_database',
    user: username,
    password: password,
    ssl: {
      rejectUnauthorized: true,
    }
  });
  
  await client.connect();
  return client;
}

// Example function to get user data with caching
async function getUserData(userId) {
  // First try to get data from Redis
  const cacheKey = `user:${userId}`;
  const cachedData = await redis.get(cacheKey);
  
  if (cachedData) {
    console.log('Cache hit - returning data from Redis');
    return JSON.parse(cachedData);
  }
  
  console.log('Cache miss - retrieving from database');
  
  // Cache miss, get from database
  const dbClient = await getDbConnection();
  try {
    const result = await dbClient.query('SELECT * FROM users WHERE id = $1', [userId]);
    const userData = result.rows[0];
    
    if (userData) {
      // Store in cache for future requests with 10-minute TTL
      await redis.set(cacheKey, JSON.stringify(userData), 'EX', 600);
    }
    
    return userData;
  } finally {
    // Always release the client back to the pool
    dbClient.release();
  }
}

// Example function for write operations
async function updateUserData(userId, userData) {
  const dbClient = await getDbConnection();
  try {
    // Start a transaction
    await dbClient.query('BEGIN');
    
    // Update the database
    await dbClient.query(
      'UPDATE users SET name = $1, email = $2, updated_at = NOW() WHERE id = $3',
      [userData.name, userData.email, userId]
    );
    
    // Commit the transaction
    await dbClient.query('COMMIT');
    
    // Invalidate the cache
    const cacheKey = `user:${userId}`;
    await redis.del(cacheKey);
    
    return { success: true };
  } catch (err) {
    // Rollback on error
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    // Always release the client back to the pool
    dbClient.release();
  }
}
```

This example demonstrates a pattern for integrating Redis caching with RDS via RDS Proxy, including:

- Secure credential handling with AWS Secrets Manager
- Connection pooling via RDS Proxy
- Proper cache invalidation on data updates
- Error handling and transaction management

## Advanced Topics and Best Practices

### 1. Multi-Region Resilience

For applications requiring global resilience, consider implementing:

- Cross-region read replicas for RDS
- Global Datastore for ElastiCache Redis
- Application-level logic to route to appropriate regional endpoints

### 2. Cache Optimization Strategies

- **Cache-Aside (Lazy Loading)**: Load data into the cache only when necessary
- **Write-Through**: Update the cache whenever writing to the database
- **Write-Behind (Write-Back)**: Asynchronously write cached data to the database
- **Time-To-Live (TTL)**: Set appropriate expiration times based on data volatility

### 3. Connection Management Best Practices

- Configure application connection pools to work effectively with RDS Proxy
- Implement exponential backoff for connection retries
- Monitor connection usage and adjust RDS Proxy settings accordingly

### 4. Security Considerations

- Use IAM authentication for RDS and RDS Proxy when possible
- Rotate credentials regularly using AWS Secrets Manager
- Implement network segmentation with security groups
- Enable encryption in transit and at rest for all services

### 5. Monitoring and Alerting

Key metrics to monitor:

**RDS Metrics**:
- CPU Utilization
- FreeableMemory
- DatabaseConnections
- ReadIOPS/WriteIOPS
- ReadLatency/WriteLatency

**RDS Proxy Metrics**:
- ClientConnections/DatabaseConnections
- QueryRequests
- MaxDatabaseConnectionsAllowed
- AvailabilityPercentage

**ElastiCache Metrics**:
- CPUUtilization
- NetworkBytesIn/NetworkBytesOut
- CacheHits/CacheMisses
- Evictions
- CurrConnections

### 6. Cost Optimization

- Right-size instances based on workload patterns
- Use reserved instances for predictable workloads
- Implement auto-scaling for variable workloads
- Consider serverless options (Aurora Serverless) for intermittent usage

## Conclusion

A well-architected AWS database solution combining RDS, RDS Proxy, and ElastiCache for Redis provides a foundation for building high-performance, scalable, and reliable applications. This integrated approach addresses the key challenges of modern database management:

- **Performance**: Redis caching and connection pooling reduce latency
- **Scalability**: Read replicas and caching distribute load efficiently
- **Reliability**: Multi-AZ deployments and automated failover ensure high availability
- **Security**: Integrated IAM, encryption, and credential management protect data
- **Cost-Efficiency**: Right-sized resources and reduced database load lower costs

By following the patterns and best practices outlined in this guide, you can implement a database architecture that meets the demands of modern applications while minimizing operational overhead.

## Additional Resources

- [Amazon RDS Documentation](https://docs.aws.amazon.com/rds/)
- [Amazon RDS Proxy Documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- [Amazon ElastiCache for Redis Documentation](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/)
- [AWS Database Blog](https://aws.amazon.com/blogs/database/)
- [AWS Solutions Architectures](https://aws.amazon.com/architecture/)