---
title: "Time Series Database Optimization: InfluxDB vs TimescaleDB vs ClickHouse"
date: 2026-12-04T00:00:00-05:00
draft: false
tags: ["InfluxDB", "TimescaleDB", "ClickHouse", "Time Series", "Database Optimization", "Performance Tuning", "Monitoring", "IoT", "Analytics"]
categories:
- Time Series Databases
- Database Optimization
- Performance Tuning
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison and optimization guide for InfluxDB, TimescaleDB, and ClickHouse. Learn architecture differences, performance tuning, query optimization, and production deployment strategies for time series workloads."
more_link: "yes"
url: "/time-series-database-optimization-influxdb-timescaledb-clickhouse/"
---

Time series databases have become critical infrastructure for modern applications handling IoT data, monitoring metrics, financial data, and real-time analytics. This comprehensive guide compares InfluxDB, TimescaleDB, and ClickHouse, providing detailed optimization strategies, performance analysis, and production deployment patterns for each platform.

<!--more-->

# Time Series Database Optimization: InfluxDB vs TimescaleDB vs ClickHouse

## Time Series Database Fundamentals

Time series databases are specialized systems designed to efficiently store, query, and analyze time-stamped data. Unlike traditional relational databases, they are optimized for high write throughput, time-based queries, and data compression.

### Key Characteristics of Time Series Data

```python
# time_series_patterns.py
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import asyncio
import aiohttp
from typing import List, Dict, Optional, Tuple
import json

class TimeSeriesDataGenerator:
    """Generate realistic time series data for testing"""
    
    def __init__(self, metrics: List[str], devices: List[str]):
        self.metrics = metrics
        self.devices = devices
        self.base_time = datetime.now() - timedelta(days=30)
    
    def generate_iot_metrics(self, 
                           duration_hours: int = 24, 
                           interval_seconds: int = 30) -> pd.DataFrame:
        """Generate IoT sensor data"""
        
        total_points = duration_hours * 3600 // interval_seconds
        timestamps = [
            self.base_time + timedelta(seconds=i * interval_seconds)
            for i in range(total_points)
        ]
        
        data = []
        
        for device in self.devices:
            device_offset = hash(device) % 100  # Consistent offset per device
            
            for metric in self.metrics:
                base_value = self._get_base_value(metric)
                
                for i, timestamp in enumerate(timestamps):
                    # Add trends and seasonality
                    trend = i * 0.001  # Slow trend
                    seasonal = np.sin(2 * np.pi * i / (24 * 3600 / interval_seconds)) * 0.1
                    noise = np.random.normal(0, 0.05)
                    
                    value = base_value + device_offset + trend + seasonal + noise
                    
                    # Add occasional spikes
                    if np.random.random() < 0.01:  # 1% spike probability
                        value *= (1 + np.random.uniform(0.5, 2.0))
                    
                    data.append({
                        'timestamp': timestamp,
                        'device_id': device,
                        'metric': metric,
                        'value': round(value, 3),
                        'location': f'region_{device_offset % 5}',
                        'status': 'active' if np.random.random() > 0.02 else 'warning'
                    })
        
        return pd.DataFrame(data)
    
    def generate_financial_data(self, 
                               symbols: List[str], 
                               duration_days: int = 30) -> pd.DataFrame:
        """Generate financial time series data"""
        
        data = []
        
        for symbol in symbols:
            current_price = 100 + hash(symbol) % 400  # Base price
            
            for day in range(duration_days):
                date = self.base_time + timedelta(days=day)
                
                # Generate OHLC data with random walk
                open_price = current_price
                
                # Daily price movements
                returns = np.random.normal(0.001, 0.02)  # Small daily returns with volatility
                close_price = open_price * (1 + returns)
                
                # High and low prices
                high_price = max(open_price, close_price) * (1 + abs(np.random.normal(0, 0.01)))
                low_price = min(open_price, close_price) * (1 - abs(np.random.normal(0, 0.01)))
                
                # Volume with some correlation to price movement
                volume = int(1000000 * (1 + abs(returns) * 10) * np.random.uniform(0.5, 1.5))
                
                data.append({
                    'timestamp': date,
                    'symbol': symbol,
                    'open': round(open_price, 2),
                    'high': round(high_price, 2),
                    'low': round(low_price, 2),
                    'close': round(close_price, 2),
                    'volume': volume,
                    'market_cap': volume * close_price
                })
                
                current_price = close_price
        
        return pd.DataFrame(data)
    
    def generate_application_metrics(self, 
                                   services: List[str], 
                                   duration_hours: int = 24) -> pd.DataFrame:
        """Generate application monitoring metrics"""
        
        data = []
        interval_seconds = 60  # 1-minute intervals
        
        for service in services:
            base_response_time = 50 + hash(service) % 200  # Base response time in ms
            base_cpu = 20 + hash(service) % 40  # Base CPU percentage
            base_memory = 1000 + hash(service) % 3000  # Base memory in MB
            
            for minute in range(duration_hours * 60):
                timestamp = self.base_time + timedelta(minutes=minute)
                
                # Add time-of-day patterns
                hour_of_day = timestamp.hour
                load_multiplier = 1.0
                
                if 9 <= hour_of_day <= 17:  # Business hours
                    load_multiplier = 1.5
                elif 0 <= hour_of_day <= 6:  # Night time
                    load_multiplier = 0.5
                
                # Response time with load and noise
                response_time = base_response_time * load_multiplier * (1 + np.random.normal(0, 0.3))
                response_time = max(1, response_time)  # Minimum 1ms
                
                # CPU usage
                cpu_usage = base_cpu * load_multiplier * (1 + np.random.normal(0, 0.2))
                cpu_usage = np.clip(cpu_usage, 0, 100)
                
                # Memory usage (more stable)
                memory_usage = base_memory * (1 + np.random.normal(0, 0.1))
                memory_usage = max(100, memory_usage)
                
                # Error rate (correlated with load)
                error_rate = max(0, np.random.normal(0.01 * load_multiplier, 0.005))
                
                # Request count
                request_count = int(100 * load_multiplier * (1 + np.random.normal(0, 0.3)))
                request_count = max(1, request_count)
                
                data.append({
                    'timestamp': timestamp,
                    'service': service,
                    'response_time_ms': round(response_time, 1),
                    'cpu_percent': round(cpu_usage, 1),
                    'memory_mb': round(memory_usage, 1),
                    'error_rate': round(error_rate, 4),
                    'request_count': request_count,
                    'load_multiplier': round(load_multiplier, 2)
                })
        
        return pd.DataFrame(data)
    
    def _get_base_value(self, metric: str) -> float:
        """Get base value for different metrics"""
        metric_bases = {
            'temperature': 20.0,
            'humidity': 50.0,
            'pressure': 1013.25,
            'voltage': 3.3,
            'current': 0.5,
            'power': 1.65,
            'cpu_temp': 45.0,
            'rpm': 1500.0
        }
        return metric_bases.get(metric, 50.0)

# Usage example
generator = TimeSeriesDataGenerator(
    metrics=['temperature', 'humidity', 'pressure'],
    devices=[f'sensor_{i:03d}' for i in range(100)]
)

iot_data = generator.generate_iot_metrics(duration_hours=24, interval_seconds=30)
financial_data = generator.generate_financial_data(['AAPL', 'GOOGL', 'MSFT', 'AMZN'], duration_days=30)
app_metrics = generator.generate_application_metrics(['web-api', 'user-service', 'payment-service'], duration_hours=24)
```

## InfluxDB Optimization

### InfluxDB Configuration and Schema Design

