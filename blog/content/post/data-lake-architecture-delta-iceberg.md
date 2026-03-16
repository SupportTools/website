---
title: "Data Lake Architecture with Delta Lake and Apache Iceberg"
date: 2026-06-05T00:00:00-05:00
draft: false
tags: ["Delta Lake", "Apache Iceberg", "Data Lake", "Data Engineering", "ACID Transactions", "Apache Spark", "Data Versioning", "Schema Evolution"]
categories:
- Data Engineering
- Data Lake Architecture
- Big Data
author: "Matthew Mattox - mmattox@support.tools"
description: "Build modern data lake architectures using Delta Lake and Apache Iceberg for ACID transactions, schema evolution, and time travel capabilities. Learn implementation patterns, performance optimization, and production deployment strategies."
more_link: "yes"
url: "/data-lake-architecture-delta-iceberg/"
---

Modern data lake architectures require sophisticated table formats that provide ACID transactions, schema evolution, and time travel capabilities while maintaining the scalability and flexibility of traditional data lakes. Delta Lake and Apache Iceberg represent the next generation of table formats that solve many challenges of traditional data lakes.

<!--more-->

# Data Lake Architecture with Delta Lake and Apache Iceberg

## Understanding Modern Table Formats

Traditional data lakes, while offering scalability and cost-effectiveness, face several challenges including lack of ACID transactions, schema drift, and data consistency issues. Modern table formats like Delta Lake and Apache Iceberg address these limitations by providing:

- **ACID Transactions**: Ensuring data consistency and reliability
- **Schema Evolution**: Safe schema changes without breaking existing queries
- **Time Travel**: Ability to query historical versions of data
- **Metadata Management**: Efficient handling of partition metadata
- **Compaction**: Automatic optimization of file layouts

## Delta Lake Implementation

### Setting Up Delta Lake

```scala
// DeltaLakeSetup.scala
package com.supporttools.datalake.delta

import org.apache.spark.sql.{SparkSession, DataFrame}
import org.apache.spark.sql.functions._
import org.apache.spark.sql.types._
import io.delta.tables._

object DeltaLakeSetup {
  
  def createOptimizedSparkSession(): SparkSession = {
    SparkSession.builder()
      .appName("Delta Lake Data Platform")
      .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
      .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
      .config("spark.serializer", "org.apache.spark.serializer.KryoSerializer")
      
      // Delta Lake optimizations
      .config("spark.databricks.delta.optimizeWrite.enabled", "true")
      .config("spark.databricks.delta.autoCompact.enabled", "true")
      .config("spark.databricks.delta.properties.defaults.autoOptimize.optimizeWrite", "true")
      .config("spark.databricks.delta.properties.defaults.autoOptimize.autoCompact", "true")
      
      // Performance settings
      .config("spark.sql.adaptive.enabled", "true")
      .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
      .config("spark.databricks.delta.retentionDurationCheck.enabled", "false")
      .config("spark.databricks.delta.schema.autoMerge.enabled", "true")
      
      .getOrCreate()
  }
  
  def createDeltaTables(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Create Bronze layer table (raw data)
    val bronzeSchema = StructType(Array(
      StructField("event_id", StringType, nullable = false),
      StructField("user_id", LongType, nullable = false),
      StructField("event_timestamp", TimestampType, nullable = false),
      StructField("event_type", StringType, nullable = false),
      StructField("raw_data", StringType, nullable = true),
      StructField("source_system", StringType, nullable = false),
      StructField("ingestion_timestamp", TimestampType, nullable = false)
    ))
    
    spark.createDataFrame(spark.sparkContext.emptyRDD[Row], bronzeSchema)
      .write
      .format("delta")
      .option("path", "s3a://datalake/bronze/events")
      .partitionBy("source_system", "event_type")
      .saveAsTable("bronze.events")
    
    // Create Silver layer table (cleaned and enriched data)
    val silverSchema = StructType(Array(
      StructField("event_id", StringType, nullable = false),
      StructField("user_id", LongType, nullable = false),
      StructField("event_timestamp", TimestampType, nullable = false),
      StructField("event_type", StringType, nullable = false),
      StructField("session_id", StringType, nullable = true),
      StructField("page_url", StringType, nullable = true),
      StructField("user_agent", StringType, nullable = true),
      StructField("ip_address", StringType, nullable = true),
      StructField("geo_country", StringType, nullable = true),
      StructField("geo_city", StringType, nullable = true),
      StructField("device_type", StringType, nullable = true),
      StructField("processed_timestamp", TimestampType, nullable = false),
      StructField("data_quality_score", DoubleType, nullable = true)
    ))
    
    spark.createDataFrame(spark.sparkContext.emptyRDD[Row], silverSchema)
      .write
      .format("delta")
      .option("path", "s3a://datalake/silver/events")
      .partitionBy("event_type")
      .saveAsTable("silver.events")
    
    // Create Gold layer table (aggregated business metrics)
    val goldSchema = StructType(Array(
      StructField("date", DateType, nullable = false),
      StructField("hour", IntegerType, nullable = false),
      StructField("event_type", StringType, nullable = false),
      StructField("country", StringType, nullable = false),
      StructField("total_events", LongType, nullable = false),
      StructField("unique_users", LongType, nullable = false),
      StructField("unique_sessions", LongType, nullable = false),
      StructField("avg_session_duration", DoubleType, nullable = true),
      StructField("total_revenue", DecimalType(15, 2), nullable = true),
      StructField("calculated_timestamp", TimestampType, nullable = false)
    ))
    
    spark.createDataFrame(spark.sparkContext.emptyRDD[Row], goldSchema)
      .write
      .format("delta")
      .option("path", "s3a://datalake/gold/event_metrics")
      .partitionBy("date", "event_type")
      .saveAsTable("gold.event_metrics")
  }
}
```

