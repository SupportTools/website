---
title: "Advanced Data Warehousing with Snowflake and BigQuery: Architecture, Optimization, and Best Practices"
date: 2026-03-28T00:00:00-05:00
draft: false
description: "Comprehensive guide to implementing advanced data warehousing solutions with Snowflake and BigQuery, covering architecture patterns, performance optimization, cost management, and enterprise deployment strategies."
keywords: ["data warehousing", "Snowflake", "BigQuery", "cloud data warehouse", "ETL", "data architecture", "performance optimization", "cost optimization", "data lake", "analytics"]
tags: ["data-engineering", "snowflake", "bigquery", "data-warehouse", "cloud", "analytics", "performance", "optimization"]
categories: ["Data Engineering", "Analytics", "Cloud Computing"]
author: "Support Tools Team"
canonical: "https://support.tools/blog/advanced-data-warehousing-snowflake-bigquery/"
---

# Advanced Data Warehousing with Snowflake and BigQuery: Architecture, Optimization, and Best Practices

Modern data warehousing has evolved beyond traditional on-premises solutions to embrace cloud-native architectures that offer unprecedented scalability, performance, and cost efficiency. Snowflake and Google BigQuery represent the pinnacle of cloud data warehouse technology, each offering unique advantages for different use cases and organizational requirements.

This comprehensive guide explores advanced data warehousing concepts, implementation strategies, and optimization techniques for both Snowflake and BigQuery, providing enterprise-grade solutions for modern data architecture challenges.

## Understanding Modern Data Warehouse Architecture

### Cloud-Native Data Warehouse Fundamentals

Modern cloud data warehouses fundamentally differ from traditional solutions through their separation of compute and storage, elastic scaling capabilities, and native cloud integration. This architecture enables organizations to handle massive data volumes while optimizing costs and performance.

```sql
-- Snowflake: Creating a multi-cluster warehouse with auto-scaling
CREATE WAREHOUSE analytics_warehouse WITH
  WAREHOUSE_SIZE = 'LARGE'
  AUTO_SUSPEND = 300
  AUTO_RESUME = TRUE
  MIN_CLUSTER_COUNT = 1
  MAX_CLUSTER_COUNT = 10
  SCALING_POLICY = 'STANDARD'
  COMMENT = 'Auto-scaling warehouse for analytics workloads';

-- Setting up resource monitors for cost control
CREATE RESOURCE MONITOR monthly_quota WITH
  CREDIT_QUOTA = 5000
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS
    ON 80 PERCENT DO NOTIFY
    ON 90 PERCENT DO SUSPEND
    ON 100 PERCENT DO SUSPEND_IMMEDIATE;

ALTER WAREHOUSE analytics_warehouse SET RESOURCE_MONITOR = monthly_quota;
```

### Snowflake Architecture Deep Dive

Snowflake's unique architecture consists of three distinct layers: cloud services, compute (virtual warehouses), and storage. This separation enables independent scaling and optimization of each component.