```python
# influxdb_optimization.py
from influxdb_client import InfluxDBClient, Point, WriteOptions
from influxdb_client.client.write_api import SYNCHRONOUS, ASYNCHRONOUS
import asyncio
import pandas as pd
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import logging

class OptimizedInfluxDBClient:
    """Optimized InfluxDB client with best practices"""
    
    def __init__(self, 
                 url: str, 
                 token: str, 
                 org: str, 
                 bucket: str,
                 batch_size: int = 5000,
                 flush_interval: int = 10000):
        self.client = InfluxDBClient(url=url, token=token, org=org)
        self.bucket = bucket
        self.org = org
        
        # Optimized write options
        self.write_api = self.client.write_api(
            write_options=WriteOptions(
                batch_size=batch_size,
                flush_interval=flush_interval,
                jitter_interval=2000,
                retry_interval=5000,
                max_retry_time=180000,
                exponential_base=2
            )
        )
        
        self.query_api = self.client.query_api()
    
    def write_dataframe_optimized(self, 
                                 df: pd.DataFrame, 
                                 measurement: str,
                                 tag_columns: List[str],
                                 field_columns: List[str],
                                 time_column: str = 'timestamp') -> None:
        """Write DataFrame to InfluxDB with optimal performance"""
        
        # Convert DataFrame to Point objects efficiently
        points = []
        
        for _, row in df.iterrows():
            point = Point(measurement)
            
            # Add timestamp
            point.time(row[time_column])
            
            # Add tags (indexed, low cardinality)
            for tag_col in tag_columns:
                if pd.notna(row[tag_col]):
                    point.tag(tag_col, str(row[tag_col]))
            
            # Add fields (not indexed, high cardinality OK)
            for field_col in field_columns:
                if pd.notna(row[field_col]):
                    value = row[field_col]
                    # Handle different data types
                    if isinstance(value, (int, float)):
                        point.field(field_col, value)
                    elif isinstance(value, bool):
                        point.field(field_col, value)
                    else:
                        point.field(field_col, str(value))
            
            points.append(point)
        
        # Write points in batches
        self.write_api.write(bucket=self.bucket, record=points)
        logging.info(f"Written {len(points)} points to measurement '{measurement}'")
    
    def create_optimized_schema(self, measurements: Dict[str, Dict]) -> None:
        """Create optimized schema with proper retention policies"""
        
        for measurement_name, config in measurements.items():
            # Create retention policy if specified
            if 'retention_policy' in config:
                rp_config = config['retention_policy']
                self._create_retention_policy(
                    name=rp_config['name'],
                    duration=rp_config['duration'],
                    replication=rp_config.get('replication', 1),
                    shard_duration=rp_config.get('shard_duration', '1w')
                )
    
    def _create_retention_policy(self, 
                               name: str, 
                               duration: str, 
                               replication: int = 1,
                               shard_duration: str = '1w') -> None:
        """Create retention policy for data lifecycle management"""
        
        # Note: InfluxDB 2.0 uses buckets instead of retention policies
        # This is more relevant for InfluxDB 1.x
        query = f'''
        CREATE RETENTION POLICY "{name}" ON "{self.bucket}" 
        DURATION {duration} 
        REPLICATION {replication} 
        SHARD DURATION {shard_duration}
        '''
        
        try:
            self.query_api.query(query)
            logging.info(f"Created retention policy: {name}")
        except Exception as e:
            logging.warning(f"Could not create retention policy {name}: {e}")
    
    def execute_optimized_query(self, 
                              flux_query: str, 
                              start_time: datetime,
                              stop_time: Optional[datetime] = None) -> pd.DataFrame:
        """Execute optimized Flux query"""
        
        if stop_time is None:
            stop_time = datetime.now()
        
        # Add time range to query if not present
        if '|> range(' not in flux_query:
            time_range = f'|> range(start: {start_time.isoformat()}, stop: {stop_time.isoformat()})'
            flux_query = flux_query.replace('from(bucket:', f'from(bucket:') + f'\n  {time_range}'
        
        result = self.query_api.query_data_frame(flux_query)
        
        if isinstance(result, list) and len(result) > 0:
            return pd.concat(result, ignore_index=True)
        elif isinstance(result, pd.DataFrame):
            return result
        else:
            return pd.DataFrame()
    
    def get_cardinality_stats(self) -> Dict[str, int]:
        """Get cardinality statistics for optimization"""
        
        cardinality_query = f'''
        import "influxdata/influxdb/schema"
        
        schema.measurements(bucket: "{self.bucket}")
        '''
        
        try:
            result = self.query_api.query_data_frame(cardinality_query)
            return {"measurements": len(result) if not result.empty else 0}
        except Exception as e:
            logging.error(f"Could not get cardinality stats: {e}")
            return {}
    
    def optimize_continuous_queries(self) -> None:
        """Create continuous queries for common aggregations"""
        
        # Example: Create downsampled data for faster long-term queries
        downsample_queries = [
            {
                'name': 'mean_5m',
                'query': '''
                from(bucket: "{bucket}")
                  |> range(start: -1h)
                  |> filter(fn: (r) => r._measurement == "iot_metrics")
                  |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
                  |> to(bucket: "{bucket}_5m")
                ''',
                'schedule': '5m'
            },
            {
                'name': 'mean_1h',
                'query': '''
                from(bucket: "{bucket}")
                  |> range(start: -24h)
                  |> filter(fn: (r) => r._measurement == "iot_metrics")
                  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
                  |> to(bucket: "{bucket}_1h")
                ''',
                'schedule': '1h'
            }
        ]
        
        for cq in downsample_queries:
            query = cq['query'].format(bucket=self.bucket)
            logging.info(f"Continuous query created: {cq['name']}")
            # Note: InfluxDB 2.0 uses tasks instead of continuous queries
    
    def close(self):
        """Close the client connection"""
        self.write_api.close()
        self.client.close()

# InfluxDB query optimization examples
class InfluxDBQueryOptimizer:
    """Optimize InfluxDB queries for better performance"""
    
    @staticmethod
    def optimize_time_range_query(measurement: str, 
                                start_time: str, 
                                end_time: str,
                                tags: Dict[str, str] = None,
                                fields: List[str] = None) -> str:
        """Create optimized time range query"""
        
        query = f'''
        from(bucket: "your_bucket")
          |> range(start: {start_time}, stop: {end_time})
          |> filter(fn: (r) => r._measurement == "{measurement}")
        '''
        
        # Add tag filters (applied early for efficiency)
        if tags:
            for tag_key, tag_value in tags.items():
                query += f'\n  |> filter(fn: (r) => r.{tag_key} == "{tag_value}")'
        
        # Add field filters
        if fields:
            field_filter = ' or '.join([f'r._field == "{field}"' for field in fields])
            query += f'\n  |> filter(fn: (r) => {field_filter})'
        
        return query
    
    @staticmethod
    def create_aggregation_query(measurement: str,
                               window: str,
                               aggregation_func: str = 'mean',
                               group_by: List[str] = None) -> str:
        """Create optimized aggregation query"""
        
        query = f'''
        from(bucket: "your_bucket")
          |> range(start: -24h)
          |> filter(fn: (r) => r._measurement == "{measurement}")
          |> aggregateWindow(every: {window}, fn: {aggregation_func}, createEmpty: false)
        '''
        
        if group_by:
            group_columns = ', '.join([f'"{col}"' for col in group_by])
            query += f'\n  |> group(columns: [{group_columns}])'
        
        return query
    
    @staticmethod
    def create_downsampling_query(source_bucket: str,
                                dest_bucket: str,
                                measurement: str,
                                window: str) -> str:
        """Create query for data downsampling"""
        
        return f'''
        from(bucket: "{source_bucket}")
          |> range(start: -1h)
          |> filter(fn: (r) => r._measurement == "{measurement}")
          |> aggregateWindow(every: {window}, fn: mean, createEmpty: false)
          |> to(bucket: "{dest_bucket}")
        '''

# Example usage and performance testing
def test_influxdb_performance():
    """Test InfluxDB performance with optimizations"""
    
    client = OptimizedInfluxDBClient(
        url="http://localhost:8086",
        token="your-token",
        org="your-org",
        bucket="test-bucket",
        batch_size=10000,
        flush_interval=5000
    )
    
    # Generate test data
    generator = TimeSeriesDataGenerator(
        metrics=['temperature', 'humidity', 'pressure'],
        devices=[f'sensor_{i:03d}' for i in range(1000)]
    )
    
    test_data = generator.generate_iot_metrics(duration_hours=24, interval_seconds=30)
    
    # Write performance test
    import time
    start_time = time.time()
    
    client.write_dataframe_optimized(
        df=test_data,
        measurement='iot_metrics',
        tag_columns=['device_id', 'location', 'status'],
        field_columns=['value'],
        time_column='timestamp'
    )
    
    write_time = time.time() - start_time
    points_per_second = len(test_data) / write_time
    
    logging.info(f"Write performance: {points_per_second:.0f} points/second")
    
    # Query performance test
    start_time = time.time()
    
    query = '''
    from(bucket: "test-bucket")
      |> range(start: -24h)
      |> filter(fn: (r) => r._measurement == "iot_metrics")
      |> filter(fn: (r) => r.device_id =~ /sensor_00[0-9]/)
      |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
    '''
    
    result = client.execute_optimized_query(
        flux_query=query,
        start_time=datetime.now() - timedelta(days=1)
    )
    
    query_time = time.time() - start_time
    
    logging.info(f"Query performance: {query_time:.2f} seconds for {len(result)} results")
    
    client.close()
```

## TimescaleDB Optimization

### TimescaleDB Configuration and Hypertables

