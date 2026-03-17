---
title: "PostgreSQL Performance Tuning: Query Optimization, Indexes, and Configuration"
date: 2028-09-24T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "Database", "Performance", "SQL", "Kubernetes"]
categories:
- PostgreSQL
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive PostgreSQL performance tuning guide covering EXPLAIN ANALYZE interpretation, index types, query planner statistics, PgBouncer connection pooling, memory configuration, autovacuum tuning, pg_stat_statements, slow query logging, and partitioning strategies for production databases."
more_link: "yes"
url: "/postgresql-performance-tuning-query-optimization-guide/"
---

PostgreSQL is often deployed with default configuration and then blamed when queries slow down as data grows. In practice, PostgreSQL's query planner is remarkably capable when given accurate statistics and appropriate memory budgets. The most common performance problems are caused by missing indexes, stale statistics, oversized connection pools, and misconfigured memory parameters — all of which are fixable without changing a line of application code.

This guide works through the tools and techniques for diagnosing and resolving PostgreSQL performance problems systematically.

<!--more-->

# PostgreSQL Performance Tuning: Query Optimization, Indexes, and Configuration

## Reading EXPLAIN ANALYZE Output

`EXPLAIN ANALYZE` executes the query and returns the actual execution plan with real timing data. This is the primary diagnostic tool for slow queries.

### Basic Usage

```sql
-- Always use EXPLAIN (ANALYZE, BUFFERS) for complete information
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT
    o.id,
    o.created_at,
    c.name AS customer_name,
    SUM(oi.quantity * oi.unit_price) AS total
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN order_items oi ON oi.order_id = o.id
WHERE o.created_at >= NOW() - INTERVAL '30 days'
  AND o.status = 'completed'
GROUP BY o.id, o.created_at, c.name
ORDER BY o.created_at DESC
LIMIT 100;
```

### Interpreting the Output

```
Limit  (cost=15432.11..15432.36 rows=100 width=48) (actual time=234.521..234.531 rows=100 loops=1)
  ->  Sort  (cost=15432.11..15457.11 rows=10000 width=48) (actual time=234.519..234.524 rows=100 loops=1)
        Sort Key: o.created_at DESC
        Sort Method: top-N heapsort  Memory: 35kB
        ->  HashAggregate  (cost=14782.11..14882.11 rows=10000 width=48) (actual time=231.891..232.891 rows=10000 loops=1)
              Group Key: o.id, o.created_at, c.name
              Batches: 1  Memory Usage: 2065kB
              ->  Hash Join  (cost=1234.00..13782.11 rows=100000 width=32) (actual time=45.211..198.234 rows=150000 loops=1)
                    Hash Cond: (oi.order_id = o.id)
                    Buffers: shared hit=1234 read=4521
                    ->  Seq Scan on order_items oi  (cost=0.00..8234.11 rows=500000 width=16) (actual time=0.012..89.234 rows=500000 loops=1)
                          Buffers: shared hit=234 read=4234
                    ->  Hash  (cost=1034.00..1034.00 rows=16000 width=24) (actual time=44.123..44.123 rows=16000 loops=1)
                          Buckets: 16384  Batches: 1  Memory Usage: 1024kB
                          ->  Hash Join  (cost=234.00..1034.00 rows=16000 width=24) (actual time=12.456..41.234 rows=16000 loops=1)
                                Hash Cond: (o.customer_id = c.id)
                                ->  Index Scan using orders_created_at_idx on orders o  (cost=0.56..612.34 rows=16000 width=16) (actual time=0.045..28.123 rows=16000 loops=1)
                                      Index Cond: (created_at >= (now() - '30 days'::interval))
                                      Filter: ((status)::text = 'completed'::text)
                                      Rows Removed by Filter: 4000
                                      Buffers: shared hit=1000 read=287
                                ->  Hash  (cost=134.00..134.00 rows=8000 width=16) (actual time=11.234..11.234 rows=8000 loops=1)
                                      Buckets: 8192  Batches: 1  Memory Usage: 512kB
                                      ->  Seq Scan on customers c  (cost=0.00..134.00 rows=8000 width=16) (actual time=0.006..8.234 rows=8000 loops=1)
Planning Time: 2.345 ms
Execution Time: 234.623 ms
```