### Advanced Delta Lake Operations

```scala
// DeltaLakeOperations.scala
package com.supporttools.datalake.delta

import org.apache.spark.sql.{SparkSession, DataFrame}
import org.apache.spark.sql.functions._
import io.delta.tables._
import org.apache.spark.sql.streaming.Trigger

object DeltaLakeOperations {
  
  def implementUpsertOperations(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Read existing Delta table
    val silverTable = DeltaTable.forName(spark, "silver.events")
    
    // Simulate new data to upsert
    val newData = spark.read
      .format("json")
      .load("s3a://raw-data/events/2025/12/07/")
      .withColumn("processed_timestamp", current_timestamp())
      .withColumn("data_quality_score", lit(0.95))
    
    // Perform UPSERT operation
    silverTable.as("target")
      .merge(newData.as("source"), "target.event_id = source.event_id")
      .whenMatched()
      .updateExpr(Map(
        "event_timestamp" -> "source.event_timestamp",
        "event_type" -> "source.event_type",
        "session_id" -> "source.session_id",
        "page_url" -> "source.page_url",
        "user_agent" -> "source.user_agent",
        "ip_address" -> "source.ip_address",
        "geo_country" -> "source.geo_country",
        "geo_city" -> "source.geo_city",
        "device_type" -> "source.device_type",
        "processed_timestamp" -> "source.processed_timestamp",
        "data_quality_score" -> "source.data_quality_score"
      ))
      .whenNotMatched()
      .insertAll()
      .execute()
    
    println("UPSERT operation completed successfully")
  }
  
  def implementStreamingIngestion(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Stream from Kafka to Delta Lake
    val kafkaStream = spark.readStream
      .format("kafka")
      .option("kafka.bootstrap.servers", "kafka-cluster:9092")
      .option("subscribe", "user-events")
      .option("startingOffsets", "latest")
      .load()
    
    val parsedStream = kafkaStream
      .select(
        from_json($"value".cast("string"), 
          schema = StructType(Array(
            StructField("event_id", StringType),
            StructField("user_id", LongType),
            StructField("event_timestamp", TimestampType),
            StructField("event_type", StringType),
            StructField("raw_data", StringType),
            StructField("source_system", StringType)
          ))
        ).as("data")
      )
      .select("data.*")
      .withColumn("ingestion_timestamp", current_timestamp())
    
    // Write stream to Delta Lake with deduplication
    val streamingQuery = parsedStream.writeStream
      .format("delta")
      .outputMode("append")
      .option("checkpointLocation", "s3a://checkpoints/bronze-events")
      .option("mergeSchema", "true")
      .trigger(Trigger.ProcessingTime("30 seconds"))
      .foreachBatch { (batchDF: DataFrame, batchId: Long) =>
        // Deduplicate within batch
        val deduplicatedBatch = batchDF.dropDuplicates("event_id")
        
        // Write to Delta table
        deduplicatedBatch.write
          .format("delta")
          .mode("append")
          .option("mergeSchema", "true")
          .saveAsTable("bronze.events")
        
        println(s"Batch ${batchId}: Processed ${deduplicatedBatch.count()} events")
      }
      .start()
    
    // Keep stream running
    streamingQuery.awaitTermination()
  }
  
  def implementTimeTravel(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Query historical versions using version number
    val version5Data = spark.read
      .format("delta")
      .option("versionAsOf", 5)
      .table("silver.events")
    
    println(s"Records in version 5: ${version5Data.count()}")
    
    // Query data as of specific timestamp
    val timestampData = spark.read
      .format("delta")
      .option("timestampAsOf", "2025-12-07 10:00:00")
      .table("silver.events")
    
    println(s"Records as of timestamp: ${timestampData.count()}")
    
    // Compare data between versions
    val currentData = spark.read.table("silver.events")
    val previousData = spark.read
      .format("delta")
      .option("versionAsOf", 5)
      .table("silver.events")
    
    val newRecords = currentData.except(previousData)
    val deletedRecords = previousData.except(currentData)
    
    println(s"New records since version 5: ${newRecords.count()}")
    println(s"Deleted records since version 5: ${deletedRecords.count()}")
  }
  
  def implementSchemaEvolution(spark: SparkSession): Unit = {
    import spark.implicits._
    
    val silverTable = DeltaTable.forName(spark, "silver.events")
    
    // Add new columns to the table
    silverTable.alter()
      .addColumn("utm_source", StringType)
      .addColumn("utm_medium", StringType)
      .addColumn("utm_campaign", StringType)
      .execute()
    
    // Simulate data with new schema
    val newSchemaData = spark.read
      .format("json")
      .load("s3a://raw-data/events-with-utm/2025/12/07/")
      .withColumn("processed_timestamp", current_timestamp())
      .withColumn("data_quality_score", lit(0.98))
    
    // Append data with new schema
    newSchemaData.write
      .format("delta")
      .mode("append")
      .option("mergeSchema", "true")
      .saveAsTable("silver.events")
    
    println("Schema evolution completed successfully")
  }
  
  def implementDataOptimization(spark: SparkSession): Unit = {
    val silverTable = DeltaTable.forName(spark, "silver.events")
    
    // Optimize table layout using Z-ORDER
    silverTable.optimize()
      .executeZOrderBy("user_id", "event_timestamp")
    
    // Vacuum old files (remove files older than retention period)
    silverTable.vacuum(168) // 7 days retention
    
    // Analyze table statistics
    spark.sql("ANALYZE TABLE silver.events COMPUTE STATISTICS FOR ALL COLUMNS")
    
    println("Table optimization completed")
  }
  
  def implementDataQualityChecks(spark: SparkSession): DataFrame = {
    import spark.implicits._
    
    val events = spark.read.table("silver.events")
    
    // Data quality checks
    val qualityMetrics = events
      .withColumn("has_null_user_id", when($"user_id".isNull, 1).otherwise(0))
      .withColumn("has_null_timestamp", when($"event_timestamp".isNull, 1).otherwise(0))
      .withColumn("has_invalid_event_type", when($"event_type".isNull or $"event_type" === "", 1).otherwise(0))
      .withColumn("has_future_timestamp", when($"event_timestamp" > current_timestamp(), 1).otherwise(0))
      .withColumn("session_duration_valid", when($"session_id".isNotNull and length($"session_id") >= 10, 1).otherwise(0))
      
    val qualityReport = qualityMetrics
      .agg(
        count("*").alias("total_records"),
        sum("has_null_user_id").alias("null_user_id_count"),
        sum("has_null_timestamp").alias("null_timestamp_count"),
        sum("has_invalid_event_type").alias("invalid_event_type_count"),
        sum("has_future_timestamp").alias("future_timestamp_count"),
        avg("session_duration_valid").alias("session_id_quality_rate")
      )
      .withColumn("data_quality_score", 
        lit(1.0) - (
          ($"null_user_id_count" + $"null_timestamp_count" + 
           $"invalid_event_type_count" + $"future_timestamp_count") / $"total_records"
        )
      )
    
    qualityReport.show()
    qualityReport
  }
}
```

