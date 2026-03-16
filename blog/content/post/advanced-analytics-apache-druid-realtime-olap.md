---
title: "Advanced Analytics with Apache Druid and Real-Time OLAP: High-Performance Time-Series and Event Analysis"
date: 2026-03-19T00:00:00-05:00
draft: false
description: "Comprehensive guide to implementing advanced real-time analytics with Apache Druid, covering architecture design, ingestion strategies, query optimization, and production deployment for high-scale time-series and event analysis."
keywords: ["apache druid", "real-time analytics", "OLAP", "time-series database", "streaming analytics", "data ingestion", "query optimization", "distributed analytics", "event processing"]
tags: ["apache-druid", "real-time-analytics", "olap", "time-series", "streaming", "analytics", "performance", "distributed-systems"]
categories: ["Data Engineering", "Analytics", "Real-Time Systems"]
author: "Support Tools Team"
canonical: "https://support.tools/blog/advanced-analytics-apache-druid-realtime-olap/"
---

# Advanced Analytics with Apache Druid and Real-Time OLAP: High-Performance Time-Series and Event Analysis

Apache Druid is a high-performance, column-oriented, distributed data store designed for real-time analytics on large datasets. It excels at powering interactive applications that require sub-second queries on time-series data, making it ideal for business intelligence dashboards, real-time monitoring, and exploratory analytics.

This comprehensive guide explores advanced techniques for implementing, optimizing, and scaling Apache Druid for enterprise real-time analytics workloads, covering everything from architecture design to production deployment strategies.

## Understanding Apache Druid Architecture

### Core Components and Design Principles

Apache Druid's architecture is built around several key design principles: real-time ingestion, columnar storage, distributed processing, and approximate algorithms for fast aggregations.

```yaml
# Docker Compose configuration for Druid cluster
version: '3.8'

services:
  # Zookeeper for coordination
  zookeeper:
    image: apache/druid:latest
    container_name: druid-zookeeper
    environment:
      - DRUID_XMX=512m
      - DRUID_XMS=512m
    command: ["start-micro-quickstart"]
    ports:
      - "2181:2181"
    volumes:
      - zookeeper_data:/opt/zookeeper/data

  # Deep Storage (S3 compatible)
  minio:
    image: minio/minio:latest
    container_name: druid-minio
    environment:
      - MINIO_ACCESS_KEY=minioadmin
      - MINIO_SECRET_KEY=minioadmin
    command: server /data
    ports:
      - "9001:9000"
    volumes:
      - minio_data:/data

  # Metadata storage
  postgres:
    image: postgres:13
    container_name: druid-postgres
    environment:
      - POSTGRES_DB=druid
      - POSTGRES_USER=druid
      - POSTGRES_PASSWORD=druid123
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  # Druid Coordinator
  coordinator:
    image: apache/druid:latest
    container_name: druid-coordinator
    environment:
      - DRUID_XMX=1g
      - DRUID_XMS=1g
    command: ["coordinator"]
    depends_on:
      - zookeeper
      - postgres
    ports:
      - "8081:8081"
    volumes:
      - ./config:/opt/druid/conf:ro
      - coordinator_var:/opt/druid/var

  # Druid Overlord
  overlord:
    image: apache/druid:latest
    container_name: druid-overlord
    environment:
      - DRUID_XMX=1g
      - DRUID_XMS=1g
    command: ["overlord"]
    depends_on:
      - zookeeper
      - postgres
    ports:
      - "8090:8090"
    volumes:
      - ./config:/opt/druid/conf:ro
      - overlord_var:/opt/druid/var

  # Druid Broker
  broker:
    image: apache/druid:latest
    container_name: druid-broker
    environment:
      - DRUID_XMX=2g
      - DRUID_XMS=2g
    command: ["broker"]
    depends_on:
      - zookeeper
      - coordinator
    ports:
      - "8082:8082"
    volumes:
      - ./config:/opt/druid/conf:ro
      - broker_var:/opt/druid/var

  # Druid Router
  router:
    image: apache/druid:latest
    container_name: druid-router
    environment:
      - DRUID_XMX=512m
      - DRUID_XMS=512m
    command: ["router"]
    depends_on:
      - broker
    ports:
      - "8888:8888"
    volumes:
      - ./config:/opt/druid/conf:ro

  # Druid Historical
  historical:
    image: apache/druid:latest
    container_name: druid-historical
    environment:
      - DRUID_XMX=2g
      - DRUID_XMS=2g
    command: ["historical"]
    depends_on:
      - zookeeper
      - coordinator
      - minio
    volumes:
      - ./config:/opt/druid/conf:ro
      - historical_var:/opt/druid/var
      - historical_storage:/opt/druid/segments

  # Druid MiddleManager
  middlemanager:
    image: apache/druid:latest
    container_name: druid-middlemanager
    environment:
      - DRUID_XMX=1g
      - DRUID_XMS=1g
    command: ["middleManager"]
    depends_on:
      - zookeeper
      - overlord
      - minio
    volumes:
      - ./config:/opt/druid/conf:ro
      - middlemanager_var:/opt/druid/var

volumes:
  zookeeper_data:
  minio_data:
  postgres_data:
  coordinator_var:
  overlord_var:
  broker_var:
  historical_var:
  historical_storage:
  middlemanager_var:
```

### Advanced Configuration for Production