Key elements to examine:

- **`Seq Scan`** on large tables — usually indicates a missing index
- **`Rows Removed by Filter`** — a large number means a partial index or composite index could help
- **`Buffers: shared read=4521`** — cache misses; 4521 blocks read from disk
- **`actual time=89.234`** on a seq scan — the dominant cost, worth indexing
- **`cost=` estimate vs `actual time=`** discrepancy — stale statistics

### Identifying the Bottleneck

```sql
-- Use pg_stat_statements to find the worst queries automatically
-- (Enable pg_stat_statements first — see below)
SELECT
    round(total_exec_time::numeric, 2) AS total_ms,
    round(mean_exec_time::numeric, 2) AS mean_ms,
    round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 2) AS pct,
    calls,
    query
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT 20;
```

## Index Types and When to Use Each

### B-tree (Default)

```sql
-- Standard B-tree: equality and range queries
CREATE INDEX CONCURRENTLY orders_created_at_status_idx
  ON orders (created_at DESC, status)
  WHERE status IN ('completed', 'processing');

-- Covering index: include extra columns to avoid table access
CREATE INDEX CONCURRENTLY orders_covering_idx
  ON orders (customer_id, created_at DESC)
  INCLUDE (status, total_amount);

-- Unique partial index
CREATE UNIQUE INDEX CONCURRENTLY users_email_active_idx
  ON users (email)
  WHERE deleted_at IS NULL;
```

### GIN Index for Arrays, JSONB, and Full-Text Search

```sql
-- JSONB containment queries
CREATE INDEX CONCURRENTLY products_attributes_gin_idx
  ON products USING gin (attributes);

-- Query using the index
SELECT * FROM products
WHERE attributes @> '{"color": "red", "size": "XL"}';

-- Full-text search
ALTER TABLE articles ADD COLUMN search_vector tsvector;

CREATE INDEX CONCURRENTLY articles_search_gin_idx
  ON articles USING gin (search_vector);

-- Populate the tsvector column
UPDATE articles
SET search_vector = to_tsvector('english', title || ' ' || body);

-- Query
SELECT title FROM articles
WHERE search_vector @@ plainto_tsquery('english', 'kubernetes autoscaling');

-- Automatically maintain the search_vector
CREATE OR REPLACE FUNCTION articles_search_vector_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', NEW.title || ' ' || NEW.body);
  RETURN NEW;
END;
$$;

CREATE TRIGGER articles_search_vector_trigger
BEFORE INSERT OR UPDATE ON articles
FOR EACH ROW EXECUTE FUNCTION articles_search_vector_update();
```

### GiST Index for Geometric and Range Data

```sql
-- Range type index (daterange, tsrange, numrange)
CREATE INDEX CONCURRENTLY bookings_period_gist_idx
  ON bookings USING gist (period);

-- Overlap query — uses GiST index
SELECT * FROM bookings
WHERE period && tsrange('2025-01-01', '2025-01-31');

-- Exclusion constraint using GiST — prevent overlapping bookings
ALTER TABLE room_bookings
ADD CONSTRAINT no_overlapping_bookings
EXCLUDE USING gist (room_id WITH =, period WITH &&);
```

### BRIN Index for Time-Series Data

```sql
-- BRIN (Block Range Index): extremely small, effective on naturally ordered data
-- Ideal for append-only tables like event logs or metrics
CREATE INDEX CONCURRENTLY events_created_at_brin_idx
  ON events USING brin (created_at)
  WITH (pages_per_range = 128);

-- BRIN is a fraction of the size of a B-tree for time-ordered tables
-- B-tree on 100M rows: ~2-3 GB
-- BRIN on 100M rows: ~1-5 MB
```

### Partial Indexes

```sql
-- Only index rows that queries actually filter on
-- Much smaller than full index, faster to maintain

-- Only active users (90% of queries filter for active users)
CREATE INDEX CONCURRENTLY users_email_active_idx
  ON users (email)
  WHERE is_active = true;

-- Only unprocessed queue items
CREATE INDEX CONCURRENTLY queue_items_pending_idx
  ON queue_items (created_at, priority DESC)
  WHERE processed_at IS NULL;

-- Only recent orders (last 90 days)
CREATE INDEX CONCURRENTLY orders_recent_customer_idx
  ON orders (customer_id, created_at DESC)
  WHERE created_at > NOW() - INTERVAL '90 days';
-- Note: this index will need periodic recreation as data ages
```