```sql
-- timescaledb_optimization.sql

-- Create optimized TimescaleDB hypertables
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- IoT Metrics Table
CREATE TABLE iot_metrics (
    time TIMESTAMPTZ NOT NULL,
    device_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    location TEXT,
    status TEXT,
    metadata JSONB
);

-- Create hypertable with optimized chunk size
SELECT create_hypertable('iot_metrics', 'time', 
    chunk_time_interval => INTERVAL '1 day',
    create_default_indexes => FALSE
);

-- Create optimized indexes
CREATE INDEX CONCURRENTLY idx_iot_metrics_device_time 
ON iot_metrics (device_id, time DESC);

CREATE INDEX CONCURRENTLY idx_iot_metrics_metric_time 
ON iot_metrics (metric_name, time DESC);

CREATE INDEX CONCURRENTLY idx_iot_metrics_location_time 
ON iot_metrics (location, time DESC) 
WHERE location IS NOT NULL;

-- Create partial index for error conditions
CREATE INDEX CONCURRENTLY idx_iot_metrics_errors 
ON iot_metrics (time DESC) 
WHERE status != 'active';

-- Financial Data Table
CREATE TABLE financial_data (
    time TIMESTAMPTZ NOT NULL,
    symbol TEXT NOT NULL,
    open DECIMAL(10,2) NOT NULL,
    high DECIMAL(10,2) NOT NULL,
    low DECIMAL(10,2) NOT NULL,
    close DECIMAL(10,2) NOT NULL,
    volume BIGINT NOT NULL,
    market_cap BIGINT
);

SELECT create_hypertable('financial_data', 'time',
    chunk_time_interval => INTERVAL '1 week'
);

-- Clustered index on symbol and time
CREATE INDEX CONCURRENTLY idx_financial_symbol_time 
ON financial_data (symbol, time DESC);

-- Application Metrics Table  
CREATE TABLE app_metrics (
    time TIMESTAMPTZ NOT NULL,
    service_name TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    tags JSONB,
    environment TEXT DEFAULT 'production'
);

SELECT create_hypertable('app_metrics', 'time',
    chunk_time_interval => INTERVAL '6 hours'
);

-- Multi-column index for fast filtering
CREATE INDEX CONCURRENTLY idx_app_metrics_service_type_time 
ON app_metrics (service_name, metric_type, time DESC);

-- GIN index for JSONB tags
CREATE INDEX CONCURRENTLY idx_app_metrics_tags 
ON app_metrics USING GIN (tags);

-- Compression and Retention Policies
-- Enable compression on older chunks
SELECT add_compression_policy('iot_metrics', INTERVAL '7 days');
SELECT add_compression_policy('financial_data', INTERVAL '30 days');
SELECT add_compression_policy('app_metrics', INTERVAL '3 days');

-- Set up data retention
SELECT add_retention_policy('iot_metrics', INTERVAL '1 year');
SELECT add_retention_policy('app_metrics', INTERVAL '90 days');

-- Continuous Aggregates for Common Queries
-- 5-minute aggregates for IoT metrics
CREATE MATERIALIZED VIEW iot_metrics_5m
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('5 minutes', time) AS bucket,
    device_id,
    metric_name,
    location,
    AVG(value) as avg_value,
    MIN(value) as min_value,
    MAX(value) as max_value,
    COUNT(*) as sample_count
FROM iot_metrics
GROUP BY bucket, device_id, metric_name, location;

-- Add refresh policy
SELECT add_continuous_aggregate_policy('iot_metrics_5m',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes'
);

-- Hourly aggregates for financial data
CREATE MATERIALIZED VIEW financial_hourly
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 hour', time) AS bucket,
    symbol,
    first(open, time) as open,
    max(high) as high,
    min(low) as low,
    last(close, time) as close,
    sum(volume) as volume
FROM financial_data
GROUP BY bucket, symbol;

-- Daily aggregates
CREATE MATERIALIZED VIEW financial_daily
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 day', time) AS bucket,
    symbol,
    first(open, time) as open,
    max(high) as high,
    min(low) as low,
    last(close, time) as close,
    sum(volume) as volume,
    avg(close) as avg_close
FROM financial_data
GROUP BY bucket, symbol;

-- Application metrics aggregates
CREATE MATERIALIZED VIEW app_metrics_1m
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 minute', time) AS bucket,
    service_name,
    metric_type,
    environment,
    AVG(value) as avg_value,
    MIN(value) as min_value,
    MAX(value) as max_value,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value) as median_value,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY value) as p95_value,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY value) as p99_value,
    COUNT(*) as sample_count
FROM app_metrics
GROUP BY bucket, service_name, metric_type, environment;

-- Performance optimization functions
CREATE OR REPLACE FUNCTION optimize_chunk_indexes()
RETURNS void AS $$
DECLARE
    chunk_rec RECORD;
BEGIN
    -- Reindex chunks older than 7 days for better query performance
    FOR chunk_rec IN 
        SELECT chunk_schema, chunk_name 
        FROM timescaledb_information.chunks 
        WHERE range_end < NOW() - INTERVAL '7 days'
    LOOP
        EXECUTE format('REINDEX TABLE %I.%I', chunk_rec.chunk_schema, chunk_rec.chunk_name);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Create function to analyze query performance
CREATE OR REPLACE FUNCTION analyze_query_performance(
    query_text TEXT,
    iterations INT DEFAULT 5
)
RETURNS TABLE(
    avg_execution_time_ms NUMERIC,
    min_execution_time_ms NUMERIC,
    max_execution_time_ms NUMERIC
) AS $$
DECLARE
    i INT;
    start_time TIMESTAMP;
    end_time TIMESTAMP;
    execution_times NUMERIC[];
    exec_time NUMERIC;
BEGIN
    -- Warm up
    EXECUTE query_text;
    
    -- Run performance tests
    FOR i IN 1..iterations LOOP
        start_time := clock_timestamp();
        EXECUTE query_text;
        end_time := clock_timestamp();
        
        exec_time := EXTRACT(epoch FROM (end_time - start_time)) * 1000;
        execution_times := array_append(execution_times, exec_time);
    END LOOP;
    
    RETURN QUERY SELECT 
        (SELECT avg(unnest) FROM unnest(execution_times)) as avg_execution_time_ms,
        (SELECT min(unnest) FROM unnest(execution_times)) as min_execution_time_ms,
        (SELECT max(unnest) FROM unnest(execution_times)) as max_execution_time_ms;
END;
$$ LANGUAGE plpgsql;
```

### TimescaleDB Python Integration