## Apache Iceberg Implementation

### Setting Up Apache Iceberg

```scala
// IcebergSetup.scala
package com.supporttools.datalake.iceberg

import org.apache.spark.sql.SparkSession
import org.apache.spark.sql.functions._
import org.apache.spark.sql.types._

object IcebergSetup {
  
  def createIcebergSparkSession(): SparkSession = {
    SparkSession.builder()
      .appName("Iceberg Data Platform")
      .config("spark.sql.extensions", 
        "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
      .config("spark.sql.catalog.iceberg", "org.apache.iceberg.spark.SparkCatalog")
      .config("spark.sql.catalog.iceberg.type", "hadoop")
      .config("spark.sql.catalog.iceberg.warehouse", "s3a://datalake/iceberg-warehouse")
      .config("spark.sql.catalog.iceberg.hadoop.fs.s3a.access.key", "ACCESS_KEY")
      .config("spark.sql.catalog.iceberg.hadoop.fs.s3a.secret.key", "SECRET_KEY")
      .config("spark.sql.catalog.iceberg.hadoop.fs.s3a.endpoint", "s3.amazonaws.com")
      
      // Iceberg optimizations
      .config("spark.sql.iceberg.vectorization.enabled", "true")
      .config("spark.sql.iceberg.planning.preserve-data-grouping", "true")
      .config("spark.sql.iceberg.merge.mode", "copy-on-write")
      
      .getOrCreate()
  }
  
  def createIcebergTables(spark: SparkSession): Unit = {
    // Create namespace (database)
    spark.sql("CREATE NAMESPACE IF NOT EXISTS iceberg.lakehouse")
    
    // Create Bronze layer table
    spark.sql("""
      CREATE TABLE IF NOT EXISTS iceberg.lakehouse.bronze_events (
        event_id string NOT NULL,
        user_id bigint NOT NULL,
        event_timestamp timestamp NOT NULL,
        event_type string NOT NULL,
        raw_data string,
        source_system string NOT NULL,
        ingestion_timestamp timestamp NOT NULL
      ) USING iceberg
      PARTITIONED BY (days(event_timestamp), source_system)
      TBLPROPERTIES (
        'write.format.default' = 'parquet',
        'write.parquet.compression-codec' = 'snappy',
        'commit.retry.num-retries' = '3',
        'commit.retry.min-wait-ms' = '100',
        'commit.status-check.total-timeout-ms' = '600000'
      )
    """)
    
    // Create Silver layer table with evolved schema support
    spark.sql("""
      CREATE TABLE IF NOT EXISTS iceberg.lakehouse.silver_events (
        event_id string NOT NULL,
        user_id bigint NOT NULL,
        event_timestamp timestamp NOT NULL,
        event_type string NOT NULL,
        session_id string,
        page_url string,
        user_agent string,
        ip_address string,
        geo_country string,
        geo_city string,
        device_type string,
        processed_timestamp timestamp NOT NULL,
        data_quality_score double
      ) USING iceberg
      PARTITIONED BY (days(event_timestamp))
      TBLPROPERTIES (
        'write.format.default' = 'parquet',
        'write.parquet.compression-codec' = 'snappy',
        'write.merge.mode' = 'copy-on-write',
        'format-version' = '2',
        'write.delete.mode' = 'merge-on-read',
        'write.update.mode' = 'merge-on-read'
      )
    """)
    
    // Create Gold layer table with advanced partitioning
    spark.sql("""
      CREATE TABLE IF NOT EXISTS iceberg.lakehouse.gold_metrics (
        metric_date date NOT NULL,
        metric_hour int NOT NULL,
        event_type string NOT NULL,
        country string NOT NULL,
        total_events bigint NOT NULL,
        unique_users bigint NOT NULL,
        unique_sessions bigint NOT NULL,
        avg_session_duration double,
        total_revenue decimal(15,2),
        calculated_timestamp timestamp NOT NULL
      ) USING iceberg
      PARTITIONED BY (metric_date, event_type)
      TBLPROPERTIES (
        'write.format.default' = 'parquet',
        'write.parquet.compression-codec' = 'snappy',
        'write.target-file-size-bytes' = '134217728'
      )
    """)
  }
}
```

