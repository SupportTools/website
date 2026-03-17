---
title: "PostgreSQL Partitioning in Production: Range, List, and Hash Partition Strategies"
date: 2029-03-16T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "Database", "Partitioning", "Performance", "Production", "SQL"]
categories:
- Database
- PostgreSQL
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to PostgreSQL declarative table partitioning covering range, list, and hash strategies, partition pruning, constraint exclusion, index management, maintenance automation, and partition-related query optimization."
more_link: "yes"
url: "/postgresql-partitioning-production-range-list-hash/"
---

PostgreSQL declarative partitioning, introduced in version 10 and significantly improved through versions 11-16, allows large tables to be divided into smaller physical partitions while maintaining a unified logical view. Partitioning improves query performance through partition pruning (scanning only relevant partitions), simplifies data lifecycle management (dropping old partitions instead of running expensive DELETE operations), and improves maintenance operations (VACUUM and CREATE INDEX operate on individual partitions in parallel). This guide covers the three partitioning strategies, their operational tradeoffs, and the production patterns needed to manage partitioned tables at scale.

<!--more-->

## Partitioning Fundamentals

PostgreSQL partitioning divides a parent table into child partitions. The parent table holds no data; all rows are stored in the partitions. The partition key determines which partition receives each row.

### When to Partition

Partitioning provides benefits when:

- The table has well-defined access patterns that align with a partition key (e.g., queries almost always filter by date range)
- The table is large enough that full table scans are expensive (typically >100M rows or >100GB)
- Data lifecycle management is needed (archive or drop old data regularly)
- VACUUM performance is a concern (large tables accumulate bloat faster)

Partitioning adds overhead when:
- Queries frequently need all partitions (full scans become more expensive)
- The partition key has very high cardinality and queries span many partitions
- The application frequently inserts into non-current partitions (defeats partition pruning)

## Range Partitioning

Range partitioning assigns rows to partitions based on a range of values. It is the most common strategy for time-series data.

### Creating a Range-Partitioned Table

```sql
-- Parent table: orders partitioned by created_at month
CREATE TABLE orders (
    id            BIGSERIAL    NOT NULL,
    customer_id   BIGINT       NOT NULL,
    amount        NUMERIC(12,2) NOT NULL,
    status        TEXT         NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    metadata      JSONB
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for 2029
CREATE TABLE orders_2029_01
    PARTITION OF orders
    FOR VALUES FROM ('2029-01-01') TO ('2029-02-01');

CREATE TABLE orders_2029_02
    PARTITION OF orders
    FOR VALUES FROM ('2029-02-01') TO ('2029-03-01');

CREATE TABLE orders_2029_03
    PARTITION OF orders
    FOR VALUES FROM ('2029-03-01') TO ('2029-04-01');

-- Default partition catches rows that don't fit any defined range
CREATE TABLE orders_default
    PARTITION OF orders
    DEFAULT;

-- Verify partition structure
SELECT
    parent.relname AS parent_table,
    child.relname  AS partition_name,
    pg_get_expr(child.relpartbound, child.oid) AS partition_bounds
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
WHERE parent.relname = 'orders'
ORDER BY child.relname;
```

### Primary Key on Range-Partitioned Tables

```sql
-- The partition key must be part of the primary key constraint
ALTER TABLE orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id, created_at);

-- Unique constraints must also include the partition key
ALTER TABLE orders
    ADD CONSTRAINT orders_customer_created_unique
    UNIQUE (customer_id, created_at);
```

This restriction exists because PostgreSQL enforces uniqueness within individual partitions, not globally. For globally unique identifiers without including `created_at`, use a separate lookup table or UUID generation with application-level uniqueness enforcement.

### Partition-Aware Indexes

Indexes created on the parent table are automatically created on each partition:

```sql
-- Index on the parent propagates to all partitions
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX orders_status_created_idx ON orders (status, created_at);
CREATE INDEX orders_metadata_gin_idx ON orders USING GIN (metadata);

-- Verify indexes on a specific partition
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'orders_2029_03'
ORDER BY indexname;
```

### Partition Pruning in Action

```sql
-- Query with partition key in WHERE clause: scans only the March 2029 partition
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, customer_id, amount
FROM orders
WHERE created_at >= '2029-03-01'
  AND created_at < '2029-04-01'
  AND status = 'completed';
```