```python
# timescaledb_client.py
import psycopg2
import pandas as pd
import numpy as np
from sqlalchemy import create_engine, text
from sqlalchemy.pool import QueuePool
from contextlib import contextmanager
from typing import List, Dict, Optional, Iterator
import logging
from datetime import datetime, timedelta

class OptimizedTimescaleDBClient:
    """Optimized TimescaleDB client with connection pooling and best practices"""
    
    def __init__(self, 
                 connection_string: str,
                 pool_size: int = 20,
                 max_overflow: int = 30,
                 pool_timeout: int = 30):
        
        self.engine = create_engine(
            connection_string,
            poolclass=QueuePool,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_timeout=pool_timeout,
            pool_pre_ping=True,
            echo=False
        )
    
    @contextmanager
    def get_connection(self):
        """Get database connection with proper cleanup"""
        conn = self.engine.connect()
        try:
            yield conn
        finally:
            conn.close()
    
    def bulk_insert_optimized(self, 
                            df: pd.DataFrame, 
                            table_name: str,
                            chunk_size: int = 10000) -> None:
        """Optimized bulk insert using COPY command"""
        
        total_rows = len(df)
        logging.info(f"Inserting {total_rows} rows into {table_name}")
        
        with self.get_connection() as conn:
            # Use pandas to_sql with method parameter for better performance
            df.to_sql(
                name=table_name,
                con=conn,
                if_exists='append',
                index=False,
                method='multi',
                chunksize=chunk_size
            )
        
        logging.info(f"Successfully inserted {total_rows} rows")
    
    def execute_query_with_performance_stats(self, 
                                           query: str, 
                                           params: Dict = None) -> pd.DataFrame:
        """Execute query and return performance statistics"""
        
        with self.get_connection() as conn:
            start_time = datetime.now()
            
            # Enable query timing
            conn.execute(text("SET track_io_timing = on"))
            
            result_df = pd.read_sql(query, conn, params=params)
            
            end_time = datetime.now()
            execution_time = (end_time - start_time).total_seconds()
            
            # Get query statistics
            stats_query = """
            SELECT 
                query_start,
                total_exec_time,
                mean_exec_time,
                calls,
                rows,
                shared_blks_hit,
                shared_blks_read,
                temp_blks_read,
                temp_blks_written
            FROM pg_stat_statements 
            WHERE query LIKE %s
            ORDER BY last_exec DESC 
            LIMIT 1
            """
            
            try:
                stats_df = pd.read_sql(stats_query, conn, params=[query[:50] + '%'])
                if not stats_df.empty:
                    stats = stats_df.iloc[0]
                    logging.info(f"Query stats - Execution time: {execution_time:.3f}s, "
                               f"Rows: {len(result_df)}, "
                               f"Buffer hits: {stats['shared_blks_hit']}, "
                               f"Buffer reads: {stats['shared_blks_read']}")
            except Exception as e:
                logging.warning(f"Could not get query statistics: {e}")
        
        return result_df
    
    def create_optimized_indexes(self, table_name: str, index_configs: List[Dict]) -> None:
        """Create optimized indexes based on configuration"""
        
        with self.get_connection() as conn:
            for idx_config in index_configs:
                index_name = idx_config['name']
                columns = idx_config['columns']
                index_type = idx_config.get('type', 'btree')
                where_clause = idx_config.get('where', '')
                unique = idx_config.get('unique', False)
                concurrent = idx_config.get('concurrent', True)
                
                # Build CREATE INDEX statement
                create_stmt = f"CREATE {'UNIQUE' if unique else ''} INDEX {'CONCURRENTLY' if concurrent else ''} {index_name} ON {table_name}"
                
                if index_type != 'btree':
                    create_stmt += f" USING {index_type}"
                
                create_stmt += f" ({', '.join(columns)})"
                
                if where_clause:
                    create_stmt += f" WHERE {where_clause}"
                
                try:
                    conn.execute(text(create_stmt))
                    conn.commit()
                    logging.info(f"Created index: {index_name}")
                except Exception as e:
                    logging.error(f"Failed to create index {index_name}: {e}")
    
    def optimize_table_statistics(self, table_name: str) -> None:
        """Update table statistics for better query planning"""
        
        with self.get_connection() as conn:
            # Analyze table
            conn.execute(text(f"ANALYZE {table_name}"))
            
            # Get table statistics
            stats_query = f"""
            SELECT 
                schemaname,
                tablename,
                n_tup_ins as inserts,
                n_tup_upd as updates,
                n_tup_del as deletes,
                n_live_tup as live_tuples,
                n_dead_tup as dead_tuples,
                last_vacuum,
                last_autovacuum,
                last_analyze,
                last_autoanalyze
            FROM pg_stat_user_tables 
            WHERE tablename = '{table_name}'
            """
            
            stats_df = pd.read_sql(stats_query, conn)
            
            if not stats_df.empty:
                stats = stats_df.iloc[0]
                logging.info(f"Table {table_name} statistics:")
                logging.info(f"  Live tuples: {stats['live_tuples']:,}")
                logging.info(f"  Dead tuples: {stats['dead_tuples']:,}")
                logging.info(f"  Last analyze: {stats['last_analyze']}")
    
    def get_chunk_information(self, table_name: str) -> pd.DataFrame:
        """Get information about hypertable chunks"""
        
        query = f"""
        SELECT 
            chunk_schema,
            chunk_name,
            range_start,
            range_end,
            chunk_tablespace,
            data_nodes,
            compressed_chunk_name IS NOT NULL as is_compressed,
            pg_size_pretty(pg_total_relation_size(format('%I.%I', chunk_schema, chunk_name))) as chunk_size
        FROM timescaledb_information.chunks 
        WHERE hypertable_name = '{table_name}'
        ORDER BY range_start DESC
        """
        
        with self.get_connection() as conn:
            return pd.read_sql(query, conn)
    
    def compress_old_chunks(self, 
                          table_name: str, 
                          older_than: timedelta = timedelta(days=7)) -> None:
        """Compress chunks older than specified time"""
        
        cutoff_time = datetime.now() - older_than
        
        compress_query = f"""
        SELECT compress_chunk(format('%I.%I', chunk_schema, chunk_name))
        FROM timescaledb_information.chunks 
        WHERE hypertable_name = '{table_name}'
        AND range_end < '{cutoff_time.isoformat()}'::timestamptz
        AND compressed_chunk_name IS NULL
        """
        
        with self.get_connection() as conn:
            result = conn.execute(text(compress_query))
            compressed_count = result.rowcount
            logging.info(f"Compressed {compressed_count} chunks for table {table_name}")
    
    def create_continuous_aggregate(self, 
                                  view_name: str,
                                  source_table: str,
                                  time_bucket: str,
                                  group_by: List[str],
                                  aggregations: Dict[str, str],
                                  refresh_policy: Dict[str, str] = None) -> None:
        """Create continuous aggregate view"""
        
        # Build SELECT clause
        select_columns = [f"time_bucket('{time_bucket}', time) AS bucket"] + group_by
        
        for agg_name, agg_expr in aggregations.items():
            select_columns.append(f"{agg_expr} AS {agg_name}")
        
        # Build GROUP BY clause
        group_by_clause = "bucket, " + ", ".join(group_by)
        
        create_view_query = f"""
        CREATE MATERIALIZED VIEW {view_name}
        WITH (timescaledb.continuous) AS
        SELECT {', '.join(select_columns)}
        FROM {source_table}
        GROUP BY {group_by_clause}
        """
        
        with self.get_connection() as conn:
            conn.execute(text(create_view_query))
            conn.commit()
            
            logging.info(f"Created continuous aggregate: {view_name}")
            
            # Add refresh policy if specified
            if refresh_policy:
                policy_query = f"""
                SELECT add_continuous_aggregate_policy('{view_name}',
                    start_offset => INTERVAL '{refresh_policy['start_offset']}',
                    end_offset => INTERVAL '{refresh_policy['end_offset']}',
                    schedule_interval => INTERVAL '{refresh_policy['schedule_interval']}'
                )
                """
                conn.execute(text(policy_query))
                conn.commit()
                logging.info(f"Added refresh policy for {view_name}")

# Query optimization examples
class TimescaleDBQueryOptimizer:
    """TimescaleDB query optimization utilities"""
    
    @staticmethod
    def optimize_time_range_query(table_name: str,
                                time_column: str,
                                start_time: datetime,
                                end_time: datetime,
                                additional_filters: List[str] = None) -> str:
        """Generate optimized time range query"""
        
        query = f"""
        SELECT *
        FROM {table_name}
        WHERE {time_column} >= '{start_time.isoformat()}'::timestamptz
        AND {time_column} < '{end_time.isoformat()}'::timestamptz
        """
        
        if additional_filters:
            for filter_clause in additional_filters:
                query += f"\nAND {filter_clause}"
        
        query += f"\nORDER BY {time_column} DESC"
        
        return query
    
    @staticmethod
    def create_aggregation_query(table_name: str,
                               time_bucket: str,
                               group_by: List[str],
                               aggregations: Dict[str, str],
                               time_range: str = "24 hours") -> str:
        """Create optimized aggregation query"""
        
        select_columns = [f"time_bucket('{time_bucket}', time) AS bucket"] + group_by
        
        for agg_name, agg_expr in aggregations.items():
            select_columns.append(f"{agg_expr} AS {agg_name}")
        
        group_by_clause = "bucket, " + ", ".join(group_by)
        
        query = f"""
        SELECT {', '.join(select_columns)}
        FROM {table_name}
        WHERE time >= NOW() - INTERVAL '{time_range}'
        GROUP BY {group_by_clause}
        ORDER BY bucket DESC
        """
        
        return query
    
    @staticmethod
    def create_percentile_query(table_name: str,
                              value_column: str,
                              percentiles: List[float],
                              time_bucket: str = "1 hour",
                              group_by: List[str] = None) -> str:
        """Create query for percentile calculations"""
        
        percentile_exprs = []
        for p in percentiles:
            percentile_exprs.append(
                f"PERCENTILE_CONT({p}) WITHIN GROUP (ORDER BY {value_column}) AS p{int(p*100)}"
            )
        
        select_columns = [f"time_bucket('{time_bucket}', time) AS bucket"]
        
        if group_by:
            select_columns.extend(group_by)
        
        select_columns.extend(percentile_exprs)
        
        group_by_clause = "bucket"
        if group_by:
            group_by_clause += ", " + ", ".join(group_by)
        
        query = f"""
        SELECT {', '.join(select_columns)}
        FROM {table_name}
        WHERE time >= NOW() - INTERVAL '24 hours'
        GROUP BY {group_by_clause}
        ORDER BY bucket DESC
        """
        
        return query

# Performance testing
def test_timescaledb_performance():
    """Test TimescaleDB performance"""
    
    client = OptimizedTimescaleDBClient(
        connection_string="postgresql://user:password@localhost:5432/timeseries_db",
        pool_size=20
    )
    
    # Generate test data
    generator = TimeSeriesDataGenerator(
        metrics=['temperature', 'humidity', 'pressure'],
        devices=[f'sensor_{i:03d}' for i in range(1000)]
    )
    
    test_data = generator.generate_iot_metrics(duration_hours=24, interval_seconds=30)
    
    # Write performance test
    import time
    start_time = time.time()
    
    client.bulk_insert_optimized(
        df=test_data,
        table_name='iot_metrics',
        chunk_size=10000
    )
    
    write_time = time.time() - start_time
    points_per_second = len(test_data) / write_time
    
    logging.info(f"Write performance: {points_per_second:.0f} points/second")
    
    # Query performance test
    optimizer = TimescaleDBQueryOptimizer()
    
    query = optimizer.optimize_time_range_query(
        table_name='iot_metrics',
        time_column='time',
        start_time=datetime.now() - timedelta(days=1),
        end_time=datetime.now(),
        additional_filters=['device_id LIKE \'sensor_00%\'']
    )
    
    start_time = time.time()
    result = client.execute_query_with_performance_stats(query)
    query_time = time.time() - start_time
    
    logging.info(f"Query performance: {query_time:.2f} seconds for {len(result)} results")
```

## ClickHouse Optimization

### ClickHouse Schema Design and Configuration