### Advanced Iceberg Operations

```scala
// IcebergOperations.scala
package com.supporttools.datalake.iceberg

import org.apache.spark.sql.{SparkSession, DataFrame}
import org.apache.spark.sql.functions._

object IcebergOperations {
  
  def implementMergeOperations(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Simulate incoming data
    val newData = spark.read
      .format("json")
      .load("s3a://raw-data/events/2025/12/07/")
      .withColumn("processed_timestamp", current_timestamp())
      .withColumn("data_quality_score", lit(0.95))
    
    // Create temporary view for merge operation
    newData.createOrReplaceTempView("new_events")
    
    // Perform MERGE operation using SQL
    spark.sql("""
      MERGE INTO iceberg.lakehouse.silver_events target
      USING new_events source
      ON target.event_id = source.event_id
      WHEN MATCHED THEN UPDATE SET *
      WHEN NOT MATCHED THEN INSERT *
    """)
    
    println("Merge operation completed successfully")
  }
  
  def implementTimeTravel(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Query historical data using snapshot ID
    val snapshotData = spark.read
      .option("snapshot-id", "1234567890123456789")
      .table("iceberg.lakehouse.silver_events")
    
    println(s"Records in snapshot: ${snapshotData.count()}")
    
    // Query data as of timestamp
    val timestampData = spark.read
      .option("as-of-timestamp", "1701936000000") // Unix timestamp
      .table("iceberg.lakehouse.silver_events")
    
    println(s"Records as of timestamp: ${timestampData.count()}")
    
    // Show table history
    spark.sql("SELECT * FROM iceberg.lakehouse.silver_events.history").show(false)
    
    // Show table snapshots
    spark.sql("SELECT * FROM iceberg.lakehouse.silver_events.snapshots").show(false)
  }
  
  def implementSchemaEvolution(spark: SparkSession): Unit = {
    // Add new columns
    spark.sql("""
      ALTER TABLE iceberg.lakehouse.silver_events 
      ADD COLUMNS (
        utm_source string COMMENT 'UTM source parameter',
        utm_medium string COMMENT 'UTM medium parameter',
        utm_campaign string COMMENT 'UTM campaign parameter',
        custom_attributes map<string, string> COMMENT 'Flexible attributes'
      )
    """)
    
    // Rename column
    spark.sql("""
      ALTER TABLE iceberg.lakehouse.silver_events 
      RENAME COLUMN geo_country TO country_code
    """)
    
    // Update column type (if compatible)
    spark.sql("""
      ALTER TABLE iceberg.lakehouse.silver_events 
      ALTER COLUMN data_quality_score TYPE decimal(5,4)
    """)
    
    // Show current schema
    spark.sql("DESCRIBE iceberg.lakehouse.silver_events").show(false)
    
    println("Schema evolution completed successfully")
  }
  
  def implementPartitionEvolution(spark: SparkSession): Unit = {
    // Add new partition field
    spark.sql("""
      ALTER TABLE iceberg.lakehouse.silver_events 
      ADD PARTITION FIELD event_type
    """)
    
    // Replace partition field
    spark.sql("""
      ALTER TABLE iceberg.lakehouse.silver_events 
      REPLACE PARTITION FIELD days(event_timestamp) WITH hours(event_timestamp)
    """)
    
    // Drop partition field
    spark.sql("""
      ALTER TABLE iceberg.lakehouse.silver_events 
      DROP PARTITION FIELD event_type
    """)
    
    println("Partition evolution completed successfully")
  }
  
  def implementTableOptimization(spark: SparkSession): Unit = {
    // Rewrite data files to optimize layout
    spark.sql("""
      CALL iceberg.system.rewrite_data_files(
        table => 'lakehouse.silver_events',
        strategy => 'sort',
        sort_order => 'user_id ASC, event_timestamp ASC'
      )
    """)
    
    // Rewrite manifests to improve metadata performance
    spark.sql("""
      CALL iceberg.system.rewrite_manifests('lakehouse.silver_events')
    """)
    
    // Expire old snapshots
    spark.sql("""
      CALL iceberg.system.expire_snapshots(
        table => 'lakehouse.silver_events',
        older_than => TIMESTAMP '2025-11-30 00:00:00'
      )
    """)
    
    // Remove orphaned files
    spark.sql("""
      CALL iceberg.system.remove_orphan_files(
        table => 'lakehouse.silver_events'
      )
    """)
    
    println("Table optimization completed successfully")
  }
  
  def implementBranchingAndTagging(spark: SparkSession): Unit = {
    // Create a branch for experimental features
    spark.sql("""
      ALTER TABLE iceberg.lakehouse.silver_events 
      CREATE BRANCH experimental_features
    """)
    
    // Create a tag for release
    spark.sql("""
      ALTER TABLE iceberg.lakehouse.silver_events 
      CREATE TAG release_v1_0 AS OF VERSION 10
    """)
    
    // Write to branch
    val experimentalData = spark.read.table("iceberg.lakehouse.silver_events")
      .withColumn("experimental_feature", lit("enabled"))
    
    experimentalData.writeTo("iceberg.lakehouse.silver_events.branch_experimental_features")
      .append()
    
    // Read from branch
    val branchData = spark.read
      .table("iceberg.lakehouse.silver_events.branch_experimental_features")
    
    println(s"Branch records: ${branchData.count()}")
    
    // Merge branch back to main
    spark.sql("""
      CALL iceberg.system.fast_forward(
        table => 'lakehouse.silver_events',
        branch => 'experimental_features'
      )
    """)
    
    println("Branching and tagging operations completed")
  }
}
```