```python
# Advanced Snowflake connection and session management
import snowflake.connector
import snowflake.connector.pandas_tools as pd_tools
from snowflake.connector import DictCursor
from contextlib import contextmanager
import pandas as pd
import logging

class SnowflakeManager:
    def __init__(self, account, user, password, warehouse, database, schema):
        self.connection_params = {
            'account': account,
            'user': user,
            'password': password,
            'warehouse': warehouse,
            'database': database,
            'schema': schema,
            'autocommit': False,
            'client_session_keep_alive': True,
            'numpy': True
        }
        self.connection = None
        
    @contextmanager
    def get_connection(self):
        """Context manager for Snowflake connections with proper cleanup"""
        try:
            if not self.connection or self.connection.is_closed():
                self.connection = snowflake.connector.connect(**self.connection_params)
            yield self.connection
        except Exception as e:
            if self.connection:
                self.connection.rollback()
            logging.error(f"Snowflake connection error: {e}")
            raise
        finally:
            if self.connection and not self.connection.is_closed():
                self.connection.close()
    
    def execute_query(self, query, params=None, fetch=True):
        """Execute query with proper error handling and logging"""
        with self.get_connection() as conn:
            cursor = conn.cursor(DictCursor)
            try:
                start_time = time.time()
                if params:
                    cursor.execute(query, params)
                else:
                    cursor.execute(query)
                
                execution_time = time.time() - start_time
                logging.info(f"Query executed in {execution_time:.2f} seconds")
                
                if fetch:
                    return cursor.fetchall()
                else:
                    conn.commit()
                    return cursor.rowcount
                    
            except Exception as e:
                logging.error(f"Query execution failed: {e}")
                conn.rollback()
                raise
            finally:
                cursor.close()
    
    def bulk_load_data(self, df, table_name, method='pandas'):
        """Optimized bulk data loading strategies"""
        with self.get_connection() as conn:
            if method == 'pandas':
                # Using pandas tools for efficient loading
                success, nchunks, nrows, _ = pd_tools.write_pandas(
                    conn, df, table_name, auto_create_table=True, 
                    chunk_size=10000, compression='gzip'
                )
                logging.info(f"Loaded {nrows} rows in {nchunks} chunks")
                
            elif method == 'copy':
                # Using COPY command for large datasets
                stage_name = f"@%{table_name}"
                
                # Create temporary file stage
                cursor = conn.cursor()
                cursor.execute(f"PUT file://{df.to_csv()} {stage_name}")
                
                # Copy data using optimized settings
                copy_sql = f"""
                COPY INTO {table_name}
                FROM {stage_name}
                FILE_FORMAT = (TYPE = CSV FIELD_DELIMITER = ',' SKIP_HEADER = 1)
                ON_ERROR = 'CONTINUE'
                """
                cursor.execute(copy_sql)
                conn.commit()

# Advanced warehouse management and optimization
class WarehouseOptimizer:
    def __init__(self, snowflake_manager):
        self.sf = snowflake_manager
        
    def analyze_warehouse_usage(self, days=7):
        """Analyze warehouse usage patterns for optimization"""
        query = f"""
        SELECT 
            warehouse_name,
            start_time::date as usage_date,
            SUM(credits_used) as daily_credits,
            AVG(credits_used_compute) as avg_compute_credits,
            COUNT(*) as query_count,
            AVG(execution_time / 1000) as avg_execution_seconds
        FROM snowflake.account_usage.warehouse_metering_history
        WHERE start_time >= dateadd('day', -{days}, current_date())
        GROUP BY warehouse_name, usage_date
        ORDER BY warehouse_name, usage_date;
        """
        
        return self.sf.execute_query(query)
    
    def get_optimization_recommendations(self):
        """Generate warehouse optimization recommendations"""
        # Analyze query performance patterns
        performance_query = """
        SELECT 
            warehouse_name,
            query_type,
            AVG(execution_time) as avg_execution_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_time) as p95_execution_ms,
            COUNT(*) as query_count,
            SUM(bytes_scanned) as total_bytes_scanned
        FROM snowflake.account_usage.query_history
        WHERE start_time >= dateadd('day', -7, current_date())
        AND execution_status = 'SUCCESS'
        GROUP BY warehouse_name, query_type
        ORDER BY avg_execution_ms DESC;
        """
        
        results = self.sf.execute_query(performance_query)
        
        recommendations = []
        for row in results:
            if row['avg_execution_ms'] > 60000:  # > 1 minute
                recommendations.append({
                    'warehouse': row['warehouse_name'],
                    'issue': 'Long-running queries detected',
                    'recommendation': 'Consider increasing warehouse size or optimizing queries',
                    'details': f"Average execution: {row['avg_execution_ms']/1000:.1f}s"
                })
                
        return recommendations
```

### BigQuery Architecture and Implementation

BigQuery's serverless architecture automatically manages infrastructure scaling and optimization, allowing developers to focus on query optimization and data modeling.