```properties
# config/druid/cluster/_common/common.runtime.properties
# Production-optimized Druid configuration

# Extensions
druid.extensions.loadList=["druid-hdfs-storage", "druid-kafka-indexing-service", "druid-datasketches", "druid-lookups-cached-global", "postgresql-metadata-storage", "druid-parquet-extensions", "druid-avro-extensions", "druid-protobuf-extensions", "druid-orc-extensions"]

# Metadata storage
druid.metadata.storage.type=postgresql
druid.metadata.storage.connector.connectURI=jdbc:postgresql://postgres:5432/druid
druid.metadata.storage.connector.user=druid
druid.metadata.storage.connector.password=druid123

# Deep storage
druid.storage.type=s3
druid.storage.bucket=druid-deep-storage
druid.storage.baseKey=druid/segments
druid.s3.accessKey=minioadmin
druid.s3.secretKey=minioadmin
druid.s3.endpoint.url=http://minio:9000

# Indexing service logs
druid.indexer.logs.type=s3
druid.indexer.logs.s3Bucket=druid-deep-storage
druid.indexer.logs.s3Prefix=druid/indexing-logs

# Service discovery
druid.selectors.indexing.serviceName=druid/overlord
druid.selectors.coordinator.serviceName=druid/coordinator

# Monitoring
druid.monitoring.monitors=["org.apache.druid.java.util.metrics.JvmMonitor"]
druid.emitter=composing
druid.emitter.composing.emitters=["logging","http"]
druid.emitter.http.recipientBaseUrl=http://your-metrics-endpoint

# Query processing
druid.processing.buffer.sizeBytes=536870912  # 512MB
druid.processing.numMergeBuffers=4
druid.processing.numThreads=8

# Security
druid.auth.authenticatorChain=["basic"]
druid.auth.authenticator.basic.type=basic
druid.auth.authenticator.basic.initialAdminPassword=admin123
druid.auth.authenticator.basic.initialInternalClientPassword=internal123
druid.auth.authorizers=["basic"]
druid.auth.authorizer.basic.type=basic

# SQL
druid.sql.enable=true
druid.sql.avatica.enable=true
druid.sql.avatica.maxConnections=50
druid.sql.avatica.maxStatementsPerConnection=10

# Caching
druid.cache.type=caffeine
druid.cache.sizeInBytes=1073741824  # 1GB
druid.cache.expiration=3600000  # 1 hour

# Request logging
druid.request.logging.type=slf4j
druid.request.logging.setMDC=true
```