## Performance Comparison and Optimization

### Benchmarking Framework

```scala
// PerformanceBenchmark.scala
package com.supporttools.datalake.benchmark

import org.apache.spark.sql.{SparkSession, DataFrame}
import org.apache.spark.sql.functions._
import scala.util.Random

object PerformanceBenchmark {
  
  case class BenchmarkResult(
    operation: String,
    tableFormat: String,
    recordCount: Long,
    executionTimeMs: Long,
    throughputRecordsPerSec: Double,
    fileSizeMB: Double,
    queryLatencyMs: Long
  )
  
  def generateTestData(spark: SparkSession, recordCount: Long): DataFrame = {
    import spark.implicits._
    
    val random = new Random()
    
    spark.range(recordCount)
      .withColumn("event_id", concat(lit("evt_"), $"id"))
      .withColumn("user_id", ($"id" % 1000000).cast("long"))
      .withColumn("event_timestamp", 
        to_timestamp(lit("2025-12-01 00:00:00")) + expr(s"INTERVAL ${random.nextInt(86400)} SECONDS"))
      .withColumn("event_type", 
        when($"id" % 5 === 0, "purchase")
        .when($"id" % 5 === 1, "view")
        .when($"id" % 5 === 2, "click")
        .when($"id" % 5 === 3, "add_to_cart")
        .otherwise("search"))
      .withColumn("session_id", concat(lit("sess_"), ($"id" % 100000)))
      .withColumn("revenue", when($"event_type" === "purchase", 
        round(rand() * 1000, 2)).otherwise(0))
      .drop("id")
  }
  
  def benchmarkWrites(spark: SparkSession): List[BenchmarkResult] = {
    val recordCounts = List(1000000L, 10000000L, 100000000L)
    val results = scala.collection.mutable.ListBuffer[BenchmarkResult]()
    
    recordCounts.foreach { recordCount =>
      val testData = generateTestData(spark, recordCount)
      
      // Benchmark Delta Lake write
      val deltaStartTime = System.currentTimeMillis()
      testData.write
        .format("delta")
        .mode("overwrite")
        .option("overwriteSchema", "true")
        .save(s"s3a://benchmark/delta/events_${recordCount}")
      val deltaEndTime = System.currentTimeMillis()
      
      val deltaResult = BenchmarkResult(
        operation = "write",
        tableFormat = "delta",
        recordCount = recordCount,
        executionTimeMs = deltaEndTime - deltaStartTime,
        throughputRecordsPerSec = recordCount.toDouble / ((deltaEndTime - deltaStartTime) / 1000.0),
        fileSizeMB = calculateTableSize(s"s3a://benchmark/delta/events_${recordCount}"),
        queryLatencyMs = 0L
      )
      results += deltaResult
      
      // Benchmark Iceberg write
      val icebergStartTime = System.currentTimeMillis()
      testData.writeTo(s"iceberg.benchmark.events_${recordCount}")
        .using("iceberg")
        .tableProperty("write.format.default", "parquet")
        .partitionedBy($"event_type")
        .createOrReplace()
      val icebergEndTime = System.currentTimeMillis()
      
      val icebergResult = BenchmarkResult(
        operation = "write",
        tableFormat = "iceberg",
        recordCount = recordCount,
        executionTimeMs = icebergEndTime - icebergStartTime,
        throughputRecordsPerSec = recordCount.toDouble / ((icebergEndTime - icebergStartTime) / 1000.0),
        fileSizeMB = calculateTableSize(s"iceberg.benchmark.events_${recordCount}"),
        queryLatencyMs = 0L
      )
      results += icebergResult
      
      // Benchmark Parquet write (baseline)
      val parquetStartTime = System.currentTimeMillis()
      testData.write
        .format("parquet")
        .mode("overwrite")
        .partitionBy("event_type")
        .save(s"s3a://benchmark/parquet/events_${recordCount}")
      val parquetEndTime = System.currentTimeMillis()
      
      val parquetResult = BenchmarkResult(
        operation = "write",
        tableFormat = "parquet",
        recordCount = recordCount,
        executionTimeMs = parquetEndTime - parquetStartTime,
        throughputRecordsPerSec = recordCount.toDouble / ((parquetEndTime - parquetStartTime) / 1000.0),
        fileSizeMB = calculateTableSize(s"s3a://benchmark/parquet/events_${recordCount}"),
        queryLatencyMs = 0L
      )
      results += parquetResult
      
      println(s"Completed write benchmarks for ${recordCount} records")
    }
    
    results.toList
  }
  
  def benchmarkReads(spark: SparkSession): List[BenchmarkResult] = {
    val results = scala.collection.mutable.ListBuffer[BenchmarkResult]()
    val queries = List(
      ("count", "SELECT COUNT(*) FROM {table}"),
      ("filter", "SELECT * FROM {table} WHERE event_type = 'purchase'"),
      ("aggregate", "SELECT event_type, COUNT(*), SUM(revenue) FROM {table} GROUP BY event_type"),
      ("time_range", "SELECT * FROM {table} WHERE event_timestamp >= '2025-12-01' AND event_timestamp < '2025-12-02'")
    )
    
    List(1000000L, 10000000L).foreach { recordCount =>
      queries.foreach { case (queryName, sqlTemplate) =>
        
        // Benchmark Delta Lake read
        val deltaQuery = sqlTemplate.replace("{table}", s"delta.`s3a://benchmark/delta/events_${recordCount}`")
        val deltaStartTime = System.currentTimeMillis()
        val deltaResult = spark.sql(deltaQuery)
        deltaResult.count() // Force execution
        val deltaEndTime = System.currentTimeMillis()
        
        results += BenchmarkResult(
          operation = s"read_${queryName}",
          tableFormat = "delta",
          recordCount = recordCount,
          executionTimeMs = deltaEndTime - deltaStartTime,
          throughputRecordsPerSec = 0.0,
          fileSizeMB = 0.0,
          queryLatencyMs = deltaEndTime - deltaStartTime
        )
        
        // Benchmark Iceberg read
        val icebergQuery = sqlTemplate.replace("{table}", s"iceberg.benchmark.events_${recordCount}")
        val icebergStartTime = System.currentTimeMillis()
        val icebergResult = spark.sql(icebergQuery)
        icebergResult.count() // Force execution
        val icebergEndTime = System.currentTimeMillis()
        
        results += BenchmarkResult(
          operation = s"read_${queryName}",
          tableFormat = "iceberg",
          recordCount = recordCount,
          executionTimeMs = icebergEndTime - icebergStartTime,
          throughputRecordsPerSec = 0.0,
          fileSizeMB = 0.0,
          queryLatencyMs = icebergEndTime - icebergStartTime
        )
        
        // Benchmark Parquet read
        val parquetQuery = sqlTemplate.replace("{table}", s"parquet.`s3a://benchmark/parquet/events_${recordCount}`")
        val parquetStartTime = System.currentTimeMillis()
        val parquetResult = spark.sql(parquetQuery)
        parquetResult.count() // Force execution
        val parquetEndTime = System.currentTimeMillis()
        
        results += BenchmarkResult(
          operation = s"read_${queryName}",
          tableFormat = "parquet",
          recordCount = recordCount,
          executionTimeMs = parquetEndTime - parquetStartTime,
          throughputRecordsPerSec = 0.0,
          fileSizeMB = 0.0,
          queryLatencyMs = parquetEndTime - parquetStartTime
        )
        
        println(s"Completed ${queryName} benchmark for ${recordCount} records")
      }
    }
    
    results.toList
  }
  
  def benchmarkUpdates(spark: SparkSession): List[BenchmarkResult] = {
    val results = scala.collection.mutable.ListBuffer[BenchmarkResult]()
    val recordCount = 10000000L
    
    // Generate update data (10% of original records)
    val updateData = generateTestData(spark, recordCount / 10)
      .withColumn("revenue", col("revenue") * 1.1) // 10% increase
    
    // Benchmark Delta Lake update
    val deltaStartTime = System.currentTimeMillis()
    updateData.write
      .format("delta")
      .mode("overwrite")
      .option("replaceWhere", "event_type = 'purchase'")
      .save(s"s3a://benchmark/delta/events_${recordCount}")
    val deltaEndTime = System.currentTimeMillis()
    
    results += BenchmarkResult(
      operation = "update",
      tableFormat = "delta",
      recordCount = recordCount / 10,
      executionTimeMs = deltaEndTime - deltaStartTime,
      throughputRecordsPerSec = (recordCount / 10).toDouble / ((deltaEndTime - deltaStartTime) / 1000.0),
      fileSizeMB = 0.0,
      queryLatencyMs = 0L
    )
    
    // Benchmark Iceberg update
    updateData.createOrReplaceTempView("update_data")
    val icebergStartTime = System.currentTimeMillis()
    spark.sql(s"""
      MERGE INTO iceberg.benchmark.events_${recordCount} target
      USING update_data source
      ON target.event_id = source.event_id
      WHEN MATCHED THEN UPDATE SET target.revenue = source.revenue
    """)
    val icebergEndTime = System.currentTimeMillis()
    
    results += BenchmarkResult(
      operation = "update",
      tableFormat = "iceberg",
      recordCount = recordCount / 10,
      executionTimeMs = icebergEndTime - icebergStartTime,
      throughputRecordsPerSec = (recordCount / 10).toDouble / ((icebergEndTime - icebergStartTime) / 1000.0),
      fileSizeMB = 0.0,
      queryLatencyMs = 0L
    )
    
    results.toList
  }
  
  def generateReport(results: List[BenchmarkResult]): Unit = {
    import spark.implicits._
    
    val spark = SparkSession.getActiveSession.get
    val resultsDF = spark.createDataFrame(results)
    
    println("=== Performance Benchmark Report ===")
    
    // Write performance comparison
    println("\nWrite Performance:")
    resultsDF.filter($"operation" === "write")
      .select("tableFormat", "recordCount", "executionTimeMs", "throughputRecordsPerSec", "fileSizeMB")
      .orderBy($"recordCount", $"tableFormat")
      .show(false)
    
    // Read performance comparison
    println("\nRead Performance:")
    resultsDF.filter($"operation".startsWith("read"))
      .select("operation", "tableFormat", "recordCount", "queryLatencyMs")
      .orderBy($"operation", $"recordCount", $"tableFormat")
      .show(false)
    
    // Update performance comparison
    println("\nUpdate Performance:")
    resultsDF.filter($"operation" === "update")
      .select("tableFormat", "recordCount", "executionTimeMs", "throughputRecordsPerSec")
      .orderBy($"tableFormat")
      .show(false)
    
    // Save detailed results
    resultsDF.write
      .format("parquet")
      .mode("overwrite")
      .save("s3a://benchmark/results/detailed_benchmark_results")
  }
  
  private def calculateTableSize(path: String): Double = {
    // Simplified table size calculation
    // In practice, you would use Hadoop FileSystem API
    0.0
  }
}
```

## Production Deployment Strategies

### Kubernetes Deployment

```yaml
# data-lake-deployment.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: data-lake-config
  namespace: data-platform