## Query Planner Statistics

The query planner uses statistics to estimate row counts. Stale or inadequate statistics cause bad plan choices.

```sql
-- Check when statistics were last collected
SELECT
    schemaname,
    tablename,
    last_analyze,
    last_autoanalyze,
    n_live_tup,
    n_dead_tup,
    n_mod_since_analyze
FROM pg_stat_user_tables
ORDER BY n_mod_since_analyze DESC;

-- Check column statistics
SELECT
    attname AS column,
    n_distinct,
    most_common_vals,
    most_common_freqs,
    histogram_bounds
FROM pg_stats
WHERE tablename = 'orders'
ORDER BY attname;

-- Manually run ANALYZE with higher statistics target for problem columns
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 500;
ANALYZE orders;

-- Force statistics update on specific tables
ANALYZE VERBOSE orders, order_items, customers;

-- Check if the planner estimates match reality
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM orders WHERE status = 'completed';
-- Compare "rows=X" (estimate) vs "actual ... rows=Y" (actual)
-- Large discrepancy means statistics need improvement
```

## Configuration Tuning

### postgresql.conf Key Parameters

```bash
# Generate a starting configuration for your hardware
# Use PGTune (https://pgtune.leopard.in.ua) or set manually:

# For a server with 32GB RAM, 8 CPUs, SSD storage, primarily OLTP:

# Memory
shared_buffers = '8GB'              # 25% of RAM; PostgreSQL buffer pool
effective_cache_size = '24GB'       # 75% of RAM; hints to planner about OS cache
work_mem = '64MB'                   # Per sort/hash operation; be careful with connections
maintenance_work_mem = '2GB'        # For VACUUM, CREATE INDEX, etc.
wal_buffers = '64MB'                # Usually auto-tuned to 1/32 of shared_buffers

# Query planner
random_page_cost = 1.1              # 1.1 for SSD; 4.0 for spinning disk (default)
effective_io_concurrency = 200      # Number of concurrent I/O operations for bitmap scans
default_statistics_target = 100     # Default 100; increase to 500 for problematic columns

# Write performance
checkpoint_completion_target = 0.9  # Spread checkpoint I/O
max_wal_size = '4GB'                # Larger = fewer checkpoints = better throughput
min_wal_size = '1GB'

# Connections
max_connections = 200               # Keep low; use connection pooler
```

Apply configuration changes:

```bash
# Some parameters require restart; others can be reloaded
# Check which require restart
SELECT name, setting, pending_restart
FROM pg_settings
WHERE pending_restart = true;

# Reload without restart (for parameters that support it)
SELECT pg_reload_conf();

# Check current effective settings
SHOW shared_buffers;
SHOW work_mem;
SELECT current_setting('max_connections');
```

### work_mem Sizing

`work_mem` is the maximum memory per sort/hash operation per query step. It multiplies with connections and complex queries:

```sql
-- Check actual memory usage per query
SET work_mem = '256MB';
EXPLAIN (ANALYZE, BUFFERS)
SELECT customer_id, SUM(total)
FROM orders
GROUP BY customer_id
ORDER BY 2 DESC;
-- Look for "Memory Usage" in the HashAggregate node

-- Check for sort spills to disk (Batches > 1 = spill)
-- HashAggregate: Batches: 3  Disk Usage: 45678kB  <-- BAD
-- Sort: Sort Method: external merge  Disk: 23456kB  <-- BAD

-- Set per-session for expensive queries
SET LOCAL work_mem = '512MB';
-- Runs for this transaction only
```

## Autovacuum Tuning

Autovacuum reclaims dead rows and updates statistics. On high-write tables, the defaults are too conservative.

```sql
-- Check vacuum status
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    round(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;

-- Check if autovacuum is keeping up
SELECT
    relname,
    n_dead_tup,
    autovacuum_count,
    last_autovacuum
FROM pg_stat_user_tables
WHERE last_autovacuum < NOW() - INTERVAL '24 hours'
  AND n_live_tup > 100000
ORDER BY n_dead_tup DESC;
```