```python
# Advanced Druid client and data management
import requests
import json
import pandas as pd
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
import asyncio
import aiohttp
from dataclasses import dataclass
import logging

@dataclass
class DruidDataSource:
    """Druid datasource configuration"""
    name: str
    dimensions: List[str]
    metrics: List[Dict[str, Any]]
    granularity: str
    intervals: List[str]
    segments_size: int = 50000000  # 50MB default
    rollup: bool = True

class DruidClient:
    """Advanced Druid client for analytics operations"""
    
    def __init__(self, router_url: str = "http://localhost:8888", 
                 auth: Optional[tuple] = None):
        self.router_url = router_url.rstrip('/')
        self.auth = auth
        self.session = requests.Session()
        if auth:
            self.session.auth = auth
    
    def create_kafka_ingestion_spec(self, datasource_name: str, 
                                   kafka_config: Dict[str, Any],
                                   schema_config: Dict[str, Any]) -> Dict[str, Any]:
        """Create Kafka ingestion specification"""
        
        spec = {
            "type": "kafka",
            "spec": {
                "dataSchema": {
                    "dataSource": datasource_name,
                    "timestampSpec": {
                        "column": schema_config.get("timestamp_column", "__time"),
                        "format": schema_config.get("timestamp_format", "iso")
                    },
                    "dimensionsSpec": {
                        "dimensions": schema_config.get("dimensions", []),
                        "dimensionExclusions": schema_config.get("dimension_exclusions", [])
                    },
                    "metricsSpec": schema_config.get("metrics", []),
                    "granularitySpec": {
                        "type": "uniform",
                        "segmentGranularity": schema_config.get("segment_granularity", "HOUR"),
                        "queryGranularity": schema_config.get("query_granularity", "MINUTE"),
                        "rollup": schema_config.get("rollup", True)
                    },
                    "transformSpec": {
                        "transforms": schema_config.get("transforms", [])
                    }
                },
                "ioConfig": {
                    "topic": kafka_config["topic"],
                    "consumerProperties": {
                        "bootstrap.servers": kafka_config["bootstrap_servers"],
                        "group.id": kafka_config.get("consumer_group", f"{datasource_name}-druid"),
                        "auto.offset.reset": kafka_config.get("auto_offset_reset", "latest"),
                        "enable.auto.commit": "false"
                    },
                    "taskCount": kafka_config.get("task_count", 1),
                    "replicas": kafka_config.get("replicas", 1),
                    "taskDuration": kafka_config.get("task_duration", "PT1H"),
                    "useEarliestOffset": kafka_config.get("use_earliest_offset", False)
                },
                "tuningConfig": {
                    "type": "kafka",
                    "maxRowsPerSegment": schema_config.get("max_rows_per_segment", 5000000),
                    "maxRowsInMemory": schema_config.get("max_rows_in_memory", 1000000),
                    "intermediatePersistPeriod": schema_config.get("intermediate_persist_period", "PT10M"),
                    "handoffConditionTimeout": kafka_config.get("handoff_timeout", 900000),
                    "resetOffsetAutomatically": kafka_config.get("reset_offset_automatically", False),
                    "skipOffsetGaps": kafka_config.get("skip_offset_gaps", False),
                    "workerThreads": kafka_config.get("worker_threads", 1)
                }
            }
        }
        
        return spec
    
    def submit_ingestion_task(self, ingestion_spec: Dict[str, Any]) -> Dict[str, Any]:
        """Submit ingestion task to Druid"""
        
        url = f"{self.router_url}/druid/indexer/v1/task"
        
        response = self.session.post(url, json=ingestion_spec)
        response.raise_for_status()
        
        result = response.json()
        logging.info(f"Submitted ingestion task: {result.get('task')}")
        
        return result
    
    def get_task_status(self, task_id: str) -> Dict[str, Any]:
        """Get status of ingestion task"""
        
        url = f"{self.router_url}/druid/indexer/v1/task/{task_id}/status"
        
        response = self.session.get(url)
        response.raise_for_status()
        
        return response.json()
    
    def query_sql(self, sql_query: str, context: Optional[Dict[str, Any]] = None) -> pd.DataFrame:
        """Execute SQL query against Druid"""
        
        url = f"{self.router_url}/druid/v2/sql"
        
        payload = {
            "query": sql_query,
            "context": context or {},
            "header": True,
            "typesHeader": True,
            "sqlTypesHeader": True
        }
        
        response = self.session.post(url, json=payload)
        response.raise_for_status()
        
        result = response.json()
        
        if not result:
            return pd.DataFrame()
        
        # Parse response into DataFrame
        columns = result[0]
        types = result[1] if len(result) > 1 else None
        data = result[2:] if len(result) > 2 else []
        
        df = pd.DataFrame(data, columns=columns)
        
        return df
    
    def query_native(self, query: Dict[str, Any]) -> Dict[str, Any]:
        """Execute native Druid query"""
        
        url = f"{self.router_url}/druid/v2/"
        
        response = self.session.post(url, json=query)
        response.raise_for_status()
        
        return response.json()
    
    def get_datasources(self) -> List[str]:
        """Get list of available datasources"""
        
        url = f"{self.router_url}/druid/coordinator/v1/datasources"
        
        response = self.session.get(url)
        response.raise_for_status()
        
        return response.json()
    
    def get_datasource_schema(self, datasource: str) -> Dict[str, Any]:
        """Get schema information for datasource"""
        
        url = f"{self.router_url}/druid/coordinator/v1/datasources/{datasource}"
        
        response = self.session.get(url)
        response.raise_for_status()
        
        return response.json()
    
    def optimize_segments(self, datasource: str, interval: str) -> Dict[str, Any]:
        """Optimize segments for better query performance"""
        
        compaction_config = {
            "type": "compact",
            "dataSource": datasource,
            "interval": interval,
            "tuningConfig": {
                "type": "index_parallel",
                "maxRowsPerSegment": 5000000,
                "maxNumConcurrentSubTasks": 4
            },
            "context": {
                "useLineageBasedSegmentAllocation": True
            }
        }
        
        return self.submit_ingestion_task(compaction_config)

# Advanced query optimization and performance tuning
class DruidQueryOptimizer:
    """Optimize Druid queries for performance"""
    
    def __init__(self, client: DruidClient):
        self.client = client
        
    def analyze_query_performance(self, sql_query: str) -> Dict[str, Any]:
        """Analyze query performance and suggest optimizations"""
        
        # Add query context for performance analysis
        context = {
            "enableInnerJoin": True,
            "enableOuterJoin": True,
            "enableScanSignature": True,
            "useApproximateCountDistinct": False,
            "sqlTimeZone": "UTC"
        }
        
        # Execute with explain plan
        explain_query = f"EXPLAIN PLAN FOR {sql_query}"
        
        try:
            explain_result = self.client.query_sql(explain_query, context)
            performance_metrics = self._extract_performance_metrics(explain_result)
            
            optimizations = self._suggest_optimizations(sql_query, performance_metrics)
            
            return {
                "original_query": sql_query,
                "explain_plan": explain_result,
                "performance_metrics": performance_metrics,
                "optimization_suggestions": optimizations
            }
            
        except Exception as e:
            logging.error(f"Query analysis failed: {e}")
            return {"error": str(e)}
    
    def _extract_performance_metrics(self, explain_result: pd.DataFrame) -> Dict[str, Any]:
        """Extract performance metrics from explain plan"""
        
        metrics = {
            "estimated_rows": 0,
            "scan_operations": 0,
            "join_operations": 0,
            "aggregation_operations": 0,
            "sort_operations": 0
        }
        
        if not explain_result.empty:
            plan_text = str(explain_result.iloc[0, 0]) if len(explain_result.columns) > 0 else ""
            
            # Simple parsing of explain plan
            metrics["scan_operations"] = plan_text.count("DruidTableScan")
            metrics["join_operations"] = plan_text.count("Join")
            metrics["aggregation_operations"] = plan_text.count("Aggregate")
            metrics["sort_operations"] = plan_text.count("Sort")
        
        return metrics
    
    def _suggest_optimizations(self, query: str, metrics: Dict[str, Any]) -> List[str]:
        """Suggest query optimizations based on analysis"""
        
        suggestions = []
        
        # Check for time filtering
        if "__time" not in query.upper() and "TIME" in query.upper():
            suggestions.append("Add explicit time filtering to leverage time partitioning")
        
        # Check for proper WHERE clauses
        if "WHERE" not in query.upper():
            suggestions.append("Add WHERE clauses to filter data and improve performance")
        
        # Check for COUNT DISTINCT
        if "COUNT(DISTINCT" in query.upper():
            suggestions.append("Consider using APPROX_COUNT_DISTINCT for better performance")
        
        # Check for complex joins
        if metrics["join_operations"] > 2:
            suggestions.append("Consider denormalizing data or using lookup joins for better performance")
        
        # Check for sorting
        if metrics["sort_operations"] > 0:
            suggestions.append("Consider if sorting is necessary, as it can impact performance")
        
        return suggestions
    
    def optimize_time_series_query(self, datasource: str, 
                                  time_column: str,
                                  start_time: str,
                                  end_time: str,
                                  metrics: List[str],
                                  dimensions: List[str] = None,
                                  granularity: str = "PT1H") -> str:
        """Generate optimized time-series query"""
        
        dimensions = dimensions or []
        
        # Build SELECT clause
        select_parts = [f"TIME_FLOOR({time_column}, '{granularity}') AS time_bucket"]
        
        if dimensions:
            select_parts.extend(dimensions)
        
        # Add aggregated metrics
        for metric in metrics:
            if metric.startswith("count"):
                select_parts.append(f"COUNT(*) AS {metric}")
            elif metric.startswith("sum_"):
                column = metric.replace("sum_", "")
                select_parts.append(f"SUM({column}) AS {metric}")
            elif metric.startswith("avg_"):
                column = metric.replace("avg_", "")
                select_parts.append(f"AVG({column}) AS {metric}")
            elif metric.startswith("max_"):
                column = metric.replace("max_", "")
                select_parts.append(f"MAX({column}) AS {metric}")
            elif metric.startswith("min_"):
                column = metric.replace("min_", "")
                select_parts.append(f"MIN({column}) AS {metric}")
            else:
                select_parts.append(metric)
        
        # Build GROUP BY clause
        group_by_parts = ["time_bucket"]
        if dimensions:
            group_by_parts.extend(dimensions)
        
        # Construct optimized query
        query = f"""
        SELECT {', '.join(select_parts)}
        FROM {datasource}
        WHERE {time_column} >= TIMESTAMP '{start_time}'
          AND {time_column} < TIMESTAMP '{end_time}'
        GROUP BY {', '.join(group_by_parts)}
        ORDER BY time_bucket
        """
        
        return query.strip()

# Real-time analytics dashboard implementation
class DruidAnalyticsDashboard:
    """Real-time analytics dashboard powered by Druid"""
    
    def __init__(self, client: DruidClient):
        self.client = client
        self.cached_queries = {}
        
    def get_real_time_metrics(self, datasource: str, 
                            time_window: str = "PT1H") -> Dict[str, Any]:
        """Get real-time metrics for dashboard"""
        
        current_time = datetime.utcnow()
        
        # Calculate time window
        if time_window == "PT1H":
            start_time = current_time - timedelta(hours=1)
        elif time_window == "PT24H":
            start_time = current_time - timedelta(days=1)
        elif time_window == "PT7D":
            start_time = current_time - timedelta(days=7)
        else:
            start_time = current_time - timedelta(hours=1)
        
        # Query for key metrics
        metrics_query = f"""
        SELECT 
            COUNT(*) as event_count,
            COUNT(DISTINCT user_id) as unique_users,
            AVG(CAST(value AS DOUBLE)) as avg_value,
            MAX(CAST(value AS DOUBLE)) as max_value,
            MIN(CAST(value AS DOUBLE)) as min_value,
            APPROX_COUNT_DISTINCT(session_id) as unique_sessions
        FROM {datasource}
        WHERE __time >= TIMESTAMP '{start_time.isoformat()}'
          AND __time < TIMESTAMP '{current_time.isoformat()}'
        """
        
        try:
            result = self.client.query_sql(metrics_query)
            
            if not result.empty:
                return {
                    "event_count": int(result.iloc[0]["event_count"]),
                    "unique_users": int(result.iloc[0]["unique_users"]),
                    "avg_value": float(result.iloc[0]["avg_value"]) if result.iloc[0]["avg_value"] else 0,
                    "max_value": float(result.iloc[0]["max_value"]) if result.iloc[0]["max_value"] else 0,
                    "min_value": float(result.iloc[0]["min_value"]) if result.iloc[0]["min_value"] else 0,
                    "unique_sessions": int(result.iloc[0]["unique_sessions"]),
                    "time_window": time_window,
                    "last_updated": current_time.isoformat()
                }
            else:
                return {"error": "No data found"}
                
        except Exception as e:
            logging.error(f"Failed to get real-time metrics: {e}")
            return {"error": str(e)}
    
    def get_time_series_data(self, datasource: str, 
                           metric: str,
                           granularity: str = "PT5M",
                           time_window: str = "PT1H") -> List[Dict[str, Any]]:
        """Get time-series data for visualization"""
        
        current_time = datetime.utcnow()
        
        # Calculate time window
        if time_window == "PT1H":
            start_time = current_time - timedelta(hours=1)
        elif time_window == "PT24H":
            start_time = current_time - timedelta(days=1)
        elif time_window == "PT7D":
            start_time = current_time - timedelta(days=7)
        else:
            start_time = current_time - timedelta(hours=1)
        
        # Build aggregation based on metric type
        if metric == "event_count":
            agg_expr = "COUNT(*)"
        elif metric == "unique_users":
            agg_expr = "APPROX_COUNT_DISTINCT(user_id)"
        elif metric == "avg_value":
            agg_expr = "AVG(CAST(value AS DOUBLE))"
        elif metric == "sum_value":
            agg_expr = "SUM(CAST(value AS DOUBLE))"
        else:
            agg_expr = "COUNT(*)"
        
        query = f"""
        SELECT 
            TIME_FLOOR(__time, '{granularity}') as time_bucket,
            {agg_expr} as metric_value
        FROM {datasource}
        WHERE __time >= TIMESTAMP '{start_time.isoformat()}'
          AND __time < TIMESTAMP '{current_time.isoformat()}'
        GROUP BY TIME_FLOOR(__time, '{granularity}')
        ORDER BY time_bucket
        """
        
        try:
            result = self.client.query_sql(query)
            
            time_series = []
            for _, row in result.iterrows():
                time_series.append({
                    "timestamp": row["time_bucket"],
                    "value": float(row["metric_value"]) if row["metric_value"] else 0
                })
            
            return time_series
            
        except Exception as e:
            logging.error(f"Failed to get time-series data: {e}")
            return []
    
    def get_top_n_analysis(self, datasource: str, 
                          dimension: str,
                          metric: str = "count",
                          limit: int = 10,
                          time_window: str = "PT1H") -> List[Dict[str, Any]]:
        """Get top N analysis for specified dimension"""
        
        current_time = datetime.utcnow()
        
        # Calculate time window
        if time_window == "PT1H":
            start_time = current_time - timedelta(hours=1)
        elif time_window == "PT24H":
            start_time = current_time - timedelta(days=1)
        elif time_window == "PT7D":
            start_time = current_time - timedelta(days=7)
        else:
            start_time = current_time - timedelta(hours=1)
        
        # Build aggregation
        if metric == "count":
            agg_expr = "COUNT(*)"
        elif metric == "unique_users":
            agg_expr = "APPROX_COUNT_DISTINCT(user_id)"
        elif metric == "sum_value":
            agg_expr = "SUM(CAST(value AS DOUBLE))"
        elif metric == "avg_value":
            agg_expr = "AVG(CAST(value AS DOUBLE))"
        else:
            agg_expr = "COUNT(*)"
        
        query = f"""
        SELECT 
            {dimension},
            {agg_expr} as metric_value
        FROM {datasource}
        WHERE __time >= TIMESTAMP '{start_time.isoformat()}'
          AND __time < TIMESTAMP '{current_time.isoformat()}'
          AND {dimension} IS NOT NULL
        GROUP BY {dimension}
        ORDER BY metric_value DESC
        LIMIT {limit}
        """
        
        try:
            result = self.client.query_sql(query)
            
            top_n = []
            for _, row in result.iterrows():
                top_n.append({
                    dimension: row[dimension],
                    "value": float(row["metric_value"]) if row["metric_value"] else 0
                })
            
            return top_n
            
        except Exception as e:
            logging.error(f"Failed to get top N analysis: {e}")
            return []
    
    async def get_dashboard_data(self, datasource: str, 
                               time_window: str = "PT1H") -> Dict[str, Any]:
        """Get comprehensive dashboard data asynchronously"""
        
        # Run multiple queries concurrently
        tasks = [
            asyncio.create_task(self._async_query(
                lambda: self.get_real_time_metrics(datasource, time_window)
            )),
            asyncio.create_task(self._async_query(
                lambda: self.get_time_series_data(datasource, "event_count", "PT5M", time_window)
            )),
            asyncio.create_task(self._async_query(
                lambda: self.get_top_n_analysis(datasource, "country", "count", 10, time_window)
            )),
            asyncio.create_task(self._async_query(
                lambda: self.get_top_n_analysis(datasource, "device_type", "unique_users", 10, time_window)
            ))
        ]
        
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        return {
            "real_time_metrics": results[0] if not isinstance(results[0], Exception) else None,
            "time_series": results[1] if not isinstance(results[1], Exception) else None,
            "top_countries": results[2] if not isinstance(results[2], Exception) else None,
            "top_devices": results[3] if not isinstance(results[3], Exception) else None,
            "generated_at": datetime.utcnow().isoformat()
        }
    
    async def _async_query(self, query_func: callable):
        """Execute query function asynchronously"""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, query_func)

# Advanced streaming data processing
class DruidStreamProcessor:
    """Process streaming data for real-time ingestion into Druid"""
    
    def __init__(self, client: DruidClient, kafka_config: Dict[str, Any]):
        self.client = client
        self.kafka_config = kafka_config
        
    def create_streaming_ingestion(self, datasource_name: str,
                                 stream_schema: Dict[str, Any]) -> str:
        """Create streaming ingestion task for real-time data"""
        
        # Define transforms for data enrichment
        transforms = [
            {
                "type": "expression",
                "name": "event_hour",
                "expression": "timestamp_floor(__time, 'PT1H')"
            },
            {
                "type": "expression", 
                "name": "user_segment",
                "expression": "case_searched((user_tier == 'premium'), 'premium', (user_tier == 'gold'), 'gold', 'standard')"
            }
        ]
        
        # Define metrics with rollup
        metrics = [
            {
                "type": "count",
                "name": "event_count"
            },
            {
                "type": "longSum",
                "name": "total_value",
                "fieldName": "value"
            },
            {
                "type": "doubleSum",
                "name": "revenue",
                "fieldName": "revenue_amount"
            },
            {
                "type": "hyperUnique",
                "name": "unique_users", 
                "fieldName": "user_id"
            },
            {
                "type": "thetaSketch",
                "name": "unique_sessions",
                "fieldName": "session_id"
            }
        ]
        
        ingestion_spec = self.client.create_kafka_ingestion_spec(
            datasource_name=datasource_name,
            kafka_config=self.kafka_config,
            schema_config={
                "timestamp_column": "__time",
                "timestamp_format": "iso",
                "dimensions": stream_schema.get("dimensions", []),
                "metrics": metrics,
                "transforms": transforms,
                "segment_granularity": "HOUR",
                "query_granularity": "MINUTE",
                "rollup": True,
                "max_rows_per_segment": 5000000,
                "max_rows_in_memory": 1000000
            }
        )
        
        result = self.client.submit_ingestion_task(ingestion_spec)
        return result.get("task")
    
    def monitor_ingestion_health(self, task_id: str) -> Dict[str, Any]:
        """Monitor health and performance of streaming ingestion"""
        
        status = self.client.get_task_status(task_id)
        
        health_metrics = {
            "task_id": task_id,
            "status": status.get("status", {}).get("status"),
            "created_time": status.get("status", {}).get("createdTime"),
            "duration": status.get("status", {}).get("duration"),
            "location": status.get("status", {}).get("location"),
            "error_msg": status.get("status", {}).get("errorMsg")
        }
        
        # Get additional metrics if available
        if health_metrics["status"] == "RUNNING":
            # Query for ingestion rate and lag metrics
            try:
                # This would typically come from Druid metrics
                health_metrics.update({
                    "ingestion_rate": "N/A",  # events/second
                    "lag_milliseconds": "N/A",  # consumer lag
                    "segments_created": "N/A",  # number of segments
                    "rows_processed": "N/A"  # total rows processed
                })
            except Exception as e:
                logging.warning(f"Could not fetch detailed metrics: {e}")
        
        return health_metrics
    
    def setup_data_quality_monitoring(self, datasource: str) -> Dict[str, Any]:
        """Set up data quality monitoring for streaming data"""
        
        quality_checks = {
            "freshness_check": {
                "query": f"""
                SELECT MAX(__time) as last_event_time,
                       MILLIS_TO_TIMESTAMP(UNIX_TIMESTAMP() * 1000) as current_time,
                       (UNIX_TIMESTAMP() * 1000 - TIME_EXTRACT(MAX(__time), 'EPOCH', 'MILLISECOND')) / 1000 as lag_seconds
                FROM {datasource}
                WHERE __time >= CURRENT_TIMESTAMP - INTERVAL '1' HOUR
                """,
                "threshold_seconds": 300  # 5 minutes
            },
            "volume_check": {
                "query": f"""
                SELECT COUNT(*) as event_count,
                       COUNT(*) / 3600.0 as events_per_second
                FROM {datasource}
                WHERE __time >= CURRENT_TIMESTAMP - INTERVAL '1' HOUR
                """,
                "min_events_per_second": 1.0
            },
            "completeness_check": {
                "query": f"""
                SELECT 
                    COUNT(*) as total_events,
                    COUNT(user_id) as events_with_user_id,
                    COUNT(session_id) as events_with_session_id,
                    (COUNT(user_id) * 1.0 / COUNT(*)) as user_id_completeness,
                    (COUNT(session_id) * 1.0 / COUNT(*)) as session_id_completeness
                FROM {datasource}
                WHERE __time >= CURRENT_TIMESTAMP - INTERVAL '1' HOUR
                """,
                "min_completeness": 0.95  # 95%
            }
        }
        
        return quality_checks
    
    def run_quality_checks(self, quality_checks: Dict[str, Any]) -> Dict[str, Any]:
        """Run data quality checks and return results"""
        
        results = {}
        
        for check_name, check_config in quality_checks.items():
            try:
                result = self.client.query_sql(check_config["query"])
                
                if not result.empty:
                    check_result = {
                        "status": "passed",
                        "data": result.to_dict('records')[0],
                        "timestamp": datetime.utcnow().isoformat()
                    }
                    
                    # Apply specific validation logic
                    if check_name == "freshness_check":
                        lag_seconds = check_result["data"].get("lag_seconds", float('inf'))
                        if lag_seconds > check_config["threshold_seconds"]:
                            check_result["status"] = "failed"
                            check_result["reason"] = f"Data lag ({lag_seconds}s) exceeds threshold ({check_config['threshold_seconds']}s)"
                    
                    elif check_name == "volume_check":
                        events_per_second = check_result["data"].get("events_per_second", 0)
                        if events_per_second < check_config["min_events_per_second"]:
                            check_result["status"] = "failed"
                            check_result["reason"] = f"Event rate ({events_per_second:.2f}/s) below threshold ({check_config['min_events_per_second']}/s)"
                    
                    elif check_name == "completeness_check":
                        user_completeness = check_result["data"].get("user_id_completeness", 0)
                        session_completeness = check_result["data"].get("session_id_completeness", 0)
                        min_completeness = check_config["min_completeness"]
                        
                        if user_completeness < min_completeness or session_completeness < min_completeness:
                            check_result["status"] = "failed"
                            check_result["reason"] = f"Completeness below threshold: user_id({user_completeness:.2%}), session_id({session_completeness:.2%})"
                    
                    results[check_name] = check_result
                else:
                    results[check_name] = {
                        "status": "failed",
                        "reason": "No data returned from query"
                    }
                    
            except Exception as e:
                results[check_name] = {
                    "status": "error",
                    "reason": str(e)
                }
        
        return results
```