data:
  spark-defaults.conf: |
    # Delta Lake configuration
    spark.sql.extensions=io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog=org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.databricks.delta.optimizeWrite.enabled=true
    spark.databricks.delta.autoCompact.enabled=true
    
    # Iceberg configuration  
    spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions
    spark.sql.catalog.iceberg=org.apache.iceberg.spark.SparkCatalog
    spark.sql.catalog.iceberg.type=hadoop
    spark.sql.catalog.iceberg.warehouse=s3a://datalake/iceberg-warehouse
    
    # Performance optimizations
    spark.serializer=org.apache.spark.serializer.KryoSerializer
    spark.sql.adaptive.enabled=true
    spark.sql.adaptive.coalescePartitions.enabled=true
    
    # Memory settings
    spark.executor.memory=8g
    spark.executor.cores=4
    spark.driver.memory=4g
    
    # S3 optimizations
    spark.hadoop.fs.s3a.multipart.size=104857600
    spark.hadoop.fs.s3a.multipart.threshold=104857600
    spark.hadoop.fs.s3a.fast.upload=true
    spark.hadoop.fs.s3a.block.size=134217728
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: delta-lake-processor
  namespace: data-platform
spec:
  replicas: 3
  selector:
    matchLabels:
      app: delta-lake-processor
  template:
    metadata:
      labels:
        app: delta-lake-processor
    spec:
      containers:
      - name: spark-processor
        image: delta-lake-spark:3.5.0
        resources:
          requests:
            memory: "12Gi"
            cpu: "4000m"
          limits:
            memory: "16Gi"
            cpu: "6000m"
        env:
        - name: SPARK_CONF_DIR
          value: "/opt/spark/conf"
        - name: AWS_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: aws-credentials
              key: access-key-id
        - name: AWS_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: aws-credentials
              key: secret-access-key
        volumeMounts:
        - name: spark-config
          mountPath: /opt/spark/conf
        - name: temp-storage
          mountPath: /tmp/spark-local
      volumes:
      - name: spark-config
        configMap:
          name: data-lake-config
      - name: temp-storage
        emptyDir:
          sizeLimit: "50Gi"
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: data-lake-optimization
  namespace: data-platform