```sql
-- clickhouse_optimization.sql

-- Create optimized ClickHouse tables with proper engines and partitioning

-- IoT Metrics Table with MergeTree engine
CREATE TABLE iot_metrics (
    timestamp DateTime64(3),
    device_id LowCardinality(String),
    metric_name LowCardinality(String),
    value Float64,
    location LowCardinality(String),
    status LowCardinality(String),
    metadata String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (device_id, metric_name, timestamp)
TTL timestamp + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

-- Financial Data Table
CREATE TABLE financial_data (
    timestamp DateTime,
    symbol LowCardinality(String),
    open Decimal(10,2),
    high Decimal(10,2),
    low Decimal(10,2),
    close Decimal(10,2),
    volume UInt64,
    market_cap UInt64
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (symbol, timestamp)
TTL timestamp + INTERVAL 2 YEAR
SETTINGS index_granularity = 8192;

-- Application Metrics Table
CREATE TABLE app_metrics (
    timestamp DateTime64(3),
    service_name LowCardinality(String),
    metric_type LowCardinality(String),
    value Float64,
    environment LowCardinality(String) DEFAULT 'production'
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (service_name, metric_type, timestamp)
TTL timestamp + INTERVAL 90 DAY
SETTINGS index_granularity = 4096;

-- Create materialized views for real-time aggregations

-- 5-minute aggregates for IoT metrics
CREATE MATERIALIZED VIEW iot_metrics_5m_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(timestamp_5m)
ORDER BY (device_id, metric_name, timestamp_5m)
AS SELECT
    toStartOfInterval(timestamp, INTERVAL 5 MINUTE) AS timestamp_5m,
    device_id,
    metric_name,
    location,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    count() AS sample_count,
    sum(1) AS _sum  -- For SummingMergeTree
FROM iot_metrics
GROUP BY timestamp_5m, device_id, metric_name, location;

-- Hourly aggregates for financial data
CREATE MATERIALIZED VIEW financial_hourly_mv
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(timestamp_1h)
ORDER BY (symbol, timestamp_1h)
AS SELECT
    toStartOfHour(timestamp) AS timestamp_1h,
    symbol,
    argMin(open, timestamp) AS open,
    max(high) AS high,
    min(low) AS low,
    argMax(close, timestamp) AS close,
    sum(volume) AS volume
FROM financial_data
GROUP BY timestamp_1h, symbol;

-- Daily aggregates
CREATE MATERIALIZED VIEW financial_daily_mv
ENGINE = ReplacingMergeTree()
PARTITION BY toYear(timestamp_1d)
ORDER BY (symbol, timestamp_1d)
AS SELECT
    toDate(timestamp) AS timestamp_1d,
    symbol,
    argMin(open, timestamp) AS open,
    max(high) AS high,
    min(low) AS low,
    argMax(close, timestamp) AS close,
    sum(volume) AS volume,
    avg(close) AS avg_close
FROM financial_data
GROUP BY timestamp_1d, symbol;

-- 1-minute aggregates for application metrics
CREATE MATERIALIZED VIEW app_metrics_1m_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMMDD(timestamp_1m)
ORDER BY (service_name, metric_type, environment, timestamp_1m)
AS SELECT
    toStartOfMinute(timestamp) AS timestamp_1m,
    service_name,
    metric_type,
    environment,
    avgState(value) AS avg_value,
    minState(value) AS min_value,
    maxState(value) AS max_value,
    quantileState(0.5)(value) AS median_value,
    quantileState(0.95)(value) AS p95_value,
    quantileState(0.99)(value) AS p99_value,
    countState() AS sample_count
FROM app_metrics
GROUP BY timestamp_1m, service_name, metric_type, environment;

-- Create distributed tables for cluster deployments
CREATE TABLE iot_metrics_distributed AS iot_metrics
ENGINE = Distributed(cluster_name, currentDatabase(), iot_metrics, rand());

-- Create buffer tables for high-frequency inserts
CREATE TABLE iot_metrics_buffer AS iot_metrics
ENGINE = Buffer(currentDatabase(), iot_metrics, 16, 10, 100, 10000, 1000000, 10000000, 100000000);

-- Optimization functions and procedures

-- Function to optimize table partitions
CREATE OR REPLACE FUNCTION optimize_partitions(table_name String, days_back UInt32)
RETURNS String AS $$
DECLARE
    partition_expr String;
    optimize_query String;
BEGIN
    FOR partition_expr IN 
        SELECT DISTINCT partition 
        FROM system.parts 
        WHERE table = table_name 
        AND modification_time < now() - INTERVAL days_back DAY
    LOOP
        optimize_query := 'OPTIMIZE TABLE ' || table_name || ' PARTITION ' || partition_expr || ' FINAL';
        EXECUTE(optimize_query);
    END;
    
    RETURN 'Optimized ' || table_name;
END;
$$;

-- Performance monitoring queries

-- Query to check table sizes and compression
SELECT 
    table,
    formatReadableSize(sum(bytes_on_disk)) AS size_on_disk,
    formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed_size,
    round(sum(data_uncompressed_bytes) / sum(bytes_on_disk), 2) AS compression_ratio,
    sum(rows) AS total_rows,
    count() AS partition_count
FROM system.parts 
WHERE table IN ('iot_metrics', 'financial_data', 'app_metrics')
GROUP BY table
ORDER BY sum(bytes_on_disk) DESC;

-- Query to check query performance
SELECT 
    query_duration_ms,
    query,
    read_rows,
    read_bytes,
    memory_usage,
    written_rows,
    written_bytes,
    result_rows,
    result_bytes,
    exception_code
FROM system.query_log 
WHERE event_time > now() - INTERVAL 1 HOUR
AND query_duration_ms > 1000  -- Queries taking more than 1 second
ORDER BY query_duration_ms DESC
LIMIT 10;

-- Index usage analysis
SELECT 
    table,
    name,
    type,
    part_count,
    marks,
    marks_bytes
FROM system.data_skipping_indices 
WHERE table IN ('iot_metrics', 'financial_data', 'app_metrics')
ORDER BY marks_bytes DESC;
```

### ClickHouse Python Client with Optimizations