Expected output with pruning:
```
Append  (cost=0.15..8.30 rows=10 width=32)
  ->  Index Scan using orders_2029_03_pkey on orders_2029_03
        Index Cond: ((created_at >= '2029-03-01 00:00:00+00') AND (created_at < '2029-04-01 00:00:00+00'))
        Filter: (status = 'completed')
Partitions selected: 1 (out of 4)
```

Without the `created_at` filter, all partitions are scanned. Partition pruning is only effective when the partition key appears in the query's `WHERE` clause with literal values or stable function results.

## List Partitioning

List partitioning assigns rows to partitions based on explicit lists of discrete values. It works well for enumerated partition keys like region, country, tenant, or status.

```sql
-- Regional orders table partitioned by region code
CREATE TABLE regional_events (
    id         BIGSERIAL    NOT NULL,
    region     TEXT         NOT NULL,
    event_type TEXT         NOT NULL,
    payload    JSONB        NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
) PARTITION BY LIST (region);

CREATE TABLE regional_events_us_east
    PARTITION OF regional_events
    FOR VALUES IN ('us-east-1', 'us-east-2');

CREATE TABLE regional_events_us_west
    PARTITION OF regional_events
    FOR VALUES IN ('us-west-1', 'us-west-2');

CREATE TABLE regional_events_eu
    PARTITION OF regional_events
    FOR VALUES IN ('eu-west-1', 'eu-central-1', 'eu-north-1');

CREATE TABLE regional_events_apac
    PARTITION OF regional_events
    FOR VALUES IN ('ap-southeast-1', 'ap-northeast-1', 'ap-south-1');

CREATE TABLE regional_events_default
    PARTITION OF regional_events
    DEFAULT;

-- Composite list partitioning: sub-partition by event type within each region
-- (PostgreSQL supports up to 2 levels of sub-partitioning natively)
CREATE TABLE regional_events_us_east_orders
    PARTITION OF regional_events_us_east
    FOR VALUES IN ('order.created', 'order.updated', 'order.cancelled');
```

### List Partition Management

```sql
-- Add a new region without downtime
CREATE TABLE regional_events_me
    PARTITION OF regional_events
    FOR VALUES IN ('me-south-1', 'me-central-1');

-- Detach a partition for archival (does not delete data)
ALTER TABLE regional_events
    DETACH PARTITION regional_events_eu;

-- regional_events_eu is now a standalone table with all EU data intact
-- Attach an existing table as a partition
ALTER TABLE regional_events
    ATTACH PARTITION regional_events_eu
    FOR VALUES IN ('eu-west-1', 'eu-central-1', 'eu-north-1');
```

## Hash Partitioning

Hash partitioning distributes rows evenly across a fixed number of partitions using a hash of the partition key. It is appropriate when:
- No natural time-based or categorical partition key exists
- Even data distribution is required
- Queries do not benefit from partition pruning (but the goal is parallel I/O)

```sql
-- Audit log table: partition by user_id hash for even distribution
CREATE TABLE audit_log (
    id         BIGSERIAL    NOT NULL,
    user_id    BIGINT       NOT NULL,
    action     TEXT         NOT NULL,
    resource   TEXT         NOT NULL,
    ip_address INET,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
) PARTITION BY HASH (user_id);

-- Create 8 partitions (MODULUS must be consistent, REMAINDER 0 to MODULUS-1)
CREATE TABLE audit_log_p0 PARTITION OF audit_log FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE audit_log_p1 PARTITION OF audit_log FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE audit_log_p2 PARTITION OF audit_log FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE audit_log_p3 PARTITION OF audit_log FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE audit_log_p4 PARTITION OF audit_log FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE audit_log_p5 PARTITION OF audit_log FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE audit_log_p6 PARTITION OF audit_log FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE audit_log_p7 PARTITION OF audit_log FOR VALUES WITH (MODULUS 8, REMAINDER 7);

-- Verify distribution after loading data
SELECT
    tableoid::regclass AS partition,
    COUNT(*) AS row_count,
    pg_size_pretty(pg_relation_size(tableoid)) AS size
FROM audit_log
GROUP BY tableoid
ORDER BY tableoid::regclass;
```

**Important**: Hash partitions cannot be added incrementally. The only way to increase partition count is to redistribute data into a new partition layout. Plan hash partition counts with growth in mind — use a power of 2 for the modulus to simplify future doubling.

## Partition Maintenance Automation

### Automatic Partition Creation with pg_partman

`pg_partman` is the standard extension for automatic partition lifecycle management:

```sql
-- Install pg_partman (requires superuser during initial setup)
CREATE EXTENSION pg_partman SCHEMA partman;

-- Set up automated monthly partitioning for the orders table
SELECT partman.create_parent(
    p_parent_table   => 'public.orders',
    p_control        => 'created_at',
    p_interval       => 'monthly',
    p_premake        => 4,          -- Pre-create 4 future partitions
    p_start_partition => '2029-01-01'
);

-- Configure retention: keep 12 months of data, drop older partitions
UPDATE partman.part_config
SET
    retention           = '12 months',
    retention_keep_table = false,   -- Drop partitions entirely
    automatic_maintenance = 'on',
    premake              = 4
WHERE parent_table = 'public.orders';

-- Schedule maintenance to run hourly (via pg_cron or external scheduler)
-- pg_cron example (if pg_cron is installed):
SELECT cron.schedule(
    'partman-maintenance',
    '5 * * * *',   -- Every hour at :05
    'CALL partman.run_maintenance_proc()'
);
```

### Manual Partition Management Script

For environments without pg_partman, a simple PL/pgSQL function creates partitions on demand:

```sql
CREATE OR REPLACE FUNCTION create_monthly_partition(
    parent_table TEXT,
    partition_month DATE
)
RETURNS TEXT AS $$
DECLARE
    partition_name TEXT;
    start_date     DATE;
    end_date       DATE;
    sql            TEXT;
BEGIN
    start_date     := DATE_TRUNC('month', partition_month);
    end_date       := start_date + INTERVAL '1 month';
    partition_name := parent_table || '_' ||
                      TO_CHAR(start_date, 'YYYY_MM');

    -- Check if partition already exists
    IF EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = partition_name
          AND relnamespace = 'public'::regnamespace
    ) THEN
        RETURN 'Partition ' || partition_name || ' already exists';
    END IF;

    sql := FORMAT(
        'CREATE TABLE %I PARTITION OF %I '
        'FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        parent_table,
        start_date,
        end_date
    );

    EXECUTE sql;
    RETURN 'Created partition: ' || partition_name;
END;
$$ LANGUAGE plpgsql;

-- Create next 3 months of partitions
SELECT create_monthly_partition('orders', NOW()::DATE + (n || ' months')::INTERVAL)
FROM generate_series(0, 2) AS n;
```

### Dropping Old Partitions

```sql
-- Drop partitions older than 12 months (much faster than DELETE)
DO $$
DECLARE
    partition_rec RECORD;
    cutoff_date   DATE := DATE_TRUNC('month', NOW() - INTERVAL '12 months');
BEGIN
    FOR partition_rec IN
        SELECT
            child.relname AS partition_name,
            pg_get_expr(child.relpartbound, child.oid) AS bounds
        FROM pg_inherits
        JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
        JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
        WHERE parent.relname = 'orders'
          AND child.relname  != 'orders_default'
          AND child.relname  < 'orders_' || TO_CHAR(cutoff_date, 'YYYY_MM')
    LOOP
        RAISE NOTICE 'Dropping partition: %', partition_rec.partition_name;
        EXECUTE 'DROP TABLE ' || quote_ident(partition_rec.partition_name);
    END LOOP;
END $$;
```

## Cross-Partition Operations and Constraints

### Foreign Keys on Partitioned Tables

Foreign keys from a non-partitioned table pointing to a partitioned table work normally. Foreign keys from a partitioned table to another table are inherited by all partitions:

```sql
-- Create the referenced table
CREATE TABLE customers (
    id   BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL
);

-- Add foreign key to the partitioned orders table
-- This creates FKs on all existing and future partitions
ALTER TABLE orders
    ADD CONSTRAINT orders_customer_fk
    FOREIGN KEY (customer_id)
    REFERENCES customers (id)
    ON DELETE RESTRICT;
```

### Bulk Loading into Partitions

For high-throughput bulk loading, bypass the parent table router by inserting directly into the target partition:

```sql
-- Direct insert into a specific partition is faster for bulk loads
-- (avoids partition routing overhead)
COPY orders_2029_03 (customer_id, amount, status, created_at)
FROM '/data/orders-march-2029.csv'
WITH (FORMAT csv, HEADER true);

-- Use COPY with FREEZE for maximum performance (only works on empty partitions)
COPY orders_2029_04 (customer_id, amount, status, created_at)
FROM '/data/orders-april-2029.csv'
WITH (FORMAT csv, HEADER true, FREEZE true);
```

### Analyzing Partition Performance