```python
# Advanced BigQuery management and optimization
from google.cloud import bigquery
from google.cloud.bigquery import LoadJobConfig, QueryJobConfig
from google.cloud.bigquery.table import TimePartitioning, RangePartitioning
import pandas as pd
import time
from typing import Dict, List, Optional

class BigQueryManager:
    def __init__(self, project_id: str, location: str = 'US'):
        self.client = bigquery.Client(project=project_id, location=location)
        self.project_id = project_id
        self.location = location
        
    def create_optimized_table(self, dataset_id: str, table_id: str, 
                             schema: List[bigquery.SchemaField],
                             partition_field: Optional[str] = None,
                             cluster_fields: Optional[List[str]] = None,
                             description: str = None):
        """Create optimally configured BigQuery table"""
        
        dataset_ref = self.client.dataset(dataset_id)
        table_ref = dataset_ref.table(table_id)
        
        table = bigquery.Table(table_ref, schema=schema)
        
        # Configure partitioning
        if partition_field:
            table.time_partitioning = TimePartitioning(
                type_=TimePartitioning.DAY,
                field=partition_field,
                expiration_ms=None,  # No automatic expiration
                require_partition_filter=True
            )
            
        # Configure clustering
        if cluster_fields:
            table.clustering_fields = cluster_fields
            
        # Set table options for optimization
        table.description = description
        table.expires = None  # No expiration
        
        # Create table with optimization settings
        table = self.client.create_table(table)
        print(f"Created optimized table {table.project}.{table.dataset_id}.{table.table_id}")
        
        return table
    
    def execute_optimized_query(self, query: str, 
                               use_cache: bool = True,
                               use_legacy_sql: bool = False,
                               max_bytes_billed: Optional[int] = None,
                               labels: Optional[Dict[str, str]] = None):
        """Execute query with optimization settings"""
        
        job_config = QueryJobConfig(
            use_query_cache=use_cache,
            use_legacy_sql=use_legacy_sql,
            labels=labels or {},
            maximum_bytes_billed=max_bytes_billed
        )
        
        # Add query optimization hints
        optimized_query = self._add_optimization_hints(query)
        
        start_time = time.time()
        query_job = self.client.query(optimized_query, job_config=job_config)
        
        try:
            results = query_job.result()
            execution_time = time.time() - start_time
            
            # Log performance metrics
            bytes_processed = query_job.total_bytes_processed or 0
            bytes_billed = query_job.total_bytes_billed or 0
            
            print(f"Query completed in {execution_time:.2f}s")
            print(f"Bytes processed: {bytes_processed:,}")
            print(f"Bytes billed: {bytes_billed:,}")
            
            return results
            
        except Exception as e:
            print(f"Query failed: {e}")
            raise
    
    def _add_optimization_hints(self, query: str) -> str:
        """Add BigQuery optimization hints to queries"""
        # Add standard optimization patterns
        hints = [
            "-- Query optimized for BigQuery",
            "-- Using best practices for performance"
        ]
        
        return "\n".join(hints) + "\n" + query
    
    def analyze_table_performance(self, dataset_id: str, table_id: str):
        """Analyze table performance and optimization opportunities"""
        
        table_ref = self.client.dataset(dataset_id).table(table_id)
        table = self.client.get_table(table_ref)
        
        analysis = {
            'table_size_bytes': table.num_bytes,
            'num_rows': table.num_rows,
            'is_partitioned': table.time_partitioning is not None,
            'is_clustered': table.clustering_fields is not None,
            'clustering_fields': table.clustering_fields,
            'partition_field': table.time_partitioning.field if table.time_partitioning else None
        }
        
        # Analyze query patterns
        query_analysis = f"""
        SELECT 
            creation_time,
            project_id,
            user_email,
            query,
            total_bytes_processed,
            total_bytes_billed,
            total_slot_ms,
            total_bytes_shuffled
        FROM `{self.project_id}.region-{self.location.lower()}.INFORMATION_SCHEMA.JOBS_BY_PROJECT`
        WHERE referenced_tables LIKE '%{dataset_id}.{table_id}%'
        AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
        ORDER BY creation_time DESC
        LIMIT 100
        """
        
        query_results = self.execute_optimized_query(query_analysis)
        analysis['recent_queries'] = [dict(row) for row in query_results]
        
        return analysis
    
    def optimize_table_schema(self, dataset_id: str, table_id: str):
        """Generate schema optimization recommendations"""
        
        performance_data = self.analyze_table_performance(dataset_id, table_id)
        recommendations = []
        
        # Check partitioning
        if not performance_data['is_partitioned']:
            recommendations.append({
                'type': 'partitioning',
                'recommendation': 'Consider adding date/timestamp partitioning',
                'benefit': 'Reduced query costs and improved performance'
            })
        
        # Check clustering
        if not performance_data['is_clustered']:
            recommendations.append({
                'type': 'clustering',
                'recommendation': 'Consider adding clustering on frequently filtered columns',
                'benefit': 'Improved query performance for WHERE clauses'
            })
        
        # Analyze query patterns for optimization
        queries = performance_data['recent_queries']
        if queries:
            avg_bytes_processed = sum(q['total_bytes_processed'] or 0 for q in queries) / len(queries)
            if avg_bytes_processed > performance_data['table_size_bytes'] * 0.1:
                recommendations.append({
                    'type': 'query_optimization',
                    'recommendation': 'Queries are scanning large portions of the table',
                    'benefit': 'Optimize SELECT clauses and add WHERE filters'
                })
        
        return recommendations

# Advanced ETL pipeline implementation
class DataWarehouseETL:
    def __init__(self, source_config: Dict, target_config: Dict):
        self.source_config = source_config
        self.target_config = target_config
        
    def create_incremental_pipeline(self, source_table: str, target_table: str,
                                  timestamp_column: str, batch_size: int = 10000):
        """Create incremental data pipeline with CDC capabilities"""
        
        pipeline_sql = f"""
        -- Incremental ETL Pipeline for {target_table}
        MERGE {target_table} AS target
        USING (
            SELECT 
                *,
                CURRENT_TIMESTAMP() AS etl_processed_at,
                '{source_table}' AS source_system
            FROM {source_table}
            WHERE {timestamp_column} > (
                SELECT COALESCE(MAX({timestamp_column}), '1900-01-01')
                FROM {target_table}
            )
        ) AS source
        ON target.id = source.id
        WHEN MATCHED AND source.{timestamp_column} > target.{timestamp_column} THEN
            UPDATE SET *
        WHEN NOT MATCHED THEN
            INSERT *;
        """
        
        return pipeline_sql
    
    def implement_data_quality_checks(self, table_name: str):
        """Implement comprehensive data quality validation"""
        
        quality_checks = {
            'completeness': f"""
                SELECT 
                    '{table_name}' AS table_name,
                    'completeness' AS check_type,
                    COUNT(*) AS total_records,
                    COUNT(*) - COUNT(id) AS null_ids,
                    ROUND((COUNT(*) - COUNT(id)) / COUNT(*) * 100, 2) AS null_percentage
                FROM {table_name}
            """,
            
            'uniqueness': f"""
                SELECT 
                    '{table_name}' AS table_name,
                    'uniqueness' AS check_type,
                    COUNT(*) AS total_records,
                    COUNT(DISTINCT id) AS unique_records,
                    COUNT(*) - COUNT(DISTINCT id) AS duplicate_count
                FROM {table_name}
            """,
            
            'freshness': f"""
                SELECT 
                    '{table_name}' AS table_name,
                    'freshness' AS check_type,
                    MAX(updated_at) AS last_update,
                    CURRENT_TIMESTAMP() AS check_time,
                    TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(updated_at), HOUR) AS hours_since_update
                FROM {table_name}
            """
        }
        
        return quality_checks
```