## Advanced Query Optimization and Performance Tuning

### Native Query Optimization

```python
# Advanced native query construction and optimization
class DruidNativeQueryBuilder:
    """Build and optimize native Druid queries"""
    
    def __init__(self):
        self.query_templates = {}
        
    def build_timeseries_query(self, datasource: str,
                              intervals: List[str],
                              granularity: str,
                              aggregations: List[Dict[str, Any]],
                              filters: Optional[Dict[str, Any]] = None,
                              post_aggregations: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Build optimized timeseries query"""
        
        query = {
            "queryType": "timeseries",
            "dataSource": datasource,
            "intervals": intervals,
            "granularity": granularity,
            "aggregations": aggregations,
            "context": {
                "timeout": 60000,
                "useApproximateTopN": True,
                "useApproximateCountDistinct": True
            }
        }
        
        if filters:
            query["filter"] = filters
            
        if post_aggregations:
            query["postAggregations"] = post_aggregations
            
        return query
    
    def build_topn_query(self, datasource: str,
                        intervals: List[str],
                        granularity: str,
                        dimension: str,
                        threshold: int,
                        metric: str,
                        aggregations: List[Dict[str, Any]],
                        filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Build optimized TopN query"""
        
        query = {
            "queryType": "topN",
            "dataSource": datasource,
            "intervals": intervals,
            "granularity": granularity,
            "dimension": dimension,
            "threshold": threshold,
            "metric": metric,
            "aggregations": aggregations,
            "context": {
                "timeout": 60000,
                "useApproximateTopN": True,
                "minTopNThreshold": 1000
            }
        }
        
        if filters:
            query["filter"] = filters
            
        return query
    
    def build_group_by_query(self, datasource: str,
                           intervals: List[str],
                           granularity: str,
                           dimensions: List[str],
                           aggregations: List[Dict[str, Any]],
                           filters: Optional[Dict[str, Any]] = None,
                           having: Optional[Dict[str, Any]] = None,
                           limit_spec: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Build optimized GroupBy query"""
        
        query = {
            "queryType": "groupBy",
            "dataSource": datasource,
            "intervals": intervals,
            "granularity": granularity,
            "dimensions": dimensions,
            "aggregations": aggregations,
            "context": {
                "timeout": 60000,
                "maxMergingDictionarySize": 100000000,
                "maxOnDiskStorage": 1000000000,
                "useOffheap": True
            }
        }
        
        if filters:
            query["filter"] = filters
            
        if having:
            query["having"] = having
            
        if limit_spec:
            query["limitSpec"] = limit_spec
            
        return query
    
    def optimize_filters(self, filters: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Optimize filter combinations for better performance"""
        
        if not filters:
            return None
            
        if len(filters) == 1:
            return filters[0]
        
        # Group filters by type for optimization
        equality_filters = []
        range_filters = []
        regex_filters = []
        other_filters = []
        
        for f in filters:
            if f.get("type") == "selector":
                equality_filters.append(f)
            elif f.get("type") == "bound":
                range_filters.append(f)
            elif f.get("type") == "regex":
                regex_filters.append(f)
            else:
                other_filters.append(f)
        
        # Combine filters efficiently
        combined_filters = []
        
        # Combine equality filters on same dimension
        if equality_filters:
            dim_groups = {}
            for f in equality_filters:
                dim = f["dimension"]
                if dim not in dim_groups:
                    dim_groups[dim] = []
                dim_groups[dim].append(f["value"])
            
            for dim, values in dim_groups.items():
                if len(values) == 1:
                    combined_filters.append({
                        "type": "selector",
                        "dimension": dim,
                        "value": values[0]
                    })
                else:
                    combined_filters.append({
                        "type": "in",
                        "dimension": dim,
                        "values": values
                    })
        
        # Add other filter types
        combined_filters.extend(range_filters)
        combined_filters.extend(regex_filters)
        combined_filters.extend(other_filters)
        
        # Return optimized filter structure
        if len(combined_filters) == 1:
            return combined_filters[0]
        else:
            return {
                "type": "and",
                "fields": combined_filters
            }
    
    def create_optimized_aggregations(self, metrics: List[str]) -> List[Dict[str, Any]]:
        """Create optimized aggregation specifications"""
        
        aggregations = []
        
        for metric in metrics:
            if metric == "count":
                aggregations.append({
                    "type": "count",
                    "name": "count"
                })
            elif metric.startswith("sum_"):
                field_name = metric.replace("sum_", "")
                aggregations.append({
                    "type": "longSum",
                    "name": metric,
                    "fieldName": field_name
                })
            elif metric.startswith("avg_"):
                field_name = metric.replace("avg_", "")
                # Use filtered aggregator for more accurate averages
                aggregations.extend([
                    {
                        "type": "longSum",
                        "name": f"_sum_{field_name}",
                        "fieldName": field_name
                    },
                    {
                        "type": "count",
                        "name": f"_count_{field_name}",
                        "filter": {
                            "type": "not",
                            "field": {
                                "type": "selector",
                                "dimension": field_name,
                                "value": None
                            }
                        }
                    }
                ])
            elif metric.startswith("unique_"):
                field_name = metric.replace("unique_", "")
                # Use HyperLogLog for approximate count distinct
                aggregations.append({
                    "type": "cardinality",
                    "name": metric,
                    "fields": [field_name]
                })
            elif metric.startswith("min_"):
                field_name = metric.replace("min_", "")
                aggregations.append({
                    "type": "doubleMin",
                    "name": metric,
                    "fieldName": field_name
                })
            elif metric.startswith("max_"):
                field_name = metric.replace("max_", "")
                aggregations.append({
                    "type": "doubleMax",
                    "name": metric,
                    "fieldName": field_name
                })
        
        return aggregations
    
    def create_post_aggregations(self, metrics: List[str]) -> List[Dict[str, Any]]:
        """Create post-aggregations for derived metrics"""
        
        post_aggs = []
        
        for metric in metrics:
            if metric.startswith("avg_"):
                field_name = metric.replace("avg_", "")
                post_aggs.append({
                    "type": "arithmetic",
                    "name": metric,
                    "fn": "/",
                    "fields": [
                        {"type": "fieldAccess", "fieldName": f"_sum_{field_name}"},
                        {"type": "fieldAccess", "fieldName": f"_count_{field_name}"}
                    ]
                })
            elif metric.startswith("rate_"):
                # Calculate rate metrics (e.g., conversion rate)
                numerator = metric.replace("rate_", "")
                post_aggs.append({
                    "type": "arithmetic",
                    "name": metric,
                    "fn": "/",
                    "fields": [
                        {"type": "fieldAccess", "fieldName": numerator},
                        {"type": "fieldAccess", "fieldName": "count"}
                    ]
                })
        
        return post_aggs

# Performance monitoring and optimization
class DruidPerformanceMonitor:
    """Monitor and optimize Druid query performance"""
    
    def __init__(self, client: DruidClient):
        self.client = client
        self.query_cache = {}
        self.performance_history = []
        
    def execute_with_monitoring(self, query: Dict[str, Any], 
                              query_id: Optional[str] = None) -> Dict[str, Any]:
        """Execute query with comprehensive performance monitoring"""
        
        start_time = datetime.utcnow()
        
        # Add monitoring context
        if "context" not in query:
            query["context"] = {}
        
        query["context"].update({
            "queryId": query_id or f"query_{int(start_time.timestamp())}",
            "enableQueryRequestLogging": True,
            "enableQueryStatsLogging": True,
            "populateCache": True,
            "useCache": True
        })
        
        try:
            # Execute query
            result = self.client.query_native(query)
            
            end_time = datetime.utcnow()
            execution_time = (end_time - start_time).total_seconds()
            
            # Extract performance metrics
            performance_metrics = {
                "query_id": query["context"]["queryId"],
                "query_type": query["queryType"],
                "execution_time_seconds": execution_time,
                "start_time": start_time.isoformat(),
                "end_time": end_time.isoformat(),
                "cache_hit": False,  # Would be determined from query stats
                "bytes_processed": 0,  # Would be extracted from metrics
                "segments_queried": 0,  # Would be extracted from metrics
                "result_size": len(str(result))
            }
            
            # Store performance history
            self.performance_history.append(performance_metrics)
            
            # Cache successful queries
            if execution_time < 10:  # Only cache fast queries
                cache_key = self._generate_cache_key(query)
                self.query_cache[cache_key] = {
                    "result": result,
                    "timestamp": start_time,
                    "ttl_seconds": 300  # 5 minutes
                }
            
            return {
                "result": result,
                "performance": performance_metrics
            }
            
        except Exception as e:
            end_time = datetime.utcnow()
            execution_time = (end_time - start_time).total_seconds()
            
            error_metrics = {
                "query_id": query["context"]["queryId"],
                "query_type": query["queryType"],
                "execution_time_seconds": execution_time,
                "start_time": start_time.isoformat(),
                "error": str(e),
                "status": "failed"
            }
            
            self.performance_history.append(error_metrics)
            raise
    
    def get_performance_summary(self, time_window: timedelta = None) -> Dict[str, Any]:
        """Get performance summary for monitoring"""
        
        if time_window is None:
            time_window = timedelta(hours=1)
        
        cutoff_time = datetime.utcnow() - time_window
        
        recent_queries = [
            q for q in self.performance_history
            if datetime.fromisoformat(q["start_time"]) >= cutoff_time
        ]
        
        if not recent_queries:
            return {"message": "No queries in time window"}
        
        successful_queries = [q for q in recent_queries if "error" not in q]
        failed_queries = [q for q in recent_queries if "error" in q]
        
        execution_times = [q["execution_time_seconds"] for q in successful_queries]
        
        summary = {
            "time_window_hours": time_window.total_seconds() / 3600,
            "total_queries": len(recent_queries),
            "successful_queries": len(successful_queries),
            "failed_queries": len(failed_queries),
            "success_rate": len(successful_queries) / len(recent_queries) * 100 if recent_queries else 0,
            "avg_execution_time": sum(execution_times) / len(execution_times) if execution_times else 0,
            "min_execution_time": min(execution_times) if execution_times else 0,
            "max_execution_time": max(execution_times) if execution_times else 0,
            "p95_execution_time": self._percentile(execution_times, 95) if execution_times else 0,
            "query_types": {}
        }
        
        # Group by query type
        for query in successful_queries:
            query_type = query["query_type"]
            if query_type not in summary["query_types"]:
                summary["query_types"][query_type] = {
                    "count": 0,
                    "avg_time": 0,
                    "total_time": 0
                }
            
            summary["query_types"][query_type]["count"] += 1
            summary["query_types"][query_type]["total_time"] += query["execution_time_seconds"]
        
        # Calculate averages
        for query_type, stats in summary["query_types"].items():
            stats["avg_time"] = stats["total_time"] / stats["count"]
        
        return summary
    
    def _percentile(self, values: List[float], percentile: int) -> float:
        """Calculate percentile value"""
        if not values:
            return 0
        
        sorted_values = sorted(values)
        index = int((percentile / 100.0) * len(sorted_values))
        return sorted_values[min(index, len(sorted_values) - 1)]
    
    def _generate_cache_key(self, query: Dict[str, Any]) -> str:
        """Generate cache key for query"""
        import hashlib
        
        # Remove context for cache key generation
        cache_query = query.copy()
        cache_query.pop("context", None)
        
        query_str = json.dumps(cache_query, sort_keys=True)
        return hashlib.md5(query_str.encode()).hexdigest()
    
    def suggest_optimizations(self, query: Dict[str, Any]) -> List[str]:
        """Suggest query optimizations based on analysis"""
        
        suggestions = []
        
        # Check query type
        if query["queryType"] == "groupBy":
            if len(query.get("dimensions", [])) > 5:
                suggestions.append("Consider reducing number of dimensions in GroupBy query")
            
            if "limitSpec" not in query:
                suggestions.append("Add limitSpec to GroupBy query to limit result size")
        
        elif query["queryType"] == "topN":
            threshold = query.get("threshold", 100)
            if threshold > 1000:
                suggestions.append("Consider reducing TopN threshold for better performance")
        
        # Check time intervals
        intervals = query.get("intervals", [])
        for interval in intervals:
            # Parse interval to check duration
            if "/" in interval:
                start, end = interval.split("/")
                # This is a simplified check - in practice you'd parse the ISO dates
                if len(interval) > 50:  # Rough heuristic for long time ranges
                    suggestions.append("Consider reducing time interval for better performance")
        
        # Check aggregations
        aggregations = query.get("aggregations", [])
        if len(aggregations) > 10:
            suggestions.append("Consider reducing number of aggregations")
        
        # Check for missing filters
        if "filter" not in query and query["queryType"] != "timeBoundary":
            suggestions.append("Add filters to reduce data scanning")
        
        return suggestions
```

## Conclusion

Apache Druid provides a powerful platform for real-time analytics on large-scale time-series and event data. The advanced techniques and implementations shown in this guide enable organizations to build high-performance analytics systems that can handle massive data volumes while providing sub-second query response times.

Key takeaways for successful Druid implementation include:

1. **Architecture Design**: Properly configure Druid components for your workload characteristics and scale requirements
2. **Data Modeling**: Design efficient schemas with appropriate rollup, partitioning, and indexing strategies
3. **Query Optimization**: Use native queries and proper optimization techniques for maximum performance
4. **Real-Time Processing**: Implement robust streaming ingestion with proper monitoring and quality checks
5. **Performance Monitoring**: Continuously monitor and optimize query performance using comprehensive metrics

By following these advanced patterns and best practices, organizations can build world-class real-time analytics platforms that scale efficiently and provide exceptional user experiences for data exploration and business intelligence applications.