Tune autovacuum per-table for high-write workloads:

```sql
-- Tune a high-write table (e.g., events table with 1M+ inserts/day)
ALTER TABLE events SET (
    autovacuum_vacuum_scale_factor = 0.01,      -- Trigger at 1% dead rows (default 0.2)
    autovacuum_analyze_scale_factor = 0.005,    -- Analyze at 0.5% changes (default 0.1)
    autovacuum_vacuum_cost_delay = 2,           -- Less delay between cost periods (ms)
    autovacuum_vacuum_cost_limit = 400,         -- Higher budget (default 200)
    autovacuum_vacuum_threshold = 1000,         -- Minimum dead rows before triggering
    toast.autovacuum_enabled = true
);

-- Global autovacuum tuning (postgresql.conf)
-- autovacuum_max_workers = 6               (default 3)
-- autovacuum_vacuum_cost_delay = 2ms       (default 2ms on SSD is fine)
-- autovacuum_vacuum_cost_limit = 400       (default 200)
-- autovacuum_naptime = 15s                 (default 1min)

-- Force an immediate vacuum
VACUUM (ANALYZE, VERBOSE) events;
```

## Connection Pooling with PgBouncer

PostgreSQL creates a backend process per connection. High connection counts (>200) cause significant overhead. PgBouncer multiplexes many application connections over a smaller pool of PostgreSQL connections.

### PgBouncer Deployment on Kubernetes

```yaml
# pgbouncer-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgbouncer
  namespace: database
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pgbouncer
  template:
    metadata:
      labels:
        app: pgbouncer
    spec:
      containers:
        - name: pgbouncer
          image: bitnami/pgbouncer:1.22.1
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRESQL_HOST
              value: postgres-primary.database
            - name: POSTGRESQL_PORT
              value: "5432"
            - name: PGBOUNCER_DATABASE
              value: "*"  # Proxy all databases
            - name: PGBOUNCER_POOL_MODE
              value: transaction  # transaction | session | statement
            - name: PGBOUNCER_MAX_CLIENT_CONN
              value: "10000"  # Max connections from applications
            - name: PGBOUNCER_DEFAULT_POOL_SIZE
              value: "25"     # PostgreSQL connections per database/user pair
            - name: PGBOUNCER_MIN_POOL_SIZE
              value: "5"
            - name: PGBOUNCER_RESERVE_POOL_SIZE
              value: "5"
            - name: PGBOUNCER_RESERVE_POOL_TIMEOUT
              value: "3"
            - name: PGBOUNCER_STATS_USERS
              value: "pgbouncer"
            - name: POSTGRESQL_USERNAME
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: username
            - name: POSTGRESQL_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: password
          readinessProbe:
            tcpSocket:
              port: 5432
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: "100m"
              memory: "64Mi"
            limits:
              cpu: "500m"
              memory: "256Mi"

---
apiVersion: v1
kind: Service
metadata:
  name: pgbouncer
  namespace: database
spec:
  selector:
    app: pgbouncer
  ports:
    - port: 5432
      targetPort: 5432
```

```ini
# pgbouncer.ini for direct configuration (alternative to env vars)
[databases]
# Wildcard — proxy all databases to the backend
* = host=postgres-primary.database port=5432

[pgbouncer]
listen_port = 5432
listen_addr = 0.0.0.0
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction
max_client_conn = 10000
default_pool_size = 25
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3

# TLS configuration
client_tls_sslmode = require
client_tls_cert_file = /etc/pgbouncer/tls/tls.crt
client_tls_key_file = /etc/pgbouncer/tls/tls.key
server_tls_sslmode = require
server_tls_ca_file = /etc/pgbouncer/tls/ca.crt

# Monitoring
stats_period = 60
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
```

```bash
# Monitor PgBouncer statistics
psql -h pgbouncer.database -p 5432 -U pgbouncer pgbouncer -c "SHOW STATS;"
psql -h pgbouncer.database -p 5432 -U pgbouncer pgbouncer -c "SHOW POOLS;"
psql -h pgbouncer.database -p 5432 -U pgbouncer pgbouncer -c "SHOW CLIENTS;"
psql -h pgbouncer.database -p 5432 -U pgbouncer pgbouncer -c "SHOW SERVERS;"
```