```sql
-- Check partition sizes and row counts
SELECT
    child.relname                                   AS partition,
    pg_size_pretty(pg_relation_size(child.oid))    AS table_size,
    pg_size_pretty(pg_indexes_size(child.oid))     AS index_size,
    pg_size_pretty(pg_total_relation_size(child.oid)) AS total_size,
    c.reltuples::BIGINT                            AS estimated_rows
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
JOIN pg_class c      ON c.oid = child.oid
WHERE parent.relname = 'orders'
ORDER BY child.relname;

-- Find queries performing full partition scans when they shouldn't
SELECT
    query,
    calls,
    mean_exec_time,
    rows
FROM pg_stat_statements
WHERE query ILIKE '%orders%'
  AND mean_exec_time > 1000  -- Queries taking more than 1 second
ORDER BY mean_exec_time DESC
LIMIT 20;
```

## VACUUM and AUTOVACUUM on Partitioned Tables

autovacuum operates on individual partitions independently. Configure more aggressive autovacuum thresholds for large partitions:

```sql
-- Set aggressive autovacuum on active (write-heavy) partitions
ALTER TABLE orders_2029_03
    SET (
        autovacuum_vacuum_scale_factor    = 0.01,  -- Vacuum at 1% dead tuples
        autovacuum_analyze_scale_factor   = 0.005, -- Analyze at 0.5% changes
        autovacuum_vacuum_cost_delay      = 2,     -- Low delay for faster vacuum
        autovacuum_vacuum_insert_threshold = 1000
    );

-- Set conservative settings on archived (read-only) partitions
ALTER TABLE orders_2029_01
    SET (
        autovacuum_enabled = false  -- No need to vacuum read-only partitions
    );

-- Check autovacuum activity across partitions
SELECT
    schemaname,
    relname,
    n_live_tup,
    n_dead_tup,
    n_dead_tup::float / NULLIF(n_live_tup + n_dead_tup, 0) AS dead_ratio,
    last_vacuum,
    last_autovacuum,
    last_analyze
FROM pg_stat_user_tables
WHERE relname LIKE 'orders_%'
ORDER BY n_dead_tup DESC;
```

## Partitioning and Connection Pooling Interactions

PgBouncer and other connection poolers do not need special configuration for partitioned tables. However, partition maintenance operations (CREATE TABLE, DROP TABLE, ATTACH PARTITION) acquire brief ACCESS EXCLUSIVE locks on the parent table:

```sql
-- Check for blocking locks during partition operations
SELECT
    blocked.pid                       AS blocked_pid,
    blocked.query                     AS blocked_query,
    blocking.pid                      AS blocking_pid,
    blocking.query                    AS blocking_query,
    blocked_locks.locktype,
    blocked_locks.relation::regclass  AS locked_relation
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked
    ON blocked.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.DATABASE IS NOT DISTINCT FROM blocked_locks.DATABASE
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking
    ON blocking.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

For zero-downtime partition attachment, use `ATTACH PARTITION` which acquires a less disruptive `SHARE UPDATE EXCLUSIVE` lock when the partition has an appropriate check constraint:

```sql
-- Create the new partition as a standalone table first
CREATE TABLE orders_2029_04 (
    LIKE orders INCLUDING ALL,
    CONSTRAINT orders_2029_04_check
        CHECK (created_at >= '2029-04-01' AND created_at < '2029-05-01')
);

-- Load data into the standalone table while the production system is running
COPY orders_2029_04 FROM '/data/april-2029.csv' WITH (FORMAT csv);

-- Attach with minimal lock contention
-- The CHECK constraint allows PostgreSQL to skip the scan
ALTER TABLE orders
    ATTACH PARTITION orders_2029_04
    FOR VALUES FROM ('2029-04-01') TO ('2029-05-01');
```

## Monitoring Queries Accessing Partition Data

```sql
-- Create a view for easy partition monitoring
CREATE VIEW partition_stats AS
SELECT
    parent.relname                                    AS parent_table,
    child.relname                                     AS partition_name,
    pg_get_expr(child.relpartbound, child.oid)        AS bounds,
    s.seq_scan                                        AS seq_scans,
    s.idx_scan                                        AS idx_scans,
    s.n_live_tup                                      AS live_rows,
    s.n_dead_tup                                      AS dead_rows,
    pg_size_pretty(pg_relation_size(child.oid))       AS table_size,
    pg_size_pretty(pg_total_relation_size(child.oid)) AS total_size
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child  ON pg_inherits.inhrelid = child.oid
JOIN pg_stat_user_tables s ON s.relid = child.oid
ORDER BY parent.relname, child.relname;

SELECT * FROM partition_stats WHERE parent_table = 'orders';
```
