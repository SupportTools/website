---
title: "PostgreSQL JSONB and Full-Text Search: Advanced Query Patterns"
date: 2028-11-12T00:00:00-05:00
draft: false
tags: ["PostgreSQL", "JSONB", "Full-Text Search", "Database", "SQL"]
categories:
- PostgreSQL
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced PostgreSQL query patterns covering JSONB operators, GIN indexes, jsonb_path_query, tsvector full-text search, pg_trgm fuzzy matching, generated columns for search indexes, and a performance comparison with Elasticsearch for common use cases."
more_link: "yes"
url: "/postgresql-jsonb-full-text-search-guide/"
---

PostgreSQL's JSONB support and full-text search engine are mature enough to replace specialized document stores and search engines for many production workloads. This guide covers advanced patterns: GIN index strategies for JSONB, JSONPath queries, tsvector/tsquery with custom configurations, pg_trgm for fuzzy matching, and how to combine JSONB filtering with full-text ranking. We finish with an honest performance comparison against Elasticsearch for typical use cases.

<!--more-->

# PostgreSQL JSONB and Full-Text Search: Advanced Query Patterns

## JSONB Fundamentals and Storage

JSONB stores JSON in a decomposed binary format that supports indexing and fast key-value lookups. Unlike `json`, which stores a text copy, `jsonb` normalizes key order and removes duplicate keys.

```sql
-- Create a table with JSONB metadata
CREATE TABLE products (
    id          bigserial PRIMARY KEY,
    sku         text NOT NULL UNIQUE,
    name        text NOT NULL,
    metadata    jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Insert sample data
INSERT INTO products (sku, name, metadata) VALUES
('PRD-001', 'Wireless Headphones',
 '{"brand":"Sony","color":"black","specs":{"weight_g":250,"battery_hours":30},"tags":["audio","wireless"],"price":199.99}'),
('PRD-002', 'Laptop Stand',
 '{"brand":"Anker","color":"silver","specs":{"weight_g":800,"max_height_mm":160},"tags":["accessories","ergonomic"],"price":49.99}'),
('PRD-003', 'USB-C Hub',
 '{"brand":"Anker","color":"black","specs":{"ports":7,"usb3_count":3},"tags":["accessories","connectivity"],"price":39.99}');
```

## JSONB Operators Reference

```sql
-- Containment: does left contain right?
SELECT sku FROM products
WHERE metadata @> '{"brand":"Anker"}';
-- Returns: PRD-002, PRD-003

-- Key existence
SELECT sku FROM products
WHERE metadata ? 'color';

-- Any key from array exists
SELECT sku FROM products
WHERE metadata ?| ARRAY['color', 'weight'];

-- All keys from array exist
SELECT sku FROM products
WHERE metadata ?& ARRAY['brand', 'color', 'specs'];

-- Extract path as JSONB
SELECT metadata->'specs'->'battery_hours' AS battery
FROM products
WHERE sku = 'PRD-001';
-- Returns: 30 (as jsonb integer)

-- Extract path as text
SELECT metadata->>'brand' AS brand
FROM products;
-- Returns: Sony, Anker, Anker

-- Nested path with #>
SELECT metadata #> '{specs,battery_hours}' AS battery
FROM products WHERE sku = 'PRD-001';

-- Numeric comparison on JSONB values requires casting
SELECT sku, (metadata->'price')::numeric AS price
FROM products
WHERE (metadata->>'price')::numeric < 100;
```

## GIN Indexes: The Right Index for JSONB

GIN (Generalized Inverted Index) is the primary index type for JSONB. There are two operator classes:

```sql
-- Default GIN index: supports @>, ?, ?|, ?&
-- Best for containment and key existence queries
CREATE INDEX idx_products_metadata_gin
ON products USING GIN (metadata);

-- jsonb_path_ops: only supports @>, but smaller and faster
CREATE INDEX idx_products_metadata_path_ops
ON products USING GIN (metadata jsonb_path_ops);

-- Partial GIN index for a specific JSON path
-- Useful when you always filter on metadata->>'brand'
CREATE INDEX idx_products_brand
ON products USING BTREE ((metadata->>'brand'));

-- Partial index on JSONB key for selective subsets
CREATE INDEX idx_products_expensive
ON products USING GIN (metadata)
WHERE (metadata->>'price')::numeric > 100;
```