spec:
  schedule: "0 2 * * *" # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: optimization-job
            image: delta-lake-spark:3.5.0
            command:
            - /opt/spark/bin/spark-submit
            - --class=com.supporttools.datalake.OptimizationJob
            - --master=local[*]
            - /opt/spark/jars/data-lake-optimization.jar
            resources:
              requests:
                memory: "8Gi"
                cpu: "2000m"
              limits:
                memory: "12Gi"
                cpu: "4000m"
            env:
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: aws-credentials
                  key: access-key-id
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: aws-credentials
                  key: secret-access-key
          restartPolicy: OnFailure
```

### Monitoring and Alerting

```yaml
# data-lake-monitoring.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-data-lake-rules
  namespace: monitoring
data:
  data-lake-rules.yml: |
    groups:
    - name: data_lake.rules
      rules:
      - alert: DeltaLakeHighLatency
        expr: spark_streaming_batch_processing_time > 300
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Delta Lake processing latency is high"
          description: "Batch processing time is {{ $value }} seconds"
      
      - alert: DataQualityIssue
        expr: data_quality_score < 0.95
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Data quality score below threshold"
          description: "Data quality score is {{ $value }}"
      
      - alert: TableSizeGrowthAnomaly
        expr: rate(table_size_bytes[1h]) > 1073741824 # 1GB/hour
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Unusual table growth detected"
          description: "Table size growing at {{ $value }} bytes/hour"