## pg_stat_statements Setup

```sql
-- Add to postgresql.conf:
-- shared_preload_libraries = 'pg_stat_statements'
-- pg_stat_statements.max = 10000
-- pg_stat_statements.track = all

-- Then create the extension
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top queries by total execution time
SELECT
    LEFT(query, 100) AS query_preview,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    round(mean_exec_time::numeric, 2) AS mean_ms,
    round(stddev_exec_time::numeric, 2) AS stddev_ms,
    round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 2) AS pct_total,
    rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 25;

-- Top queries by average execution time (slowest individual calls)
SELECT
    LEFT(query, 100) AS query_preview,
    calls,
    round(mean_exec_time::numeric, 2) AS mean_ms,
    round(stddev_exec_time::numeric, 2) AS stddev_ms,
    round(min_exec_time::numeric, 2) AS min_ms,
    round(max_exec_time::numeric, 2) AS max_ms
FROM pg_stat_statements
WHERE calls > 100  -- Filter out one-off queries
ORDER BY mean_exec_time DESC
LIMIT 25;

-- Queries with high I/O (shared_blks_read)
SELECT
    LEFT(query, 100) AS query_preview,
    calls,
    shared_blks_hit,
    shared_blks_read,
    round(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 2) AS hit_pct
FROM pg_stat_statements
WHERE shared_blks_read > 10000
ORDER BY shared_blks_read DESC
LIMIT 20;

-- Reset statistics for a fresh baseline
SELECT pg_stat_statements_reset();
```

## Slow Query Logging

```bash
# postgresql.conf settings for slow query logging
log_min_duration_statement = 1000  # Log queries taking more than 1 second (ms)
log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '
log_checkpoints = on
log_connections = off          # High-traffic: keep off to avoid log spam
log_disconnections = off
log_lock_waits = on            # Log when waiting for locks > deadlock_timeout
log_temp_files = 0             # Log all temp files (0 = all)
log_autovacuum_min_duration = 250  # Log autovacuum runs > 250ms
```

Parse slow query logs with `pgBadger`:

```bash
# Install pgBadger
apt-get install -y pgbadger

# Analyze PostgreSQL logs
pgbadger \
  /var/log/postgresql/postgresql-*.log \
  --outfile /tmp/pgbadger-report.html \
  --format text \
  --jobs 4 \
  --maxlength 200000

# For Docker/Kubernetes: collect logs first
kubectl logs -n database postgres-primary-0 > /tmp/pg.log 2>&1
pgbadger /tmp/pg.log --outfile /tmp/report.html
```

## Table Partitioning

Partitioning large tables dramatically improves query performance and simplifies data management.

### Range Partitioning (Time Series)

```sql
-- Create partitioned parent table
CREATE TABLE events (
    id          BIGSERIAL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type  TEXT NOT NULL,
    user_id     BIGINT,
    payload     JSONB
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
DO $$
DECLARE
    start_date DATE := '2025-01-01';
    end_date   DATE;
    i          INTEGER;
BEGIN
    FOR i IN 0..23 LOOP  -- Create 24 months of partitions
        end_date := start_date + INTERVAL '1 month';
        EXECUTE format(
            'CREATE TABLE events_%s PARTITION OF events
             FOR VALUES FROM (%L) TO (%L)
             TABLESPACE pg_default',
            to_char(start_date, 'YYYY_MM'),
            start_date,
            end_date
        );
        start_date := end_date;
    END LOOP;
END;
$$;

-- Create indexes on each partition (or the parent)
CREATE INDEX events_created_at_idx ON events (created_at);
CREATE INDEX events_user_id_idx ON events (user_id, created_at);
CREATE INDEX events_type_idx ON events (event_type, created_at);

-- Automatic partition creation with pg_partman extension
-- (Alternative to manual partition management)
CREATE EXTENSION pg_partman;

SELECT partman.create_parent(
    p_parent_table => 'public.events',
    p_control => 'created_at',
    p_type => 'range',
    p_interval => 'monthly',
    p_premake => 3  -- Create 3 future partitions in advance
);

-- Configure retention
UPDATE partman.part_config
SET retention = '24 months',
    retention_keep_table = false,
    retention_keep_index = false
WHERE parent_table = 'public.events';

-- Run maintenance (typically via pg_partman's background worker or cron)
SELECT partman.run_maintenance('public.events');
```