## Performance Optimization Strategies

### Query Optimization Techniques

Advanced query optimization requires understanding the underlying execution engines and applying platform-specific best practices.

```sql
-- Snowflake: Advanced query optimization patterns
-- 1. Effective use of clustering keys
CREATE TABLE sales_fact (
    sale_date DATE,
    customer_id NUMBER,
    product_id NUMBER,
    sale_amount DECIMAL(10,2),
    region_id NUMBER
)
CLUSTER BY (sale_date, customer_id);

-- 2. Optimized JOIN patterns
WITH customer_segments AS (
    SELECT 
        customer_id,
        CASE 
            WHEN total_purchases > 10000 THEN 'VIP'
            WHEN total_purchases > 5000 THEN 'Premium'
            ELSE 'Standard'
        END AS segment,
        last_purchase_date
    FROM customer_summary
    WHERE last_purchase_date >= DATEADD('month', -12, CURRENT_DATE())
),
sales_with_segments AS (
    SELECT 
        s.sale_date,
        s.customer_id,
        s.sale_amount,
        cs.segment,
        s.product_id
    FROM sales_fact s
    INNER JOIN customer_segments cs ON s.customer_id = cs.customer_id
    WHERE s.sale_date >= DATEADD('month', -3, CURRENT_DATE())
)
SELECT 
    segment,
    DATE_TRUNC('month', sale_date) AS month,
    SUM(sale_amount) AS total_sales,
    COUNT(DISTINCT customer_id) AS unique_customers,
    AVG(sale_amount) AS avg_order_value
FROM sales_with_segments
GROUP BY segment, DATE_TRUNC('month', sale_date)
ORDER BY month DESC, total_sales DESC;

-- BigQuery: Optimized query patterns
-- 1. Effective partitioning and clustering usage
CREATE TABLE `project.dataset.sales_optimized`
PARTITION BY DATE(sale_timestamp)
CLUSTER BY customer_id, product_category
AS
SELECT 
    sale_timestamp,
    customer_id,
    product_category,
    sale_amount,
    region
FROM `project.dataset.raw_sales`
WHERE sale_timestamp >= DATE_SUB(CURRENT_DATE(), INTERVAL 2 YEAR);

-- 2. Advanced analytical functions
WITH daily_metrics AS (
    SELECT 
        DATE(sale_timestamp) AS sale_date,
        customer_id,
        SUM(sale_amount) AS daily_total,
        COUNT(*) AS transaction_count,
        -- Window functions for advanced analytics
        LAG(SUM(sale_amount)) OVER (
            PARTITION BY customer_id 
            ORDER BY DATE(sale_timestamp)
        ) AS previous_day_total,
        -- Moving averages
        AVG(SUM(sale_amount)) OVER (
            PARTITION BY customer_id 
            ORDER BY DATE(sale_timestamp)
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS seven_day_avg
    FROM `project.dataset.sales_optimized`
    WHERE sale_timestamp >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
    AND _PARTITIONTIME >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
    GROUP BY sale_date, customer_id
),
customer_insights AS (
    SELECT 
        customer_id,
        -- Advanced aggregations
        AVG(daily_total) AS avg_daily_spend,
        STDDEV(daily_total) AS spend_volatility,
        MAX(daily_total) AS max_daily_spend,
        -- Percentile calculations
        PERCENTILE_CONT(daily_total, 0.5) OVER (PARTITION BY customer_id) AS median_spend,
        -- Growth calculations
        SAFE_DIVIDE(
            SUM(CASE WHEN sale_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) 
                     THEN daily_total END),
            SUM(CASE WHEN sale_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)
                     AND DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
                     THEN daily_total END)
        ) AS growth_rate
    FROM daily_metrics
    GROUP BY customer_id
)
SELECT 
    customer_id,
    avg_daily_spend,
    spend_volatility,
    growth_rate,
    CASE 
        WHEN growth_rate > 1.2 THEN 'Growing'
        WHEN growth_rate BETWEEN 0.8 AND 1.2 THEN 'Stable'
        ELSE 'Declining'
    END AS customer_trend
FROM customer_insights
WHERE avg_daily_spend IS NOT NULL
ORDER BY avg_daily_spend DESC;
```