Verify index usage:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM products
WHERE metadata @> '{"brand":"Anker"}';

-- Should show: Bitmap Index Scan on idx_products_metadata_gin
-- NOT: Seq Scan on products
```

## JSONPath Queries (PostgreSQL 12+)

JSONPath provides XPath-like syntax for navigating and filtering JSON:

```sql
-- jsonb_path_query: returns matching values
SELECT jsonb_path_query(metadata, '$.specs.battery_hours')
FROM products;
-- Returns: 30 (only for products with this path)

-- Filter with JSONPath predicate
SELECT sku, name
FROM products
WHERE jsonb_path_exists(metadata, '$.specs.battery_hours ? (@ > 20)');

-- jsonb_path_match: returns boolean
SELECT sku,
       jsonb_path_match(metadata, '$.price < 100') AS is_budget
FROM products;

-- Wildcard traversal: find all specs values
SELECT sku, jsonb_path_query_array(metadata, '$.specs.*') AS spec_values
FROM products;

-- Array filtering: find products with specific tags
SELECT sku, name
FROM products
WHERE jsonb_path_exists(metadata, '$.tags[*] ? (@ == "wireless")');

-- Complex predicate: brand=Anker AND price < 50
SELECT sku, name
FROM products
WHERE jsonb_path_match(metadata,
  '$.brand == "Anker" && $.price < 50');
```

## Unnesting JSONB Arrays

```sql
-- jsonb_array_elements: unnest a JSON array into rows
SELECT p.sku, tag
FROM products p,
     jsonb_array_elements_text(p.metadata->'tags') AS tag
WHERE p.metadata->'tags' IS NOT NULL;
-- Returns one row per tag per product

-- Count products per tag
SELECT tag, count(*) AS product_count
FROM products,
     jsonb_array_elements_text(metadata->'tags') AS tag
GROUP BY tag
ORDER BY product_count DESC;

-- Find all products sharing a tag with PRD-001
WITH source_tags AS (
    SELECT jsonb_array_elements_text(metadata->'tags') AS tag
    FROM products WHERE sku = 'PRD-001'
)
SELECT DISTINCT p.sku, p.name
FROM products p,
     jsonb_array_elements_text(p.metadata->'tags') AS t
WHERE t IN (SELECT tag FROM source_tags)
  AND p.sku != 'PRD-001';
```

## Full-Text Search with tsvector and tsquery

Full-text search in PostgreSQL operates on `tsvector` (a preprocessed document) and `tsquery` (a search expression).

```sql
-- Basic full-text search
SELECT sku, name,
       ts_rank(to_tsvector('english', name), query) AS rank
FROM products,
     to_tsquery('english', 'wireless & headphones') AS query
WHERE to_tsvector('english', name) @@ query
ORDER BY rank DESC;

-- Phrase search
SELECT name
FROM products
WHERE to_tsvector('english', name) @@
      phraseto_tsquery('english', 'laptop stand');

-- Prefix matching (autocomplete-style)
SELECT name
FROM products
WHERE to_tsvector('english', name) @@
      to_tsquery('english', 'head:*');
-- Matches: headphones
```

## Generated Columns for Search Indexes

Instead of calling `to_tsvector` at query time, pre-compute it as a generated column:

```sql
-- Add a generated tsvector column
ALTER TABLE products
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(metadata->>'brand', '')), 'B') ||
    setweight(to_tsvector('english', coalesce(
        (SELECT string_agg(tag, ' ')
         FROM jsonb_array_elements_text(metadata->'tags') AS tag),
        ''
    )), 'C')
) STORED;

-- GIN index on the generated column
CREATE INDEX idx_products_search
ON products USING GIN (search_vector);

-- Now queries are fast and simple
SELECT sku, name,
       ts_rank(search_vector, query) AS rank
FROM products,
     to_tsquery('english', 'wireless | bluetooth') AS query
WHERE search_vector @@ query
ORDER BY rank DESC;
```

The `setweight` function assigns relevance weights (A=highest, D=lowest). Matches in the product name (weight A) rank higher than matches in tags (weight C).

## Custom Text Search Configuration

```sql
-- Create a custom dictionary that handles product skus and technical abbreviations
CREATE TEXT SEARCH DICTIONARY tech_dict (
    TEMPLATE = pg_catalog.simple
);