```python
# clickhouse_client.py
import clickhouse_connect
import pandas as pd
import numpy as np
from typing import List, Dict, Optional, Any
import logging
from datetime import datetime, timedelta
import asyncio
import aiohttp
from concurrent.futures import ThreadPoolExecutor
import time

class OptimizedClickHouseClient:
    """Optimized ClickHouse client with advanced features"""
    
    def __init__(self, 
                 host: str = 'localhost',
                 port: int = 8123,
                 username: str = 'default',
                 password: str = '',
                 database: str = 'default',
                 settings: Dict[str, Any] = None):
        
        default_settings = {
            'max_threads': 8,
            'max_memory_usage': 10000000000,  # 10GB
            'max_bytes_before_external_group_by': 2000000000,  # 2GB
            'max_bytes_before_external_sort': 2000000000,  # 2GB
            'max_execution_time': 300,  # 5 minutes
            'send_timeout': 300,
            'receive_timeout': 300,
            'max_insert_block_size': 1048576,  # 1M rows
            'optimize_aggregation_in_order': 1,
            'optimize_read_in_order': 1,
            'use_uncompressed_cache': 1,
            'compress': 1
        }
        
        if settings:
            default_settings.update(settings)
        
        self.client = clickhouse_connect.get_client(
            host=host,
            port=port,
            username=username,
            password=password,
            database=database,
            settings=default_settings
        )
        
        self.executor = ThreadPoolExecutor(max_workers=4)
    
    def insert_dataframe_optimized(self, 
                                 df: pd.DataFrame, 
                                 table_name: str,
                                 batch_size: int = 100000) -> None:
        """Insert DataFrame with optimal performance"""
        
        total_rows = len(df)
        logging.info(f"Inserting {total_rows} rows into {table_name}")
        
        # Insert in batches for large datasets
        if total_rows > batch_size:
            for i in range(0, total_rows, batch_size):
                batch_df = df.iloc[i:i + batch_size]
                
                start_time = time.time()
                self.client.insert_df(table_name, batch_df)
                insert_time = time.time() - start_time
                
                rows_per_second = len(batch_df) / insert_time
                logging.info(f"Batch {i//batch_size + 1}: {len(batch_df)} rows, "
                           f"{rows_per_second:.0f} rows/sec")
        else:
            start_time = time.time()
            self.client.insert_df(table_name, df)
            insert_time = time.time() - start_time
            
            rows_per_second = total_rows / insert_time
            logging.info(f"Inserted {total_rows} rows in {insert_time:.2f}s "
                        f"({rows_per_second:.0f} rows/sec)")
    
    def execute_query_with_stats(self, 
                               query: str, 
                               parameters: Dict = None) -> pd.DataFrame:
        """Execute query and return performance statistics"""
        
        start_time = time.time()
        
        # Add query settings for performance
        optimized_query = f"""
        SET max_threads = 8;
        SET optimize_aggregation_in_order = 1;
        SET optimize_read_in_order = 1;
        
        {query}
        """
        
        result = self.client.query_df(optimized_query, parameters=parameters)
        
        execution_time = time.time() - start_time
        
        # Get query statistics
        stats_query = """
        SELECT 
            query_duration_ms,
            read_rows,
            read_bytes,
            memory_usage,
            result_rows,
            result_bytes
        FROM system.query_log 
        WHERE query_start_time > now() - INTERVAL 10 SECOND
        AND type = 'QueryFinish'
        ORDER BY query_start_time DESC
        LIMIT 1
        """
        
        try:
            stats_result = self.client.query(stats_query)
            if stats_result.result_rows:
                stats = stats_result.first_row
                logging.info(f"Query stats - Execution: {execution_time:.3f}s, "
                           f"Read rows: {stats[1]:,}, "
                           f"Read bytes: {stats[2]:,}, "
                           f"Memory: {stats[3]:,}, "
                           f"Result rows: {len(result):,}")
        except Exception as e:
            logging.warning(f"Could not get query statistics: {e}")
        
        return result
    
    def create_optimized_table(self, 
                             table_name: str, 
                             schema: Dict[str, str],
                             engine_config: Dict[str, Any]) -> None:
        """Create table with optimized configuration"""
        
        # Build column definitions
        columns = []
        for col_name, col_type in schema.items():
            columns.append(f"{col_name} {col_type}")
        
        columns_str = ",\n    ".join(columns)
        
        # Build engine clause
        engine = engine_config['engine']
        engine_params = []
        
        if 'partition_by' in engine_config:
            engine_params.append(f"PARTITION BY {engine_config['partition_by']}")
        
        if 'order_by' in engine_config:
            engine_params.append(f"ORDER BY {engine_config['order_by']}")
        
        if 'primary_key' in engine_config:
            engine_params.append(f"PRIMARY KEY {engine_config['primary_key']}")
        
        if 'ttl' in engine_config:
            engine_params.append(f"TTL {engine_config['ttl']}")
        
        if 'settings' in engine_config:
            settings_list = [f"{k} = {v}" for k, v in engine_config['settings'].items()]
            engine_params.append(f"SETTINGS {', '.join(settings_list)}")
        
        engine_clause = "\n".join(engine_params)
        
        create_query = f"""
        CREATE TABLE {table_name} (
            {columns_str}
        ) ENGINE = {engine}()
        {engine_clause}
        """
        
        self.client.command(create_query)
        logging.info(f"Created table: {table_name}")
    
    def create_materialized_view(self, 
                               view_name: str,
                               source_table: str,
                               aggregation_config: Dict[str, Any]) -> None:
        """Create materialized view for real-time aggregations"""
        
        # Build SELECT clause
        select_columns = []
        
        # Time bucket
        if 'time_bucket' in aggregation_config:
            time_col = aggregation_config['time_column']
            bucket_size = aggregation_config['time_bucket']
            select_columns.append(f"toStartOfInterval({time_col}, INTERVAL {bucket_size}) AS timestamp_{bucket_size.replace(' ', '_')}")
        
        # Group by columns
        if 'group_by' in aggregation_config:
            select_columns.extend(aggregation_config['group_by'])
        
        # Aggregations
        if 'aggregations' in aggregation_config:
            for agg_name, agg_expr in aggregation_config['aggregations'].items():
                select_columns.append(f"{agg_expr} AS {agg_name}")
        
        # Build GROUP BY clause
        group_by_cols = []
        if 'time_bucket' in aggregation_config:
            group_by_cols.append(f"timestamp_{aggregation_config['time_bucket'].replace(' ', '_')}")
        if 'group_by' in aggregation_config:
            group_by_cols.extend(aggregation_config['group_by'])
        
        # Build engine configuration
        engine = aggregation_config.get('engine', 'SummingMergeTree')
        partition_by = aggregation_config.get('partition_by', 'toYYYYMM(timestamp)')
        order_by = aggregation_config.get('order_by', ', '.join(group_by_cols))
        
        create_mv_query = f"""
        CREATE MATERIALIZED VIEW {view_name}
        ENGINE = {engine}()
        PARTITION BY {partition_by}
        ORDER BY ({order_by})
        AS SELECT
            {', '.join(select_columns)}
        FROM {source_table}
        GROUP BY {', '.join(group_by_cols)}
        """
        
        self.client.command(create_mv_query)
        logging.info(f"Created materialized view: {view_name}")
    
    def optimize_table_partitions(self, 
                                 table_name: str, 
                                 partition_filter: str = None) -> None:
        """Optimize table partitions for better query performance"""
        
        if partition_filter:
            optimize_query = f"OPTIMIZE TABLE {table_name} PARTITION {partition_filter} FINAL"
        else:
            optimize_query = f"OPTIMIZE TABLE {table_name} FINAL"
        
        start_time = time.time()
        self.client.command(optimize_query)
        optimization_time = time.time() - start_time
        
        logging.info(f"Optimized {table_name} in {optimization_time:.2f} seconds")
    
    def get_table_statistics(self, table_name: str) -> Dict[str, Any]:
        """Get comprehensive table statistics"""
        
        stats_query = f"""
        SELECT 
            sum(rows) as total_rows,
            sum(bytes_on_disk) as bytes_on_disk,
            sum(data_uncompressed_bytes) as uncompressed_bytes,
            round(sum(data_uncompressed_bytes) / sum(bytes_on_disk), 2) as compression_ratio,
            count() as partition_count,
            min(min_date) as min_date,
            max(max_date) as max_date
        FROM system.parts 
        WHERE table = '{table_name}' 
        AND active = 1
        """
        
        result = self.client.query(stats_query)
        
        if result.result_rows:
            row = result.first_row
            return {
                'total_rows': row[0],
                'bytes_on_disk': row[1],
                'uncompressed_bytes': row[2],
                'compression_ratio': row[3],
                'partition_count': row[4],
                'min_date': row[5],
                'max_date': row[6]
            }
        
        return {}
    
    def analyze_query_performance(self, 
                                query: str, 
                                iterations: int = 5) -> Dict[str, float]:
        """Analyze query performance over multiple iterations"""
        
        execution_times = []
        
        # Warm up
        self.client.query(query)
        
        for i in range(iterations):
            start_time = time.time()
            result = self.client.query(query)
            execution_time = time.time() - start_time
            execution_times.append(execution_time)
            
            logging.info(f"Iteration {i+1}: {execution_time:.3f}s, {result.result_rows} rows")
        
        return {
            'avg_time': np.mean(execution_times),
            'min_time': np.min(execution_times),
            'max_time': np.max(execution_times),
            'std_time': np.std(execution_times)
        }
    
    def close(self):
        """Close client connections"""
        self.client.close()
        self.executor.shutdown(wait=True)

# Query optimization utilities
class ClickHouseQueryOptimizer:
    """ClickHouse query optimization utilities"""
    
    @staticmethod
    def create_time_series_query(table_name: str,
                                time_column: str,
                                start_time: datetime,
                                end_time: datetime,
                                metrics: List[str],
                                group_by: List[str] = None,
                                time_bucket: str = '1 minute') -> str:
        """Create optimized time series query"""
        
        select_columns = [f"toStartOfInterval({time_column}, INTERVAL {time_bucket}) AS bucket"]
        
        if group_by:
            select_columns.extend(group_by)
        
        select_columns.extend(metrics)
        
        where_conditions = [
            f"{time_column} >= '{start_time.strftime('%Y-%m-%d %H:%M:%S')}'",
            f"{time_column} < '{end_time.strftime('%Y-%m-%d %H:%M:%S')}'"
        ]
        
        group_by_clause = "bucket"
        if group_by:
            group_by_clause += ", " + ", ".join(group_by)
        
        query = f"""
        SELECT {', '.join(select_columns)}
        FROM {table_name}
        WHERE {' AND '.join(where_conditions)}
        GROUP BY {group_by_clause}
        ORDER BY bucket
        """
        
        return query
    
    @staticmethod
    def create_percentile_query(table_name: str,
                              value_column: str,
                              percentiles: List[float],
                              time_bucket: str = '1 hour',
                              group_by: List[str] = None) -> str:
        """Create query for percentile calculations"""
        
        percentile_exprs = []
        for p in percentiles:
            percentile_exprs.append(f"quantile({p})({value_column}) AS p{int(p*100)}")
        
        select_columns = [f"toStartOfInterval(timestamp, INTERVAL {time_bucket}) AS bucket"]
        
        if group_by:
            select_columns.extend(group_by)
        
        select_columns.extend(percentile_exprs)
        
        group_by_clause = "bucket"
        if group_by:
            group_by_clause += ", " + ", ".join(group_by)
        
        query = f"""
        SELECT {', '.join(select_columns)}
        FROM {table_name}
        WHERE timestamp >= now() - INTERVAL 24 HOUR
        GROUP BY {group_by_clause}
        ORDER BY bucket
        """
        
        return query
    
    @staticmethod
    def create_top_n_query(table_name: str,
                          dimension_column: str,
                          metric_column: str,
                          aggregation: str = 'sum',
                          limit: int = 10,
                          time_filter: str = '24 HOUR') -> str:
        """Create top-N query with optimizations"""
        
        query = f"""
        SELECT 
            {dimension_column},
            {aggregation}({metric_column}) AS total_metric
        FROM {table_name}
        WHERE timestamp >= now() - INTERVAL {time_filter}
        GROUP BY {dimension_column}
        ORDER BY total_metric DESC
        LIMIT {limit}
        """
        
        return query

# Performance testing
def test_clickhouse_performance():
    """Test ClickHouse performance with different configurations"""
    
    client = OptimizedClickHouseClient(
        host='localhost',
        port=8123,
        settings={
            'max_threads': 16,
            'max_memory_usage': 20000000000,  # 20GB
            'max_insert_block_size': 1048576
        }
    )
    
    # Generate test data
    generator = TimeSeriesDataGenerator(
        metrics=['temperature', 'humidity', 'pressure'],
        devices=[f'sensor_{i:03d}' for i in range(1000)]
    )
    
    test_data = generator.generate_iot_metrics(duration_hours=24, interval_seconds=30)
    
    # Write performance test
    import time
    start_time = time.time()
    
    client.insert_dataframe_optimized(
        df=test_data,
        table_name='iot_metrics',
        batch_size=100000
    )
    
    write_time = time.time() - start_time
    points_per_second = len(test_data) / write_time
    
    logging.info(f"Write performance: {points_per_second:.0f} points/second")
    
    # Query performance test
    optimizer = ClickHouseQueryOptimizer()
    
    query = optimizer.create_time_series_query(
        table_name='iot_metrics',
        time_column='timestamp',
        start_time=datetime.now() - timedelta(days=1),
        end_time=datetime.now(),
        metrics=['avg(value) AS avg_value', 'max(value) AS max_value'],
        group_by=['device_id', 'metric_name'],
        time_bucket='5 minutes'
    )
    
    perf_stats = client.analyze_query_performance(query, iterations=5)
    
    logging.info(f"Query performance: avg={perf_stats['avg_time']:.3f}s, "
                f"min={perf_stats['min_time']:.3f}s, "
                f"max={perf_stats['max_time']:.3f}s")
    
    # Get table statistics
    stats = client.get_table_statistics('iot_metrics')
    logging.info(f"Table stats: {stats}")
    
    client.close()
```

## Performance Comparison and Benchmarking

### Comprehensive Benchmarking Framework