### Cost Optimization Strategies

```python
# Advanced cost optimization and monitoring
class CostOptimizer:
    def __init__(self, platform='snowflake'):
        self.platform = platform
        
    def analyze_query_costs(self, queries_df):
        """Analyze and optimize query costs"""
        
        # Calculate cost metrics
        if self.platform == 'snowflake':
            # Snowflake credit-based pricing
            cost_per_credit = 2.0  # Example rate
            queries_df['estimated_cost'] = (
                queries_df['execution_time_ms'] / 1000 / 3600 *  # Convert to hours
                queries_df['warehouse_size_factor'] *  # Size multiplier
                cost_per_credit
            )
            
        elif self.platform == 'bigquery':
            # BigQuery bytes-processed pricing
            cost_per_tb = 5.0  # USD per TB
            queries_df['estimated_cost'] = (
                queries_df['bytes_processed'] / (1024**4) *  # Convert to TB
                cost_per_tb
            )
        
        # Identify optimization opportunities
        expensive_queries = queries_df[
            queries_df['estimated_cost'] > queries_df['estimated_cost'].quantile(0.9)
        ]
        
        return {
            'total_cost': queries_df['estimated_cost'].sum(),
            'avg_cost': queries_df['estimated_cost'].mean(),
            'expensive_queries': expensive_queries,
            'optimization_potential': self._identify_optimizations(expensive_queries)
        }
    
    def _identify_optimizations(self, expensive_queries):
        """Identify specific optimization opportunities"""
        optimizations = []
        
        for _, query in expensive_queries.iterrows():
            if query.get('full_table_scan', False):
                optimizations.append({
                    'query_id': query['query_id'],
                    'issue': 'Full table scan detected',
                    'recommendation': 'Add WHERE clauses or improve partitioning',
                    'potential_savings': query['estimated_cost'] * 0.7
                })
                
            if query.get('large_result_set', False):
                optimizations.append({
                    'query_id': query['query_id'],
                    'issue': 'Large result set',
                    'recommendation': 'Use LIMIT or aggregate results',
                    'potential_savings': query['estimated_cost'] * 0.3
                })
        
        return optimizations

# Automated warehouse management
class AutomatedWarehouseManager:
    def __init__(self, platform_manager):
        self.manager = platform_manager
        
    def auto_scale_warehouses(self):
        """Implement intelligent warehouse auto-scaling"""
        
        if isinstance(self.manager, SnowflakeManager):
            # Snowflake auto-scaling logic
            usage_data = self.manager.analyze_warehouse_usage()
            
            for warehouse_usage in usage_data:
                avg_queue_time = warehouse_usage.get('avg_queue_time', 0)
                utilization = warehouse_usage.get('utilization', 0)
                
                if avg_queue_time > 10:  # seconds
                    # Scale up
                    self._scale_warehouse(warehouse_usage['warehouse_name'], 'up')
                elif utilization < 0.2:  # 20% utilization
                    # Scale down
                    self._scale_warehouse(warehouse_usage['warehouse_name'], 'down')
    
    def _scale_warehouse(self, warehouse_name, direction):
        """Scale warehouse up or down based on usage patterns"""
        
        size_mapping = {
            'X-SMALL': {'up': 'SMALL', 'down': 'X-SMALL'},
            'SMALL': {'up': 'MEDIUM', 'down': 'X-SMALL'},
            'MEDIUM': {'up': 'LARGE', 'down': 'SMALL'},
            'LARGE': {'up': 'X-LARGE', 'down': 'MEDIUM'},
            'X-LARGE': {'up': '2X-LARGE', 'down': 'LARGE'}
        }
        
        # Get current size
        current_size_query = f"""
        SHOW WAREHOUSES LIKE '{warehouse_name}';
        """
        
        current_info = self.manager.execute_query(current_size_query)
        current_size = current_info[0]['size']
        
        if current_size in size_mapping:
            new_size = size_mapping[current_size][direction]
            
            alter_query = f"""
            ALTER WAREHOUSE {warehouse_name} SET WAREHOUSE_SIZE = '{new_size}';
            """
            
            self.manager.execute_query(alter_query, fetch=False)
            print(f"Scaled {warehouse_name} from {current_size} to {new_size}")
```