CREATE TEXT SEARCH CONFIGURATION tech_english (COPY = english);

ALTER TEXT SEARCH CONFIGURATION tech_english
    ALTER MAPPING FOR asciiword
    WITH tech_dict, english_stem;

-- Test the configuration
SELECT to_tsvector('tech_english', 'USB-C HUB with 7-PORT connectivity');
-- 'connect':5 'hub':2 'port':4 'usb':1

-- Use custom config in generated column
ALTER TABLE products DROP COLUMN search_vector;
ALTER TABLE products
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
    setweight(to_tsvector('tech_english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('tech_english', coalesce(metadata->>'brand', '')), 'B')
) STORED;
```

## pg_trgm for Fuzzy Search

`pg_trgm` enables similarity-based matching and autocomplete for misspelled queries:

```sql
-- Enable extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index for LIKE and similarity queries
CREATE INDEX idx_products_name_trgm
ON products USING GIN (name gin_trgm_ops);

-- Similarity search (handles typos)
SELECT name, similarity(name, 'headfone') AS sim
FROM products
WHERE similarity(name, 'headfone') > 0.1
ORDER BY sim DESC;
-- Returns: "Wireless Headphones" with similarity ~0.2

-- Fast LIKE/ILIKE with trigram index
SELECT name FROM products
WHERE name ILIKE '%wireless%';
-- Uses idx_products_name_trgm, no seq scan

-- Fuzzy search on JSONB text values
CREATE INDEX idx_products_brand_trgm
ON products USING GIN ((metadata->>'brand') gin_trgm_ops);

SELECT sku, metadata->>'brand' AS brand,
       similarity(metadata->>'brand', 'Snoy') AS sim
FROM products
WHERE similarity(metadata->>'brand', 'Snoy') > 0.2
ORDER BY sim DESC;
-- Returns: Sony
```

## Combining JSONB Filtering with Full-Text Ranking

This is where PostgreSQL really shines — applying structured filters alongside relevance ranking in a single query:

```sql
-- Ranked search within a category, filtered by price and brand
SELECT
    p.sku,
    p.name,
    p.metadata->>'brand' AS brand,
    (p.metadata->>'price')::numeric AS price,
    ts_rank(p.search_vector, query) AS rank,
    ts_headline('tech_english', p.name, query,
        'StartSel=<b>, StopSel=</b>, MaxWords=10') AS highlighted
FROM
    products p,
    to_tsquery('tech_english', 'wireless | audio') AS query
WHERE
    p.search_vector @@ query
    AND p.metadata @> '{"brand":"Sony"}'
    AND (p.metadata->>'price')::numeric BETWEEN 50 AND 300
ORDER BY
    rank DESC,
    price ASC
LIMIT 20;
```

## Advanced: JSONB Aggregation and Update Patterns

```sql
-- Merge JSONB documents (right wins on conflict)
UPDATE products
SET metadata = metadata || '{"on_sale":true,"discount_pct":15}'
WHERE sku = 'PRD-001';

-- Remove a key from JSONB
UPDATE products
SET metadata = metadata - 'on_sale'
WHERE sku = 'PRD-001';

-- Remove a nested key using path
UPDATE products
SET metadata = metadata #- '{specs,weight_g}'
WHERE sku = 'PRD-001';

-- Increment a nested numeric value
UPDATE products
SET metadata = jsonb_set(
    metadata,
    '{view_count}',
    (coalesce(metadata->'view_count', '0')::int + 1)::text::jsonb
)
WHERE sku = 'PRD-001';

-- Aggregate JSONB across rows into array
SELECT jsonb_agg(
    jsonb_build_object(
        'sku', sku,
        'name', name,
        'price', (metadata->>'price')::numeric
    ) ORDER BY (metadata->>'price')::numeric
) AS products_by_price
FROM products
WHERE metadata @> '{"brand":"Anker"}';
```

## Partial Indexes on JSON Fields

Partial indexes reduce index size by covering only relevant rows:

```sql
-- Index only products that are on sale
CREATE INDEX idx_products_on_sale
ON products USING GIN (metadata)
WHERE (metadata->>'on_sale')::boolean = true;

-- Index only products with battery specs (electronics)
CREATE INDEX idx_products_battery_specs
ON products ((metadata->'specs'->'battery_hours'))
WHERE metadata->'specs'->'battery_hours' IS NOT NULL;

-- Check which indexes are actually used
SELECT
    indexrelname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE relname = 'products'
ORDER BY idx_scan DESC;
```

## Performance Comparison: PostgreSQL vs Elasticsearch

For most production use cases with under 10 million documents, PostgreSQL with proper indexing is competitive with Elasticsearch:

```sql
-- Test dataset: 1 million products
-- Load test data
INSERT INTO products (sku, name, metadata)
SELECT
    'PRD-' || i,
    (ARRAY['Wireless','Wired','USB-C','Bluetooth','4K'])[1 + (i % 5)] || ' ' ||
    (ARRAY['Headphones','Hub','Stand','Keyboard','Monitor'])[1 + ((i/5) % 5)],
    jsonb_build_object(
        'brand', (ARRAY['Sony','Anker','Logitech','Samsung','Apple'])[1 + (i % 5)],
        'price', (random() * 500)::numeric(10,2),
        'category', (ARRAY['audio','accessories','displays'])[1 + (i % 3)],
        'in_stock', (i % 7 != 0)
    )
FROM generate_series(1, 1000000) AS i;

-- Rebuild search vectors and indexes
UPDATE products
SET search_vector = (
    setweight(to_tsvector('english', name), 'A') ||
    setweight(to_tsvector('english', coalesce(metadata->>'brand', '')), 'B')
);

CREATE INDEX idx_products_search_large
ON products USING GIN (search_vector);

CREATE INDEX idx_products_metadata_large
ON products USING GIN (metadata jsonb_path_ops);

-- Analyze for query planner
ANALYZE products;
```

Benchmark query (run with `\timing` in psql):

```sql
-- Full-text + JSONB filter + ranking on 1M rows
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT sku, name, ts_rank(search_vector, q) AS rank
FROM products, to_tsquery('english', 'wireless & headphones') AS q
WHERE search_vector @@ q
  AND metadata @> '{"brand":"Sony"}'
  AND metadata @> '{"in_stock":true}'
ORDER BY rank DESC
LIMIT 20;
```

Typical results on modest hardware (4 vCPU, 16 GB RAM, SSD):
- 1M documents, complex query: **8-15ms** with warm cache
- Cold cache: **50-200ms**

Elasticsearch on equivalent hardware typically returns **5-20ms** for similar queries, but with significantly more infrastructure overhead (JVM, heap tuning, cluster management, replication lag).

**When PostgreSQL wins:**
- You already use PostgreSQL (no additional infrastructure)
- Data size under 50M documents
- Combined SQL + search queries (joins, transactions)
- ACID requirements alongside search

**When Elasticsearch is better:**
- Tens of millions of documents with complex relevance tuning
- Multi-language support with per-language analyzers
- Aggregation-heavy analytics (terms, histograms)
- Distributed indexing across many shards

## Index Maintenance

```sql
-- JSONB GIN indexes can grow large; monitor and rebuild periodically
SELECT
    pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size,
    indexname
FROM pg_indexes
WHERE tablename = 'products'
ORDER BY pg_relation_size(indexname::regclass) DESC;

-- Rebuild bloated indexes without locking
REINDEX INDEX CONCURRENTLY idx_products_search_large;

-- Check for slow queries involving JSONB
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
WHERE query LIKE '%metadata%'
  AND mean_exec_time > 100
ORDER BY mean_exec_time DESC
LIMIT 10;
```

## Summary

PostgreSQL's JSONB and full-text search capabilities form a compelling alternative to specialized document stores for many production use cases. The combination of GIN indexes on JSONB, `jsonb_path_query` for complex traversals, `tsvector` generated columns for pre-computed search vectors, and `pg_trgm` for fuzzy matching covers the majority of search requirements without introducing new infrastructure.

The key patterns to remember: use GIN indexes with `jsonb_path_ops` for pure containment queries, use the default GIN operator class when you also need key existence checks, use generated columns for `tsvector` to avoid per-row computation at query time, use `setweight` to implement relevance scoring across multiple fields, and combine JSONB containment operators with `@@` in a single WHERE clause to let PostgreSQL intersect indexes efficiently.