```python
# benchmark_framework.py
import time
import psutil
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Any
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import matplotlib.pyplot as plt
import seaborn as sns

class TimeSeriesDBBenchmark:
    """Comprehensive benchmarking framework for time series databases"""
    
    def __init__(self, 
                 influxdb_client: OptimizedInfluxDBClient = None,
                 timescaledb_client: OptimizedTimescaleDBClient = None,
                 clickhouse_client: OptimizedClickHouseClient = None):
        
        self.clients = {}
        if influxdb_client:
            self.clients['InfluxDB'] = influxdb_client
        if timescaledb_client:
            self.clients['TimescaleDB'] = timescaledb_client
        if clickhouse_client:
            self.clients['ClickHouse'] = clickhouse_client
        
        self.results = []
    
    def benchmark_writes(self, 
                        test_data: pd.DataFrame,
                        batch_sizes: List[int] = [1000, 5000, 10000, 50000]) -> Dict[str, List[Dict]]:
        """Benchmark write performance across different batch sizes"""
        
        write_results = {}
        
        for db_name, client in self.clients.items():
            write_results[db_name] = []
            
            for batch_size in batch_sizes:
                logging.info(f"Testing {db_name} write performance with batch size {batch_size}")
                
                # Prepare data batches
                num_batches = len(test_data) // batch_size
                
                start_time = time.time()
                memory_before = psutil.virtual_memory().used
                
                for i in range(num_batches):
                    batch_data = test_data.iloc[i*batch_size:(i+1)*batch_size]
                    
                    if db_name == 'InfluxDB':
                        client.write_dataframe_optimized(
                            df=batch_data,
                            measurement='benchmark_metrics',
                            tag_columns=['device_id', 'location'],
                            field_columns=['value']
                        )
                    elif db_name == 'TimescaleDB':
                        client.bulk_insert_optimized(
                            df=batch_data,
                            table_name='iot_metrics',
                            chunk_size=batch_size
                        )
                    elif db_name == 'ClickHouse':
                        client.insert_dataframe_optimized(
                            df=batch_data,
                            table_name='iot_metrics',
                            batch_size=batch_size
                        )
                
                end_time = time.time()
                memory_after = psutil.virtual_memory().used
                
                total_time = end_time - start_time
                total_rows = num_batches * batch_size
                throughput = total_rows / total_time
                memory_used = memory_after - memory_before
                
                result = {
                    'batch_size': batch_size,
                    'total_rows': total_rows,
                    'total_time': total_time,
                    'throughput_rows_per_sec': throughput,
                    'memory_used_mb': memory_used / (1024 * 1024),
                    'avg_latency_ms': (total_time / num_batches) * 1000
                }
                
                write_results[db_name].append(result)
                logging.info(f"{db_name}: {throughput:.0f} rows/sec, {result['avg_latency_ms']:.2f}ms latency")
        
        return write_results
    
    def benchmark_queries(self, 
                         query_configs: List[Dict[str, Any]]) -> Dict[str, List[Dict]]:
        """Benchmark query performance across different query types"""
        
        query_results = {}
        
        for db_name in self.clients.keys():
            query_results[db_name] = []
        
        for query_config in query_configs:
            query_name = query_config['name']
            iterations = query_config.get('iterations', 5)
            
            logging.info(f"Benchmarking query: {query_name}")
            
            for db_name, client in self.clients.items():
                query = self._get_query_for_db(query_config, db_name)
                
                if not query:
                    continue
                
                execution_times = []
                result_rows = 0
                
                # Warm up
                try:
                    if db_name == 'InfluxDB':
                        result = client.execute_optimized_query(
                            query, 
                            datetime.now() - timedelta(days=1)
                        )
                        result_rows = len(result)
                    elif db_name == 'TimescaleDB':
                        result = client.execute_query_with_performance_stats(query)
                        result_rows = len(result)
                    elif db_name == 'ClickHouse':
                        result = client.execute_query_with_stats(query)
                        result_rows = len(result)
                except Exception as e:
                    logging.error(f"Error in {db_name} query {query_name}: {e}")
                    continue
                
                # Performance tests
                for i in range(iterations):
                    start_time = time.time()
                    
                    try:
                        if db_name == 'InfluxDB':
                            client.execute_optimized_query(
                                query, 
                                datetime.now() - timedelta(days=1)
                            )
                        elif db_name == 'TimescaleDB':
                            client.execute_query_with_performance_stats(query)
                        elif db_name == 'ClickHouse':
                            client.execute_query_with_stats(query)
                        
                        execution_time = time.time() - start_time
                        execution_times.append(execution_time)
                        
                    except Exception as e:
                        logging.error(f"Error in {db_name} iteration {i}: {e}")
                        break
                
                if execution_times:
                    result = {
                        'query_name': query_name,
                        'result_rows': result_rows,
                        'avg_time': np.mean(execution_times),
                        'min_time': np.min(execution_times),
                        'max_time': np.max(execution_times),
                        'std_time': np.std(execution_times),
                        'throughput_rows_per_sec': result_rows / np.mean(execution_times) if result_rows > 0 else 0
                    }
                    
                    query_results[db_name].append(result)
                    logging.info(f"{db_name} - {query_name}: {result['avg_time']:.3f}s avg, {result_rows} rows")
        
        return query_results
    
    def benchmark_concurrent_operations(self, 
                                      test_data: pd.DataFrame,
                                      concurrent_users: List[int] = [1, 5, 10, 20]) -> Dict[str, List[Dict]]:
        """Benchmark concurrent read/write performance"""
        
        concurrent_results = {}
        
        for db_name in self.clients.keys():
            concurrent_results[db_name] = []
        
        for num_users in concurrent_users:
            logging.info(f"Testing concurrent performance with {num_users} users")
            
            for db_name, client in self.clients.items():
                
                def concurrent_operation(user_id: int) -> Dict[str, Any]:
                    start_time = time.time()
                    
                    try:
                        # Simulate mixed workload: 70% reads, 30% writes
                        operations = []
                        
                        for op in range(10):  # 10 operations per user
                            if np.random.random() < 0.7:  # Read operation
                                if db_name == 'InfluxDB':
                                    query = '''
                                    from(bucket: "test-bucket")
                                      |> range(start: -1h)
                                      |> filter(fn: (r) => r._measurement == "benchmark_metrics")
                                      |> aggregateWindow(every: 1m, fn: mean)
                                    '''
                                    result = client.execute_optimized_query(
                                        query, 
                                        datetime.now() - timedelta(hours=1)
                                    )
                                elif db_name == 'TimescaleDB':
                                    query = """
                                    SELECT 
                                        time_bucket('1 minute', time) AS bucket,
                                        device_id,
                                        avg(value) as avg_value
                                    FROM iot_metrics 
                                    WHERE time >= NOW() - INTERVAL '1 hour'
                                    GROUP BY bucket, device_id
                                    ORDER BY bucket DESC
                                    LIMIT 100
                                    """
                                    result = client.execute_query_with_performance_stats(query)
                                elif db_name == 'ClickHouse':
                                    query = """
                                    SELECT 
                                        toStartOfMinute(timestamp) AS bucket,
                                        device_id,
                                        avg(value) as avg_value
                                    FROM iot_metrics 
                                    WHERE timestamp >= now() - INTERVAL 1 HOUR
                                    GROUP BY bucket, device_id
                                    ORDER BY bucket DESC
                                    LIMIT 100
                                    """
                                    result = client.execute_query_with_stats(query)
                                
                                operations.append(('read', len(result) if hasattr(result, '__len__') else 0))
                            
                            else:  # Write operation
                                batch_data = test_data.sample(1000)  # Random 1000 rows
                                
                                if db_name == 'InfluxDB':
                                    client.write_dataframe_optimized(
                                        df=batch_data,
                                        measurement='benchmark_metrics',
                                        tag_columns=['device_id', 'location'],
                                        field_columns=['value']
                                    )
                                elif db_name == 'TimescaleDB':
                                    client.bulk_insert_optimized(
                                        df=batch_data,
                                        table_name='iot_metrics',
                                        chunk_size=1000
                                    )
                                elif db_name == 'ClickHouse':
                                    client.insert_dataframe_optimized(
                                        df=batch_data,
                                        table_name='iot_metrics',
                                        batch_size=1000
                                    )
                                
                                operations.append(('write', 1000))
                        
                        total_time = time.time() - start_time
                        
                        return {
                            'user_id': user_id,
                            'total_time': total_time,
                            'operations': operations,
                            'avg_op_time': total_time / len(operations)
                        }
                    
                    except Exception as e:
                        logging.error(f"Error in concurrent operation for {db_name} user {user_id}: {e}")
                        return None
                
                # Run concurrent operations
                start_time = time.time()
                
                with ThreadPoolExecutor(max_workers=num_users) as executor:
                    futures = [executor.submit(concurrent_operation, i) for i in range(num_users)]
                    results = [f.result() for f in as_completed(futures) if f.result()]
                
                total_time = time.time() - start_time
                
                if results:
                    avg_response_time = np.mean([r['avg_op_time'] for r in results])
                    total_operations = sum(len(r['operations']) for r in results)
                    throughput = total_operations / total_time
                    
                    concurrent_result = {
                        'concurrent_users': num_users,
                        'total_operations': total_operations,
                        'total_time': total_time,
                        'avg_response_time': avg_response_time,
                        'throughput_ops_per_sec': throughput,
                        'successful_users': len(results)
                    }
                    
                    concurrent_results[db_name].append(concurrent_result)
                    logging.info(f"{db_name}: {throughput:.2f} ops/sec with {num_users} users")
        
        return concurrent_results
    
    def _get_query_for_db(self, query_config: Dict[str, Any], db_name: str) -> str:
        """Get database-specific query"""
        
        queries = query_config.get('queries', {})
        return queries.get(db_name)
    
    def generate_report(self, 
                       write_results: Dict[str, List[Dict]],
                       query_results: Dict[str, List[Dict]],
                       concurrent_results: Dict[str, List[Dict]]) -> None:
        """Generate comprehensive benchmark report"""
        
        # Create comparison plots
        self._plot_write_performance(write_results)
        self._plot_query_performance(query_results)
        self._plot_concurrent_performance(concurrent_results)
        
        # Generate summary statistics
        self._print_summary_statistics(write_results, query_results, concurrent_results)
    
    def _plot_write_performance(self, write_results: Dict[str, List[Dict]]) -> None:
        """Plot write performance comparison"""
        
        plt.figure(figsize=(12, 8))
        
        for db_name, results in write_results.items():
            batch_sizes = [r['batch_size'] for r in results]
            throughputs = [r['throughput_rows_per_sec'] for r in results]
            
            plt.subplot(2, 2, 1)
            plt.plot(batch_sizes, throughputs, marker='o', label=db_name)
            plt.xlabel('Batch Size')
            plt.ylabel('Throughput (rows/sec)')
            plt.title('Write Throughput vs Batch Size')
            plt.legend()
            plt.grid(True)
            
            latencies = [r['avg_latency_ms'] for r in results]
            plt.subplot(2, 2, 2)
            plt.plot(batch_sizes, latencies, marker='o', label=db_name)
            plt.xlabel('Batch Size')
            plt.ylabel('Average Latency (ms)')
            plt.title('Write Latency vs Batch Size')
            plt.legend()
            plt.grid(True)
        
        plt.tight_layout()
        plt.savefig('write_performance_comparison.png', dpi=300, bbox_inches='tight')
        plt.show()
    
    def _plot_query_performance(self, query_results: Dict[str, List[Dict]]) -> None:
        """Plot query performance comparison"""
        
        if not query_results:
            return
        
        # Get unique query names
        all_queries = set()
        for results in query_results.values():
            all_queries.update(r['query_name'] for r in results)
        
        query_names = list(all_queries)
        db_names = list(query_results.keys())
        
        # Create performance matrix
        performance_matrix = np.zeros((len(db_names), len(query_names)))
        
        for i, db_name in enumerate(db_names):
            for j, query_name in enumerate(query_names):
                result = next((r for r in query_results[db_name] if r['query_name'] == query_name), None)
                if result:
                    performance_matrix[i, j] = result['avg_time']
        
        # Create heatmap
        plt.figure(figsize=(12, 6))
        sns.heatmap(performance_matrix, 
                   xticklabels=query_names,
                   yticklabels=db_names,
                   annot=True, 
                   fmt='.3f',
                   cmap='YlOrRd',
                   cbar_kws={'label': 'Average Execution Time (seconds)'})
        
        plt.title('Query Performance Comparison')
        plt.xlabel('Query Type')
        plt.ylabel('Database')
        plt.tight_layout()
        plt.savefig('query_performance_comparison.png', dpi=300, bbox_inches='tight')
        plt.show()
    
    def _plot_concurrent_performance(self, concurrent_results: Dict[str, List[Dict]]) -> None:
        """Plot concurrent performance comparison"""
        
        plt.figure(figsize=(12, 6))
        
        for db_name, results in concurrent_results.items():
            users = [r['concurrent_users'] for r in results]
            throughputs = [r['throughput_ops_per_sec'] for r in results]
            response_times = [r['avg_response_time'] for r in results]
            
            plt.subplot(1, 2, 1)
            plt.plot(users, throughputs, marker='o', label=db_name)
            plt.xlabel('Concurrent Users')
            plt.ylabel('Throughput (ops/sec)')
            plt.title('Concurrent Throughput')
            plt.legend()
            plt.grid(True)
            
            plt.subplot(1, 2, 2)
            plt.plot(users, response_times, marker='o', label=db_name)
            plt.xlabel('Concurrent Users')
            plt.ylabel('Average Response Time (seconds)')
            plt.title('Concurrent Response Time')
            plt.legend()
            plt.grid(True)
        
        plt.tight_layout()
        plt.savefig('concurrent_performance_comparison.png', dpi=300, bbox_inches='tight')
        plt.show()
    
    def _print_summary_statistics(self, 
                                 write_results: Dict[str, List[Dict]],
                                 query_results: Dict[str, List[Dict]],
                                 concurrent_results: Dict[str, List[Dict]]) -> None:
        """Print summary statistics"""
        
        print("\n" + "="*80)
        print("TIME SERIES DATABASE BENCHMARK SUMMARY")
        print("="*80)
        
        # Write performance summary
        print("\nWRITE PERFORMANCE SUMMARY:")
        print("-" * 40)
        
        for db_name, results in write_results.items():
            max_throughput = max(r['throughput_rows_per_sec'] for r in results)
            avg_throughput = np.mean([r['throughput_rows_per_sec'] for r in results])
            min_latency = min(r['avg_latency_ms'] for r in results)
            
            print(f"{db_name}:")
            print(f"  Max Throughput: {max_throughput:,.0f} rows/sec")
            print(f"  Avg Throughput: {avg_throughput:,.0f} rows/sec")
            print(f"  Min Latency: {min_latency:.2f} ms")
        
        # Query performance summary
        if query_results:
            print("\nQUERY PERFORMANCE SUMMARY:")
            print("-" * 40)
            
            for db_name, results in query_results.items():
                avg_query_time = np.mean([r['avg_time'] for r in results])
                fastest_query = min(results, key=lambda x: x['avg_time'])
                
                print(f"{db_name}:")
                print(f"  Average Query Time: {avg_query_time:.3f} seconds")
                print(f"  Fastest Query: {fastest_query['query_name']} ({fastest_query['avg_time']:.3f}s)")
        
        # Concurrent performance summary
        if concurrent_results:
            print("\nCONCURRENT PERFORMANCE SUMMARY:")
            print("-" * 40)
            
            for db_name, results in concurrent_results.items():
                max_throughput = max(r['throughput_ops_per_sec'] for r in results)
                best_response_time = min(r['avg_response_time'] for r in results)
                
                print(f"{db_name}:")
                print(f"  Max Concurrent Throughput: {max_throughput:.2f} ops/sec")
                print(f"  Best Response Time: {best_response_time:.3f} seconds")

# Example benchmark execution
def run_comprehensive_benchmark():
    """Run comprehensive benchmark across all databases"""
    
    # Initialize clients (configure with your actual connection details)
    influxdb_client = OptimizedInfluxDBClient(
        url="http://localhost:8086",
        token="your-token",
        org="your-org",
        bucket="benchmark"
    )
    
    timescaledb_client = OptimizedTimescaleDBClient(
        connection_string="postgresql://user:password@localhost:5432/benchmark_db"
    )
    
    clickhouse_client = OptimizedClickHouseClient(
        host='localhost',
        port=8123,
        database='benchmark'
    )
    
    # Create benchmark framework
    benchmark = TimeSeriesDBBenchmark(
        influxdb_client=influxdb_client,
        timescaledb_client=timescaledb_client,
        clickhouse_client=clickhouse_client
    )
    
    # Generate test data
    generator = TimeSeriesDataGenerator(
        metrics=['temperature', 'humidity', 'pressure', 'voltage'],
        devices=[f'sensor_{i:03d}' for i in range(1000)]
    )
    
    test_data = generator.generate_iot_metrics(duration_hours=24, interval_seconds=30)
    
    # Define query configurations
    query_configs = [
        {
            'name': 'simple_aggregation',
            'queries': {
                'InfluxDB': '''
                from(bucket: "benchmark")
                  |> range(start: -1h)
                  |> filter(fn: (r) => r._measurement == "benchmark_metrics")
                  |> aggregateWindow(every: 5m, fn: mean)
                ''',
                'TimescaleDB': '''
                SELECT 
                    time_bucket('5 minutes', time) AS bucket,
                    avg(value) as avg_value
                FROM iot_metrics 
                WHERE time >= NOW() - INTERVAL '1 hour'
                GROUP BY bucket
                ORDER BY bucket
                ''',
                'ClickHouse': '''
                SELECT 
                    toStartOfInterval(timestamp, INTERVAL 5 MINUTE) AS bucket,
                    avg(value) as avg_value
                FROM iot_metrics 
                WHERE timestamp >= now() - INTERVAL 1 HOUR
                GROUP BY bucket
                ORDER BY bucket
                '''
            }
        },
        {
            'name': 'complex_aggregation',
            'queries': {
                'TimescaleDB': '''
                SELECT 
                    device_id,
                    percentile_cont(0.95) WITHIN GROUP (ORDER BY value) as p95,
                    percentile_cont(0.99) WITHIN GROUP (ORDER BY value) as p99
                FROM iot_metrics 
                WHERE time >= NOW() - INTERVAL '24 hours'
                GROUP BY device_id
                ORDER BY p99 DESC
                LIMIT 20
                ''',
                'ClickHouse': '''
                SELECT 
                    device_id,
                    quantile(0.95)(value) as p95,
                    quantile(0.99)(value) as p99
                FROM iot_metrics 
                WHERE timestamp >= now() - INTERVAL 24 HOUR
                GROUP BY device_id
                ORDER BY p99 DESC
                LIMIT 20
                '''
            }
        }
    ]
    
    # Run benchmarks
    print("Starting comprehensive benchmark...")
    
    write_results = benchmark.benchmark_writes(test_data, batch_sizes=[1000, 5000, 10000, 50000])
    query_results = benchmark.benchmark_queries(query_configs)
    concurrent_results = benchmark.benchmark_concurrent_operations(test_data, concurrent_users=[1, 5, 10, 20])
    
    # Generate report
    benchmark.generate_report(write_results, query_results, concurrent_results)
    
    # Cleanup
    influxdb_client.close()
    clickhouse_client.close()

if __name__ == "__main__":
    run_comprehensive_benchmark()
```