## Advanced Data Modeling and Architecture

### Dimensional Modeling Best Practices

```sql
-- Advanced dimensional modeling for analytics
-- Fact table with multiple grain levels
CREATE TABLE fact_sales_detail (
    -- Surrogate keys
    sale_detail_key BIGINT IDENTITY(1,1) PRIMARY KEY,
    
    -- Foreign keys
    date_key INT NOT NULL,
    customer_key INT NOT NULL,
    product_key INT NOT NULL,
    store_key INT NOT NULL,
    promotion_key INT,
    
    -- Degenerate dimensions
    order_number VARCHAR(50) NOT NULL,
    line_item_number INT NOT NULL,
    
    -- Measures
    quantity_sold DECIMAL(10,2) NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    extended_amount DECIMAL(12,2) NOT NULL,
    cost_amount DECIMAL(12,2) NOT NULL,
    profit_amount DECIMAL(12,2) NOT NULL,
    
    -- Audit columns
    record_created_date TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    record_updated_date TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    etl_batch_id BIGINT,
    
    -- Constraints
    CONSTRAINT fk_sales_date FOREIGN KEY (date_key) REFERENCES dim_date(date_key),
    CONSTRAINT fk_sales_customer FOREIGN KEY (customer_key) REFERENCES dim_customer(customer_key),
    CONSTRAINT fk_sales_product FOREIGN KEY (product_key) REFERENCES dim_product(product_key),
    CONSTRAINT fk_sales_store FOREIGN KEY (store_key) REFERENCES dim_store(store_key)
)
CLUSTER BY (date_key, customer_key);

-- Slowly Changing Dimension Type 2 implementation
CREATE TABLE dim_customer (
    customer_key BIGINT IDENTITY(1,1) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL,
    
    -- Customer attributes
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(20),
    
    -- Address information
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state_province VARCHAR(50),
    postal_code VARCHAR(20),
    country VARCHAR(50),
    
    -- Customer segment
    customer_segment VARCHAR(50),
    preferred_contact_method VARCHAR(20),
    
    -- SCD Type 2 columns
    effective_start_date DATE NOT NULL,
    effective_end_date DATE,
    is_current_record BOOLEAN DEFAULT TRUE,
    
    -- Audit columns
    record_created_date TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    record_updated_date TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    source_system VARCHAR(50),
    etl_batch_id BIGINT
)
CLUSTER BY (customer_id, effective_start_date);

-- Advanced aggregation tables for performance
CREATE TABLE agg_sales_by_month (
    date_key INT NOT NULL,
    year_month VARCHAR(7) NOT NULL,
    customer_segment VARCHAR(50),
    product_category VARCHAR(100),
    region VARCHAR(100),
    
    -- Aggregated measures
    total_sales_amount DECIMAL(18,2),
    total_cost_amount DECIMAL(18,2),
    total_profit_amount DECIMAL(18,2),
    total_quantity_sold DECIMAL(15,2),
    
    -- Statistical measures
    avg_order_value DECIMAL(10,2),
    median_order_value DECIMAL(10,2),
    order_count BIGINT,
    customer_count BIGINT,
    
    -- Performance measures
    profit_margin_pct DECIMAL(5,2),
    growth_rate_mom DECIMAL(8,4),
    
    -- Audit
    aggregation_date TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    etl_batch_id BIGINT,
    
    PRIMARY KEY (date_key, customer_segment, product_category, region)
)
CLUSTER BY (date_key, customer_segment);
```

### Data Vault 2.0 Implementation