### Hash Partitioning for Distribution

```sql
-- Hash partition for even distribution (not time-based)
CREATE TABLE user_activity (
    user_id    BIGINT NOT NULL,
    action     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY HASH (user_id);

-- Create 8 partitions
DO $$
BEGIN
    FOR i IN 0..7 LOOP
        EXECUTE format(
            'CREATE TABLE user_activity_p%s PARTITION OF user_activity
             FOR VALUES WITH (modulus 8, remainder %s)',
            i, i
        );
    END LOOP;
END;
$$;

-- Drop old data from a range partition (instant, no VACUUM needed)
-- For example, drop events older than 2 years
DROP TABLE events_2023_01;  -- Instant operation

-- Attach a new partition
CREATE TABLE events_2026_01 (LIKE events INCLUDING ALL);
ALTER TABLE events ATTACH PARTITION events_2026_01
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
```

## Locking and Deadlock Analysis

```sql
-- Find blocking queries
SELECT
    blocked.pid AS blocked_pid,
    blocked.query AS blocked_query,
    blocking.pid AS blocking_pid,
    blocking.query AS blocking_query,
    blocked.wait_event_type,
    blocked.wait_event
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
  ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.cardinality(pg_blocking_pids(blocked.pid)) > 0;

-- Long-running transactions (lock holders)
SELECT
    pid,
    now() - xact_start AS duration,
    state,
    wait_event_type,
    wait_event,
    LEFT(query, 100) AS query
FROM pg_stat_activity
WHERE state != 'idle'
  AND xact_start < NOW() - INTERVAL '5 minutes'
ORDER BY xact_start;

-- Lock contention overview
SELECT
    locktype,
    relation::regclass AS table,
    mode,
    granted,
    pid
FROM pg_locks
WHERE NOT granted
ORDER BY relation, mode;

-- Terminate a blocking query (as superuser)
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE pid = 12345;
```

## Index Maintenance

```sql
-- Find unused indexes (candidates for removal)
SELECT
    schemaname,
    tablename,
    indexname,
    idx_scan AS scans,
    idx_tup_read AS tuples_read,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conindid = indexrelid
  )
ORDER BY pg_relation_size(indexrelid) DESC;

-- Find duplicate indexes
SELECT
    indrelid::regclass AS table,
    string_agg(indexrelid::regclass::text, ', ') AS indexes,
    array_agg(indkey) AS keys
FROM pg_index
GROUP BY indrelid, indkey
HAVING count(*) > 1;

-- Check index bloat
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    round(100.0 * (pg_relation_size(indexrelid) - pg_table_size(indexrelid)) /
          NULLIF(pg_relation_size(indexrelid), 0), 2) AS waste_pct
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;

-- Rebuild a bloated index without downtime
REINDEX INDEX CONCURRENTLY orders_created_at_idx;

-- Rebuild all indexes on a table
REINDEX TABLE CONCURRENTLY orders;
```

## Summary

PostgreSQL performance tuning is a systematic process rather than a series of magic settings.

The diagnostic workflow:
1. Identify slow queries using `pg_stat_statements` or slow query logs
2. Run `EXPLAIN (ANALYZE, BUFFERS)` on each problem query
3. Look for Seq Scans on large tables, Sort/HashAggregate spills, and large Rows Removed by Filter counts
4. Add or refine indexes (B-tree for equality/range, GIN for JSONB/arrays, BRIN for time-ordered data, partial indexes for filtered queries)
5. Ensure `ANALYZE` has run recently; increase `statistics_target` for skewed columns
6. Tune `shared_buffers`, `work_mem`, and `effective_cache_size` for your hardware
7. Tune autovacuum thresholds for high-write tables to prevent bloat accumulation
8. Deploy PgBouncer in `transaction` mode between your application and PostgreSQL when connection counts exceed 100
9. Partition large tables by time range to enable instant data retention and efficient partition pruning