---
apiVersion: v1
kind: Service
metadata:
  name: data-lake-metrics
  namespace: data-platform
spec:
  selector:
    app: delta-lake-processor
  ports:
  - port: 4040
    name: spark-ui
  - port: 9090
    name: metrics
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: data-lake-metrics
  namespace: data-platform
spec:
  selector:
    matchLabels:
      app: delta-lake-processor
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

## Conclusion

Modern data lake architectures using Delta Lake and Apache Iceberg provide significant advantages over traditional data lake implementations. Both formats offer ACID transactions, schema evolution, and time travel capabilities, but each has specific strengths:

**Delta Lake Advantages:**
- Mature ecosystem with extensive Databricks integration
- Excellent streaming integration
- Strong community support and documentation
- Optimized for Spark workloads

**Apache Iceberg Advantages:**
- Engine-agnostic design (works with Spark, Flink, Trino, etc.)
- Advanced partition evolution capabilities
- Superior metadata management for large tables
- Growing adoption across multiple platforms

**Key Implementation Considerations:**
1. **Choose based on ecosystem**: Delta Lake for Spark-heavy environments, Iceberg for multi-engine scenarios
2. **Plan for scale**: Both formats handle petabyte-scale data effectively
3. **Monitor performance**: Implement comprehensive monitoring and optimization strategies
4. **Design for evolution**: Leverage schema and partition evolution capabilities
5. **Implement governance**: Use time travel and branching for data governance and compliance

By implementing either or both of these modern table formats, organizations can build robust, scalable, and maintainable data lake architectures that support both batch and streaming analytics workloads while providing enterprise-grade reliability and governance capabilities.