```sql
-- Data Vault 2.0 implementation for enterprise data warehousing
-- Hub tables for business keys
CREATE TABLE hub_customer (
    customer_hub_key BINARY(16) NOT NULL,  -- SHA-1 hash of business key
    customer_id VARCHAR(50) NOT NULL,      -- Business key
    load_timestamp TIMESTAMP_NTZ NOT NULL,
    record_source VARCHAR(50) NOT NULL,
    
    PRIMARY KEY (customer_hub_key),
    UNIQUE (customer_id)
);

CREATE TABLE hub_product (
    product_hub_key BINARY(16) NOT NULL,
    product_code VARCHAR(50) NOT NULL,
    load_timestamp TIMESTAMP_NTZ NOT NULL,
    record_source VARCHAR(50) NOT NULL,
    
    PRIMARY KEY (product_hub_key),
    UNIQUE (product_code)
);

-- Link table for relationships
CREATE TABLE link_customer_order (
    customer_order_link_key BINARY(16) NOT NULL,  -- Hash of all foreign keys
    customer_hub_key BINARY(16) NOT NULL,
    order_hub_key BINARY(16) NOT NULL,
    load_timestamp TIMESTAMP_NTZ NOT NULL,
    record_source VARCHAR(50) NOT NULL,
    
    PRIMARY KEY (customer_order_link_key),
    FOREIGN KEY (customer_hub_key) REFERENCES hub_customer(customer_hub_key),
    FOREIGN KEY (order_hub_key) REFERENCES hub_order(order_hub_key)
);

-- Satellite tables for descriptive data
CREATE TABLE sat_customer_details (
    customer_hub_key BINARY(16) NOT NULL,
    load_timestamp TIMESTAMP_NTZ NOT NULL,
    load_end_timestamp TIMESTAMP_NTZ,
    
    -- Customer attributes
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(20),
    birth_date DATE,
    gender VARCHAR(10),
    
    -- Address information
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state_province VARCHAR(50),
    postal_code VARCHAR(20),
    country VARCHAR(50),
    
    -- Metadata
    record_source VARCHAR(50) NOT NULL,
    hash_diff BINARY(16) NOT NULL,  -- Hash of all descriptive data
    
    PRIMARY KEY (customer_hub_key, load_timestamp),
    FOREIGN KEY (customer_hub_key) REFERENCES hub_customer(customer_hub_key)
);

-- Business vault - calculated and derived data
CREATE TABLE business_vault_customer_metrics (
    customer_hub_key BINARY(16) NOT NULL,
    calculation_timestamp TIMESTAMP_NTZ NOT NULL,
    
    -- Calculated metrics
    lifetime_value DECIMAL(12,2),
    total_orders BIGINT,
    total_spent DECIMAL(12,2),
    avg_order_value DECIMAL(10,2),
    days_since_last_order INT,
    customer_segment VARCHAR(50),
    churn_probability DECIMAL(5,4),
    
    -- Metadata
    calculation_batch_id BIGINT,
    record_source VARCHAR(50),
    
    PRIMARY KEY (customer_hub_key, calculation_timestamp),
    FOREIGN KEY (customer_hub_key) REFERENCES hub_customer(customer_hub_key)
);
```

## Enterprise Integration and Governance

### Data Governance Implementation