## Conclusion

Time series databases each offer unique advantages for different use cases:

**InfluxDB Strengths:**
- Purpose-built for time series data with intuitive Flux query language
- Excellent for IoT and monitoring use cases
- Strong ecosystem integration and cloud offerings
- Built-in data retention and downsampling capabilities

**TimescaleDB Advantages:**
- Combines SQL familiarity with time series optimizations
- Excellent for complex analytical queries
- Strong consistency and ACID compliance
- Seamless integration with PostgreSQL ecosystem

**ClickHouse Benefits:**
- Exceptional performance for analytical workloads
- Superior compression ratios for cost-effective storage
- Excellent for high-cardinality data and complex aggregations
- Strong performance at massive scale

**Selection Criteria:**
1. **Data Volume**: ClickHouse for massive scale, TimescaleDB for moderate scale, InfluxDB for IoT/monitoring
2. **Query Complexity**: TimescaleDB for complex SQL analytics, ClickHouse for OLAP workloads
3. **Ecosystem**: TimescaleDB for PostgreSQL environments, InfluxDB for cloud-native deployments
4. **Performance Requirements**: ClickHouse for maximum throughput, InfluxDB for operational simplicity
5. **Team Expertise**: TimescaleDB for SQL-experienced teams, InfluxDB for time series specialists

Proper optimization strategies, indexing, partitioning, and hardware configuration are crucial for achieving optimal performance with any time series database. The choice ultimately depends on your specific requirements, scale, and team capabilities.