```python
# Comprehensive data governance framework
class DataGovernanceFramework:
    def __init__(self, catalog_config):
        self.catalog_config = catalog_config
        
    def implement_data_lineage(self, source_table, target_table, transformation_logic):
        """Track data lineage for governance and compliance"""
        
        lineage_record = {
            'lineage_id': self._generate_lineage_id(),
            'source_system': source_table['system'],
            'source_table': source_table['table_name'],
            'target_system': target_table['system'],
            'target_table': target_table['table_name'],
            'transformation_type': transformation_logic['type'],
            'transformation_code': transformation_logic['code'],
            'business_owner': source_table.get('business_owner'),
            'technical_owner': source_table.get('technical_owner'),
            'data_classification': source_table.get('classification', 'Internal'),
            'retention_policy': source_table.get('retention_days'),
            'created_timestamp': datetime.now(),
            'lineage_level': self._calculate_lineage_level(source_table)
        }
        
        self._store_lineage_record(lineage_record)
        return lineage_record
    
    def implement_data_quality_monitoring(self, table_config):
        """Implement comprehensive data quality monitoring"""
        
        quality_rules = {
            'completeness': {
                'null_threshold': table_config.get('null_threshold', 0.05),
                'required_fields': table_config.get('required_fields', [])
            },
            'accuracy': {
                'valid_ranges': table_config.get('valid_ranges', {}),
                'referential_integrity': table_config.get('foreign_keys', [])
            },
            'consistency': {
                'format_patterns': table_config.get('format_patterns', {}),
                'business_rules': table_config.get('business_rules', [])
            },
            'timeliness': {
                'max_delay_hours': table_config.get('max_delay_hours', 24),
                'expected_frequency': table_config.get('frequency', 'daily')
            }
        }
        
        return self._create_quality_monitors(quality_rules)
    
    def implement_access_controls(self, user_role, data_classification):
        """Implement role-based access controls"""
        
        access_matrix = {
            'public': ['analyst', 'data_scientist', 'business_user', 'admin'],
            'internal': ['analyst', 'data_scientist', 'admin'],
            'confidential': ['senior_analyst', 'admin'],
            'restricted': ['admin']
        }
        
        permissions = {
            'can_read': user_role in access_matrix.get(data_classification, []),
            'can_write': user_role in ['admin'],
            'can_delete': user_role in ['admin'],
            'can_export': user_role in access_matrix.get(data_classification, []) and data_classification != 'restricted',
            'requires_approval': data_classification in ['confidential', 'restricted']
        }
        
        return permissions

# Advanced monitoring and alerting
class DataWarehouseMonitoring:
    def __init__(self, platform_managers):
        self.platforms = platform_managers
        self.alert_thresholds = {
            'query_duration_minutes': 30,
            'cost_increase_percent': 50,
            'error_rate_percent': 5,
            'data_freshness_hours': 25
        }
    
    def monitor_platform_health(self):
        """Comprehensive platform health monitoring"""
        
        health_metrics = {}
        
        for platform_name, manager in self.platforms.items():
            metrics = self._collect_platform_metrics(platform_name, manager)
            health_metrics[platform_name] = metrics
            
            # Check for alerts
            alerts = self._check_alert_conditions(platform_name, metrics)
            if alerts:
                self._send_alerts(platform_name, alerts)
        
        return health_metrics
    
    def _collect_platform_metrics(self, platform_name, manager):
        """Collect comprehensive metrics from each platform"""
        
        if platform_name == 'snowflake':
            return self._collect_snowflake_metrics(manager)
        elif platform_name == 'bigquery':
            return self._collect_bigquery_metrics(manager)
    
    def _collect_snowflake_metrics(self, sf_manager):
        """Collect Snowflake-specific metrics"""
        
        metrics_query = """
        WITH recent_queries AS (
            SELECT 
                query_id,
                query_text,
                user_name,
                warehouse_name,
                execution_status,
                execution_time,
                bytes_scanned,
                credits_used_cloud_services,
                start_time,
                end_time
            FROM snowflake.account_usage.query_history
            WHERE start_time >= DATEADD('hour', -1, CURRENT_TIMESTAMP())
        ),
        warehouse_usage AS (
            SELECT 
                warehouse_name,
                SUM(credits_used) as total_credits,
                AVG(credits_used) as avg_credits,
                COUNT(*) as query_count
            FROM snowflake.account_usage.warehouse_metering_history
            WHERE start_time >= DATEADD('hour', -1, CURRENT_TIMESTAMP())
            GROUP BY warehouse_name
        )
        SELECT 
            'query_metrics' as metric_type,
            COUNT(*) as total_queries,
            AVG(execution_time) as avg_execution_time,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_time) as p95_execution_time,
            SUM(CASE WHEN execution_status = 'FAILED' THEN 1 ELSE 0 END) as failed_queries,
            SUM(credits_used_cloud_services) as total_cloud_services_credits
        FROM recent_queries
        UNION ALL
        SELECT 
            'warehouse_metrics' as metric_type,
            COUNT(DISTINCT warehouse_name) as active_warehouses,
            SUM(total_credits) as total_credits_used,
            AVG(avg_credits) as avg_credits_per_warehouse,
            SUM(query_count) as total_warehouse_queries,
            NULL as cloud_services_credits
        FROM warehouse_usage;
        """
        
        return sf_manager.execute_query(metrics_query)
    
    def _check_alert_conditions(self, platform_name, metrics):
        """Check metrics against alert thresholds"""
        
        alerts = []
        
        for metric in metrics:
            if metric.get('avg_execution_time', 0) > self.alert_thresholds['query_duration_minutes'] * 60000:
                alerts.append({
                    'type': 'performance',
                    'message': f'High average query duration detected: {metric["avg_execution_time"]/60000:.1f} minutes',
                    'severity': 'warning'
                })
            
            error_rate = metric.get('failed_queries', 0) / max(metric.get('total_queries', 1), 1) * 100
            if error_rate > self.alert_thresholds['error_rate_percent']:
                alerts.append({
                    'type': 'reliability',
                    'message': f'High error rate detected: {error_rate:.1f}%',
                    'severity': 'critical'
                })
        
        return alerts
```

## Conclusion

Advanced data warehousing with Snowflake and BigQuery requires a comprehensive understanding of cloud-native architectures, optimization techniques, and enterprise governance requirements. The implementations shown in this guide provide a foundation for building scalable, cost-effective, and high-performance data warehouse solutions.

Key takeaways for successful data warehouse implementation include:

1. **Architecture Design**: Leverage the unique strengths of each platform - Snowflake's multi-cluster compute architecture and BigQuery's serverless scalability
2. **Performance Optimization**: Implement proper partitioning, clustering, and query optimization techniques specific to each platform
3. **Cost Management**: Use automated monitoring and optimization to control costs while maintaining performance
4. **Data Governance**: Implement comprehensive governance frameworks for lineage, quality, and access control
5. **Monitoring and Alerting**: Establish proactive monitoring to ensure system health and performance

By following these advanced patterns and best practices, organizations can build world-class data warehouse solutions that scale with their analytics needs while maintaining operational excellence and cost efficiency.