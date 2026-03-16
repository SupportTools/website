---
title: "Advanced Apache Spark Optimization for Large-Scale Data Processing"
date: 2026-04-17T00:00:00-05:00
draft: false
tags: ["Apache Spark", "Big Data", "Performance Optimization", "Data Engineering", "Scala", "PySpark", "Distributed Computing", "Memory Management"]
categories:
- Data Engineering
- Performance Optimization
- Big Data
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Apache Spark optimization techniques for large-scale data processing. Learn memory management, performance tuning, advanced configurations, and production-ready optimization strategies for enterprise Spark deployments."
more_link: "yes"
url: "/advanced-spark-optimization-large-scale-processing/"
---

Apache Spark has revolutionized big data processing, but achieving optimal performance at scale requires deep understanding of its internals and sophisticated optimization techniques. This comprehensive guide explores advanced Spark optimization strategies that can dramatically improve performance for large-scale data processing workloads.

<!--more-->

# Advanced Apache Spark Optimization for Large-Scale Data Processing

## Understanding Spark Performance Fundamentals

Apache Spark's performance depends on multiple interconnected factors including memory management, serialization, shuffle operations, partitioning strategies, and cluster resource allocation. Optimizing Spark applications requires a systematic approach that addresses each of these areas while considering the specific characteristics of your data and workload patterns.

### Spark Architecture Deep Dive

Understanding Spark's execution model is crucial for optimization:

```scala
// SparkArchitectureExample.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.SparkSession
import org.apache.spark.sql.functions._
import org.apache.spark.sql.types._
import org.apache.spark.storage.StorageLevel
import org.apache.spark.serializer.KryoSerializer

object SparkArchitectureExample {
  
  def createOptimizedSparkSession(): SparkSession = {
    SparkSession.builder()
      .appName("Advanced Spark Optimization Example")
      .config("spark.serializer", classOf[KryoSerializer].getName)
      .config("spark.sql.adaptive.enabled", "true")
      .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
      .config("spark.sql.adaptive.skewJoin.enabled", "true")
      .config("spark.sql.adaptive.localShuffleReader.enabled", "true")
      .config("spark.sql.codegen.wholeStage", "true")
      .config("spark.sql.codegen.factoryMode", "CODEGEN_ONLY")
      .config("spark.sql.execution.arrow.pyspark.enabled", "true")
      .config("spark.executor.memory", "8g")
      .config("spark.executor.cores", "5")
      .config("spark.executor.instances", "20")
      .config("spark.executor.memoryFraction", "0.8")
      .config("spark.executor.memoryStorageFraction", "0.3")
      .config("spark.network.timeout", "800s")
      .config("spark.executor.heartbeatInterval", "60s")
      .getOrCreate()
  }
  
  def demonstrateOptimizationTechniques(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Read large dataset with optimized schema
    val optimizedSchema = StructType(Array(
      StructField("user_id", LongType, nullable = false),
      StructField("event_timestamp", TimestampType, nullable = false),
      StructField("event_type", StringType, nullable = false),
      StructField("session_id", StringType, nullable = false),
      StructField("page_url", StringType, nullable = true),
      StructField("user_agent", StringType, nullable = true),
      StructField("ip_address", StringType, nullable = true),
      StructField("revenue", DecimalType(10, 2), nullable = true)
    ))
    
    val rawData = spark.read
      .option("multiline", "false")
      .option("inferSchema", "false")
      .schema(optimizedSchema)
      .parquet("s3a://data-lake/events/year=2025/month=12/")
    
    // Cache frequently accessed data with optimal storage level
    val cachedData = rawData
      .filter($"event_timestamp" >= "2025-12-01")
      .persist(StorageLevel.MEMORY_AND_DISK_SER_2)
    
    // Trigger caching
    cachedData.count()
    
    // Advanced aggregation with optimized partitioning
    val aggregatedMetrics = cachedData
      .repartition(200, $"user_id") // Optimal partition count
      .groupBy($"user_id", date_trunc("hour", $"event_timestamp").alias("hour"))
      .agg(
        count("*").alias("event_count"),
        countDistinct("session_id").alias("unique_sessions"),
        sum(when($"event_type" === "purchase", $"revenue").otherwise(0)).alias("total_revenue"),
        collect_set("page_url").alias("visited_pages"),
        max("event_timestamp").alias("last_activity")
      )
      .persist(StorageLevel.MEMORY_AND_DISK_SER)
    
    // Write optimized output
    aggregatedMetrics
      .coalesce(50) // Reduce number of output files
      .write
      .mode("overwrite")
      .option("compression", "snappy")
      .partitionBy("hour")
      .parquet("s3a://data-lake/aggregated/user_metrics/")
  }
}
```

## Memory Management Optimization

### Executor Memory Configuration

Proper memory configuration is critical for Spark performance:

```scala
// MemoryOptimization.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.SparkSession
import org.apache.spark.storage.StorageLevel
import org.apache.spark.util.SizeEstimator

object MemoryOptimization {
  
  case class OptimizedSparkConfig(
    executorMemory: String,
    executorCores: Int,
    executorInstances: Int,
    memoryFraction: Double,
    storageFraction: Double,
    offHeapEnabled: Boolean,
    offHeapSize: String
  )
  
  def calculateOptimalMemorySettings(
    totalClusterMemory: Long,
    datasetSize: Long,
    concurrentJobs: Int
  ): OptimizedSparkConfig = {
    
    // Calculate executor memory based on cluster resources
    val availableMemory = totalClusterMemory * 0.85 // Leave 15% for OS and other processes
    val executorCount = Math.min(concurrentJobs * 2, 50) // Optimal executor count
    val executorMemory = (availableMemory / executorCount).toInt
    
    // Calculate memory fractions based on workload characteristics
    val storageFraction = if (datasetSize > availableMemory * 0.5) 0.2 else 0.5
    val memoryFraction = 0.8 // Standard setting for most workloads
    
    OptimizedSparkConfig(
      executorMemory = s"${executorMemory}m",
      executorCores = 5, // Optimal for most workloads
      executorInstances = executorCount,
      memoryFraction = memoryFraction,
      storageFraction = storageFraction,
      offHeapEnabled = datasetSize > availableMemory,
      offHeapSize = s"${executorMemory / 2}m"
    )
  }
  
  def applyMemoryOptimizations(spark: SparkSession): Unit = {
    // Configure garbage collection
    spark.conf.set("spark.executor.extraJavaOptions", 
      "-XX:+UseG1GC " +
      "-XX:MaxGCPauseMillis=200 " +
      "-XX:ParallelGCThreads=8 " +
      "-XX:ConcGCThreads=4 " +
      "-XX:InitiatingHeapOccupancyPercent=35 " +
      "-XX:+UnlockExperimentalVMOptions " +
      "-XX:+UseContainerSupport " +
      "-Djava.security.egd=file:/dev/./urandom"
    )
    
    // Configure driver memory for large datasets
    spark.conf.set("spark.driver.memory", "4g")
    spark.conf.set("spark.driver.maxResultSize", "2g")
    
    // Enable off-heap storage for large datasets
    spark.conf.set("spark.memory.offHeap.enabled", "true")
    spark.conf.set("spark.memory.offHeap.size", "2g")
    
    // Optimize serialization
    spark.conf.set("spark.serializer", "org.apache.spark.serializer.KryoSerializer")
    spark.conf.set("spark.kryo.registrationRequired", "false")
    spark.conf.set("spark.kryoserializer.buffer.max", "1024m")
  }
  
  def monitorMemoryUsage(spark: SparkSession): Unit = {
    // Custom memory monitoring utility
    val statusTracker = spark.sparkContext.statusTracker
    
    def printMemoryStats(): Unit = {
      val executorInfos = statusTracker.getExecutorInfos
      
      executorInfos.foreach { executor =>
        println(s"Executor ${executor.executorId}:")
        println(s"  Memory Used: ${executor.memoryUsed / (1024 * 1024)} MB")
        println(s"  Max Memory: ${executor.maxMemory / (1024 * 1024)} MB")
        println(s"  Memory Utilization: ${(executor.memoryUsed.toDouble / executor.maxMemory * 100).formatted("%.2f")}%")
        println(s"  Active Tasks: ${executor.activeTasks}")
        println(s"  Failed Tasks: ${executor.failedTasks}")
      }
    }
    
    // Print stats every 30 seconds
    val timer = new java.util.Timer()
    timer.scheduleAtFixedRate(new java.util.TimerTask {
      def run() = printMemoryStats()
    }, 0, 30000)
  }
}
```

### Advanced Caching Strategies

```scala
// CachingStrategies.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.{DataFrame, SparkSession}
import org.apache.spark.storage.StorageLevel
import org.apache.spark.sql.functions._

object CachingStrategies {
  
  def implementSmartCaching(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Load base dataset
    val baseData = spark.read.parquet("s3a://data-lake/events/")
    
    // Strategy 1: Cache hot data in memory
    val hotData = baseData
      .filter($"event_timestamp" >= current_date() - 7) // Last 7 days
      .persist(StorageLevel.MEMORY_ONLY_SER_2)
    
    // Strategy 2: Cache warm data with disk spillover
    val warmData = baseData
      .filter($"event_timestamp" >= current_date() - 30) // Last 30 days
      .persist(StorageLevel.MEMORY_AND_DISK_SER_2)
    
    // Strategy 3: Cache cold data on disk only
    val coldData = baseData
      .filter($"event_timestamp" < current_date() - 30)
      .persist(StorageLevel.DISK_ONLY_2)
    
    // Implement cache warming
    warmCaches(hotData, warmData, coldData)
    
    // Implement intelligent cache eviction
    implementCacheEviction(spark, List(hotData, warmData, coldData))
  }
  
  def warmCaches(dataframes: DataFrame*): Unit = {
    // Trigger cache population with lightweight operations
    dataframes.foreach { df =>
      val startTime = System.currentTimeMillis()
      val count = df.count()
      val endTime = System.currentTimeMillis()
      println(s"Cached ${count} records in ${endTime - startTime}ms")
    }
  }
  
  def implementCacheEviction(spark: SparkSession, cachedDataframes: List[DataFrame]): Unit = {
    // Monitor memory usage and evict oldest caches when memory is low
    val memoryThreshold = 0.85 // 85% memory utilization threshold
    
    def checkMemoryAndEvict(): Unit = {
      val statusTracker = spark.sparkContext.statusTracker
      val executorInfos = statusTracker.getExecutorInfos
      
      val totalMemoryUsed = executorInfos.map(_.memoryUsed).sum
      val totalMaxMemory = executorInfos.map(_.maxMemory).sum
      val memoryUtilization = totalMemoryUsed.toDouble / totalMaxMemory
      
      if (memoryUtilization > memoryThreshold) {
        println(s"Memory utilization: ${(memoryUtilization * 100).formatted("%.2f")}% - Evicting oldest caches")
        
        // Evict caches in reverse order (oldest first)
        cachedDataframes.reverse.foreach { df =>
          df.unpersist(blocking = false)
          Thread.sleep(1000) // Give time for cleanup
          
          // Recheck memory utilization
          val newUtilization = statusTracker.getExecutorInfos.map(_.memoryUsed).sum.toDouble / 
                              statusTracker.getExecutorInfos.map(_.maxMemory).sum
          
          if (newUtilization < memoryThreshold) {
            println("Memory utilization back to acceptable levels")
            return
          }
        }
      }
    }
    
    // Schedule periodic memory checks
    val timer = new java.util.Timer()
    timer.scheduleAtFixedRate(new java.util.TimerTask {
      def run() = checkMemoryAndEvict()
    }, 0, 60000) // Check every minute
  }
  
  def implementAdaptiveCaching(df: DataFrame): DataFrame = {
    // Analyze dataset characteristics to determine optimal caching strategy
    val sampleData = df.sample(0.01) // 1% sample
    val recordCount = sampleData.count()
    val estimatedSize = SizeEstimator.estimate(sampleData.collect())
    val totalEstimatedSize = estimatedSize * 100 // Scale up from 1% sample
    
    val storageLevel = totalEstimatedSize match {
      case size if size < 1024 * 1024 * 1024 => // < 1GB
        StorageLevel.MEMORY_ONLY_SER
      case size if size < 10L * 1024 * 1024 * 1024 => // < 10GB
        StorageLevel.MEMORY_AND_DISK_SER
      case _ => // > 10GB
        StorageLevel.DISK_ONLY
    }
    
    println(s"Dataset size: ${totalEstimatedSize / (1024 * 1024)} MB, using storage level: ${storageLevel}")
    df.persist(storageLevel)
  }
}
```

## Shuffle Optimization

### Advanced Partitioning Strategies

```scala
// ShuffleOptimization.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.{DataFrame, SparkSession}
import org.apache.spark.sql.functions._
import org.apache.spark.sql.types._
import org.apache.spark.HashPartitioner
import org.apache.spark.Partitioner

object ShuffleOptimization {
  
  def optimizeShuffleOperations(spark: SparkSession): Unit = {
    import spark.implicits._
    
    // Configure shuffle optimizations
    spark.conf.set("spark.sql.shuffle.partitions", "400")
    spark.conf.set("spark.sql.adaptive.enabled", "true")
    spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")
    spark.conf.set("spark.sql.adaptive.coalescePartitions.minPartitionNum", "1")
    spark.conf.set("spark.sql.adaptive.advisoryPartitionSizeInBytes", "128MB")
    spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")
    spark.conf.set("spark.sql.adaptive.skewJoin.skewedPartitionFactor", "5")
    spark.conf.set("spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes", "256MB")
    
    // Advanced shuffle configuration
    spark.conf.set("spark.shuffle.compress", "true")
    spark.conf.set("spark.shuffle.spill.compress", "true")
    spark.conf.set("spark.io.compression.codec", "snappy")
    spark.conf.set("spark.shuffle.file.buffer", "1024k")
    spark.conf.set("spark.shuffle.io.serverThreads", "128")
    spark.conf.set("spark.shuffle.io.clientThreads", "128")
    spark.conf.set("spark.reducer.maxSizeInFlight", "96m")
    spark.conf.set("spark.shuffle.registration.timeout", "120000")
    spark.conf.set("spark.shuffle.registration.maxAttempts", "5")
  }
  
  def implementOptimalPartitioning(df: DataFrame, joinColumns: Seq[String]): DataFrame = {
    // Calculate optimal partition count based on data size and cluster resources
    val totalRows = df.count()
    val targetRowsPerPartition = 1000000 // 1M rows per partition
    val optimalPartitions = Math.max(1, Math.min(2000, (totalRows / targetRowsPerPartition).toInt))
    
    println(s"Total rows: ${totalRows}, Optimal partitions: ${optimalPartitions}")
    
    // Pre-partition data for upcoming joins
    val partitionedDf = if (joinColumns.nonEmpty) {
      df.repartition(optimalPartitions, joinColumns.map(col): _*)
    } else {
      df.repartition(optimalPartitions)
    }
    
    partitionedDf
  }
  
  def optimizeJoinOperations(
    leftDf: DataFrame, 
    rightDf: DataFrame, 
    joinColumns: Seq[String],
    joinType: String = "inner"
  ): DataFrame = {
    
    // Analyze join skew
    val leftSkew = analyzeSkew(leftDf, joinColumns)
    val rightSkew = analyzeSkew(rightDf, joinColumns)
    
    if (leftSkew.maxCount > leftSkew.avgCount * 5 || rightSkew.maxCount > rightSkew.avgCount * 5) {
      println("Detected skewed join - applying skew mitigation strategies")
      return handleSkewedJoin(leftDf, rightDf, joinColumns, joinType)
    }
    
    // Determine optimal join strategy
    val leftSize = estimateDataFrameSize(leftDf)
    val rightSize = estimateDataFrameSize(rightDf)
    
    val joinedDf = (leftSize, rightSize) match {
      case (left, right) if right < 10 * 1024 * 1024 => // Right side < 10MB
        println("Using broadcast join")
        leftDf.join(broadcast(rightDf), joinColumns, joinType)
        
      case (left, right) if left < 10 * 1024 * 1024 => // Left side < 10MB
        println("Using broadcast join (left side)")
        broadcast(leftDf).join(rightDf, joinColumns, joinType)
        
      case _ =>
        println("Using sort-merge join with optimized partitioning")
        val optimalPartitions = calculateOptimalJoinPartitions(leftSize, rightSize)
        
        val partitionedLeft = leftDf.repartition(optimalPartitions, joinColumns.map(col): _*)
        val partitionedRight = rightDf.repartition(optimalPartitions, joinColumns.map(col): _*)
        
        partitionedLeft.join(partitionedRight, joinColumns, joinType)
    }
    
    joinedDf
  }
  
  case class SkewAnalysis(minCount: Long, maxCount: Long, avgCount: Double, skewFactor: Double)
  
  def analyzeSkew(df: DataFrame, columns: Seq[String]): SkewAnalysis = {
    val counts = df.groupBy(columns.map(col): _*)
      .count()
      .select("count")
      .collect()
      .map(_.getLong(0))
    
    val minCount = counts.min
    val maxCount = counts.max
    val avgCount = counts.sum.toDouble / counts.length
    val skewFactor = maxCount.toDouble / avgCount
    
    SkewAnalysis(minCount, maxCount, avgCount, skewFactor)
  }
  
  def handleSkewedJoin(
    leftDf: DataFrame, 
    rightDf: DataFrame, 
    joinColumns: Seq[String],
    joinType: String
  ): DataFrame = {
    
    // Strategy 1: Salt the join keys
    val saltedLeft = leftDf.withColumn("salt", (rand() * 100).cast(IntegerType))
    val saltedRight = rightDf.withColumn("salt", explode(array((0 until 100).map(lit): _*)))
    
    // Create salted join columns
    val saltedJoinColumns = joinColumns :+ "salt"
    
    val result = saltedLeft.join(saltedRight, saltedJoinColumns, joinType)
      .drop("salt")
    
    result
  }
  
  def estimateDataFrameSize(df: DataFrame): Long = {
    // Estimate DataFrame size based on schema and row count
    val sampleSize = Math.min(10000, df.count())
    val sample = df.limit(sampleSize.toInt).collect()
    
    if (sample.nonEmpty) {
      val avgRowSize = SizeEstimator.estimate(sample) / sample.length
      avgRowSize * df.count()
    } else {
      0L
    }
  }
  
  def calculateOptimalJoinPartitions(leftSize: Long, rightSize: Long): Int = {
    val totalSize = leftSize + rightSize
    val targetPartitionSize = 128 * 1024 * 1024 // 128MB per partition
    Math.max(1, Math.min(2000, (totalSize / targetPartitionSize).toInt))
  }
  
  // Custom partitioner for specific use cases
  class CustomHashPartitioner(partitions: Int, keyExtractor: Any => String) extends Partitioner {
    override def numPartitions: Int = partitions
    
    override def getPartition(key: Any): Int = {
      val extractedKey = keyExtractor(key)
      (extractedKey.hashCode & Int.MaxValue) % numPartitions
    }
  }
}
```

## Code Generation and Catalyst Optimization

### Whole-Stage Code Generation

```scala
// CodeGenOptimization.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.{DataFrame, SparkSession}
import org.apache.spark.sql.catalyst.expressions.codegen.CodegenContext
import org.apache.spark.sql.catalyst.expressions.{Expression, UnaryExpression}
import org.apache.spark.sql.functions._
import org.apache.spark.sql.types._

object CodeGenOptimization {
  
  def enableCodeGenOptimizations(spark: SparkSession): Unit = {
    // Enable whole-stage code generation
    spark.conf.set("spark.sql.codegen.wholeStage", "true")
    spark.conf.set("spark.sql.codegen.factoryMode", "CODEGEN_ONLY")
    spark.conf.set("spark.sql.codegen.hugeMethodLimit", "65535")
    spark.conf.set("spark.sql.codegen.methodSplitThreshold", "1024")
    spark.conf.set("spark.sql.codegen.splitConsumerFunc.enabled", "true")
    
    // Enable columnar processing
    spark.conf.set("spark.sql.execution.arrow.pyspark.enabled", "true")
    spark.conf.set("spark.sql.execution.arrow.pyspark.fallback.enabled", "true")
    spark.conf.set("spark.sql.execution.arrow.maxRecordsPerBatch", "10000")
    
    // Enable vectorized operations
    spark.conf.set("spark.sql.parquet.enableVectorizedReader", "true")
    spark.conf.set("spark.sql.orc.enableVectorizedReader", "true")
    spark.conf.set("spark.sql.csv.parser.columnPruning.enabled", "true")
  }
  
  def optimizeExpressionEvaluation(df: DataFrame): DataFrame = {
    // Use built-in functions that benefit from code generation
    val optimizedDf = df
      .withColumn("optimized_calculation", 
        when($"value" > 100, $"value" * 1.1)
        .when($"value" > 50, $"value" * 1.05)
        .otherwise($"value")
      )
      .withColumn("complex_calculation",
        sqrt(pow($"value", 2) + pow($"other_value", 2))
      )
      .withColumn("string_operations",
        concat_ws("-", $"prefix", lpad($"id".cast(StringType), 6, "0"))
      )
    
    optimizedDf
  }
  
  def implementCustomCodeGenExpression(): Unit = {
    // Example of custom expression that supports code generation
    case class OptimizedStringHash(child: Expression) extends UnaryExpression {
      override def dataType: DataType = LongType
      override def nullSafeEval(input: Any): Any = {
        input.toString.hashCode.toLong
      }
      
      override def doGenCode(ctx: CodegenContext, ev: ExprCode): ExprCode = {
        val eval = child.genCode(ctx)
        ev.copy(code = s"""
          ${eval.code}
          boolean ${ev.isNull} = ${eval.isNull};
          long ${ev.value} = ${ev.isNull} ? -1L : (long)${eval.value}.toString().hashCode();
        """)
      }
    }
  }
  
  def analyzeCodeGeneration(spark: SparkSession, df: DataFrame): Unit = {
    // Enable code generation debugging
    spark.conf.set("spark.sql.codegen.wholeStage", "true")
    spark.conf.set("spark.sql.codegen.comments", "true")
    
    // Create a complex query to analyze code generation
    val complexQuery = df
      .filter($"status" === "active")
      .groupBy($"category")
      .agg(
        count("*").alias("total_count"),
        sum($"revenue").alias("total_revenue"),
        avg($"score").alias("avg_score"),
        max($"timestamp").alias("last_update")
      )
      .withColumn("revenue_per_item", $"total_revenue" / $"total_count")
      .filter($"total_count" > 100)
    
    // Explain the execution plan to see code generation
    complexQuery.explain("codegen")
    
    // Monitor code generation metrics
    val plan = complexQuery.queryExecution.executedPlan
    println(s"Whole-stage codegen enabled: ${plan.find(_.isInstanceOf[WholeStageCodegenExec]).isDefined}")
  }
}
```

### Catalyst Optimizer Enhancements

```scala
// CatalystOptimization.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.{DataFrame, SparkSession}
import org.apache.spark.sql.catalyst.plans.logical.LogicalPlan
import org.apache.spark.sql.catalyst.rules.Rule
import org.apache.spark.sql.functions._

object CatalystOptimization {
  
  def enableAdvancedCatalystOptimizations(spark: SparkSession): Unit = {
    // Enable cost-based optimizer
    spark.conf.set("spark.sql.cbo.enabled", "true")
    spark.conf.set("spark.sql.cbo.joinReorder.enabled", "true")
    spark.conf.set("spark.sql.cbo.joinReorder.dp.threshold", "12")
    spark.conf.set("spark.sql.cbo.joinReorder.card.weight", "0.7")
    spark.conf.set("spark.sql.cbo.starSchemaDetection", "true")
    
    // Enable predicate pushdown optimizations
    spark.conf.set("spark.sql.parquet.filterPushdown", "true")
    spark.conf.set("spark.sql.parquet.aggregatePushdown", "true")
    spark.conf.set("spark.sql.orc.filterPushdown", "true")
    spark.conf.set("spark.sql.orc.aggregatePushdown", "true")
    
    // Enable column pruning
    spark.conf.set("spark.sql.parquet.enableNestedColumnVectorizedReader", "true")
    spark.conf.set("spark.sql.optimizer.nestedSchemaPruning.enabled", "true")
    spark.conf.set("spark.sql.optimizer.nestedPredicatePushdown.supportedFileFormats", "parquet,orc")
    
    // Enable join optimizations
    spark.conf.set("spark.sql.optimizer.runtime.bloomFilter.enabled", "true")
    spark.conf.set("spark.sql.optimizer.runtime.bloomFilter.creationSideThreshold", "10MB")
    spark.conf.set("spark.sql.optimizer.runtime.bloomFilter.applicationSideThreshold", "100MB")
  }
  
  def optimizeQueryStructure(df: DataFrame): DataFrame = {
    // Demonstrate query optimization techniques
    
    // 1. Use column pruning - select only needed columns early
    val prunedDf = df.select("user_id", "event_timestamp", "event_type", "revenue")
    
    // 2. Apply filters early (predicate pushdown)
    val filteredDf = prunedDf
      .filter($"event_timestamp" >= "2025-12-01")
      .filter($"event_type".isin("purchase", "view", "click"))
    
    // 3. Use efficient aggregations
    val aggregatedDf = filteredDf
      .groupBy($"user_id")
      .agg(
        count("*").alias("total_events"),
        sum(when($"event_type" === "purchase", $"revenue").otherwise(0)).alias("total_revenue"),
        countDistinct("event_type").alias("unique_event_types"),
        first("event_timestamp").alias("first_event")
      )
    
    // 4. Apply final filters after aggregation
    aggregatedDf.filter($"total_events" > 5)
  }
  
  def implementCustomOptimizationRule(): Rule[LogicalPlan] = {
    // Custom rule to optimize specific patterns
    new Rule[LogicalPlan] {
      def ruleName: String = "CustomOptimizationRule"
      
      def apply(plan: LogicalPlan): LogicalPlan = {
        plan.transformAllExpressions {
          case expr if isOptimizable(expr) => optimizeExpression(expr)
          case expr => expr
        }
      }
      
      private def isOptimizable(expr: Expression): Boolean = {
        // Define conditions for optimization
        expr.toString.contains("unnecessary_function")
      }
      
      private def optimizeExpression(expr: Expression): Expression = {
        // Implement optimization logic
        expr // Placeholder
      }
    }
  }
  
  def analyzeQueryPlan(df: DataFrame): Unit = {
    println("=== Logical Plan ===")
    df.explain(true)
    
    println("\n=== Physical Plan ===")
    df.explain("formatted")
    
    println("\n=== Cost Analysis ===")
    val plan = df.queryExecution.optimizedPlan
    println(s"Plan complexity: ${plan.stats.sizeInBytes} bytes")
    println(s"Row count estimate: ${plan.stats.rowCount.getOrElse("Unknown")}")
  }
  
  def optimizeStarSchemaJoins(
    factTable: DataFrame,
    dimensionTables: Map[String, DataFrame]
  ): DataFrame = {
    // Optimize star schema joins using broadcast hints and join reordering
    
    var result = factTable
    
    // Sort dimension tables by size (smallest first for broadcast)
    val sortedDimensions = dimensionTables.toSeq.sortBy { case (_, df) =>
      estimateDataFrameSize(df)
    }
    
    sortedDimensions.foreach { case (dimName, dimDf) =>
      val dimSize = estimateDataFrameSize(dimDf)
      
      if (dimSize < 100 * 1024 * 1024) { // < 100MB
        println(s"Broadcasting dimension table: ${dimName}")
        result = result.join(broadcast(dimDf), Seq(s"${dimName}_id"), "left")
      } else {
        println(s"Using sort-merge join for dimension table: ${dimName}")
        result = result.join(dimDf, Seq(s"${dimName}_id"), "left")
      }
    }
    
    result
  }
  
  private def estimateDataFrameSize(df: DataFrame): Long = {
    // Simple size estimation based on schema and row count
    val rowCount = df.count()
    val avgRowSize = df.schema.fields.map { field =>
      field.dataType match {
        case StringType => 20 // Average string size
        case IntegerType | DateType => 4
        case LongType | TimestampType | DoubleType => 8
        case BooleanType => 1
        case DecimalType() => 16
        case _ => 20 // Default
      }
    }.sum
    
    rowCount * avgRowSize
  }
}
```

## I/O Optimization

### File Format and Compression Optimization

```scala
// IOOptimization.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.{DataFrame, SaveMode, SparkSession}
import org.apache.spark.sql.functions._
import org.apache.spark.sql.types._

object IOOptimization {
  
  def optimizeFileFormats(spark: SparkSession): Unit = {
    // Configure optimal file format settings
    
    // Parquet optimizations
    spark.conf.set("spark.sql.parquet.compression.codec", "snappy")
    spark.conf.set("spark.sql.parquet.block.size", "134217728") // 128MB
    spark.conf.set("spark.sql.parquet.page.size", "1048576") // 1MB
    spark.conf.set("spark.sql.parquet.dictionary.enabled", "true")
    spark.conf.set("spark.sql.parquet.enableVectorizedReader", "true")
    spark.conf.set("spark.sql.parquet.recordLevelFilter.enabled", "true")
    
    // Delta Lake optimizations
    spark.conf.set("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
    spark.conf.set("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
    spark.conf.set("spark.databricks.delta.optimizeWrite.enabled", "true")
    spark.conf.set("spark.databricks.delta.autoCompact.enabled", "true")
    
    // ORC optimizations
    spark.conf.set("spark.sql.orc.compression.codec", "snappy")
    spark.conf.set("spark.sql.orc.enableVectorizedReader", "true")
    spark.conf.set("spark.sql.orc.filterPushdown", "true")
  }
  
  def implementOptimalPartitioning(df: DataFrame, outputPath: String): Unit = {
    // Analyze data distribution for optimal partitioning
    val partitionAnalysis = analyzePartitionDistribution(df, "event_date")
    
    println(s"Partition analysis: ${partitionAnalysis}")
    
    // Apply optimal partitioning strategy
    val optimizedDf = df
      .repartition(200) // Optimal number of files
      .sortWithinPartitions($"user_id", $"event_timestamp") // Sort for better compression
    
    // Write with optimal configuration
    optimizedDf.write
      .mode(SaveMode.Overwrite)
      .option("compression", "snappy")
      .option("maxRecordsPerFile", "500000") // Optimal file size
      .partitionBy("event_date")
      .parquet(outputPath)
  }
  
  def analyzePartitionDistribution(df: DataFrame, partitionColumn: String): Map[String, Long] = {
    df.groupBy(col(partitionColumn))
      .count()
      .collect()
      .map(row => row.getString(0) -> row.getLong(1))
      .toMap
  }
  
  def optimizeReads(spark: SparkSession, inputPath: String): DataFrame = {
    // Implement predicate pushdown and column pruning
    spark.read
      .option("mergeSchema", "false") // Disable expensive schema merging
      .option("pathGlobFilter", "*.parquet") // Filter file types
      .option("modifiedBefore", "2025-12-31") // Date filters
      .option("recursiveFileLookup", "false") // Disable recursive lookup if not needed
      .parquet(inputPath)
      .select("user_id", "event_timestamp", "event_type", "revenue") // Column pruning
      .filter($"event_timestamp" >= "2025-12-01") // Predicate pushdown
  }
  
  def implementDataSkipping(df: DataFrame): DataFrame = {
    // Implement Z-ordering for better data skipping
    df.sortWithinPartitions($"user_id", $"event_timestamp")
      .coalesce(200) // Reduce number of files
  }
  
  case class CompressionAnalysis(
    originalSize: Long,
    compressedSize: Long,
    compressionRatio: Double,
    readTime: Long,
    writeTime: Long
  )
  
  def analyzeCompressionEfficiency(df: DataFrame): Map[String, CompressionAnalysis] = {
    val codecs = Seq("snappy", "gzip", "lz4", "zstd")
    val results = scala.collection.mutable.Map[String, CompressionAnalysis]()
    
    codecs.foreach { codec =>
      val tempPath = s"/tmp/compression_test_${codec}"
      
      // Measure write time
      val writeStart = System.currentTimeMillis()
      df.write
        .mode(SaveMode.Overwrite)
        .option("compression", codec)
        .parquet(tempPath)
      val writeTime = System.currentTimeMillis() - writeStart
      
      // Measure read time
      val readStart = System.currentTimeMillis()
      val readDf = df.sparkSession.read.parquet(tempPath)
      readDf.count() // Force execution
      val readTime = System.currentTimeMillis() - readStart
      
      // Get file sizes (simplified)
      val compressedSize = 1000L // Placeholder - would use actual file system calls
      val originalSize = 1500L // Placeholder
      val compressionRatio = originalSize.toDouble / compressedSize
      
      results(codec) = CompressionAnalysis(
        originalSize, compressedSize, compressionRatio, readTime, writeTime
      )
      
      println(s"Codec: ${codec}, Compression Ratio: ${compressionRatio}, Read Time: ${readTime}ms, Write Time: ${writeTime}ms")
    }
    
    results.toMap
  }
  
  def implementAdaptiveFileSize(df: DataFrame, targetFileSizeMB: Int = 128): DataFrame = {
    // Calculate optimal number of partitions based on target file size
    val totalSizeBytes = estimateDataFrameSize(df)
    val targetFileSizeBytes = targetFileSizeMB * 1024 * 1024
    val optimalPartitions = Math.max(1, (totalSizeBytes / targetFileSizeBytes).toInt)
    
    println(s"Total size: ${totalSizeBytes / (1024*1024)}MB, Target file size: ${targetFileSizeMB}MB, Optimal partitions: ${optimalPartitions}")
    
    df.coalesce(optimalPartitions)
  }
  
  private def estimateDataFrameSize(df: DataFrame): Long = {
    val sampleFraction = 0.01
    val sample = df.sample(sampleFraction)
    val sampleCount = sample.count()
    
    if (sampleCount > 0) {
      val sampleData = sample.collect()
      val avgRowSize = SizeEstimator.estimate(sampleData) / sampleData.length
      (avgRowSize * df.count()) / sampleFraction.toLong
    } else {
      0L
    }
  }
}
```

## Resource Management and Scaling

### Dynamic Resource Allocation

```scala
// ResourceManagement.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.SparkSession
import org.apache.spark.scheduler.{SparkListener, SparkListenerStageCompleted, SparkListenerTaskEnd}

object ResourceManagement {
  
  def configureDynamicAllocation(spark: SparkSession): Unit = {
    // Enable dynamic allocation
    spark.conf.set("spark.dynamicAllocation.enabled", "true")
    spark.conf.set("spark.dynamicAllocation.minExecutors", "2")
    spark.conf.set("spark.dynamicAllocation.maxExecutors", "100")
    spark.conf.set("spark.dynamicAllocation.initialExecutors", "10")
    
    // Configure scaling behavior
    spark.conf.set("spark.dynamicAllocation.executorIdleTimeout", "60s")
    spark.conf.set("spark.dynamicAllocation.cachedExecutorIdleTimeout", "300s")
    spark.conf.set("spark.dynamicAllocation.schedulerBacklogTimeout", "5s")
    spark.conf.set("spark.dynamicAllocation.sustainedSchedulerBacklogTimeout", "5s")
    
    // Configure scaling rates
    spark.conf.set("spark.dynamicAllocation.executorAllocationRatio", "1")
    spark.conf.set("spark.dynamicAllocation.minExecutors", "2")
    spark.conf.set("spark.dynamicAllocation.maxExecutors", "100")
  }
  
  def implementCustomResourceManager(spark: SparkSession): Unit = {
    val resourceManager = new CustomResourceManager(spark)
    spark.sparkContext.addSparkListener(resourceManager)
  }
  
  class CustomResourceManager(spark: SparkSession) extends SparkListener {
    private var currentLoad = 0.0
    private val maxLoad = 0.8
    private val scaleUpThreshold = 0.7
    private val scaleDownThreshold = 0.3
    
    override def onTaskEnd(taskEnd: SparkListenerTaskEnd): Unit = {
      updateCurrentLoad()
      
      if (currentLoad > scaleUpThreshold) {
        scaleUp()
      } else if (currentLoad < scaleDownThreshold) {
        scaleDown()
      }
    }
    
    override def onStageCompleted(stageCompleted: SparkListenerStageCompleted): Unit = {
      val stageInfo = stageCompleted.stageInfo
      val executionTime = stageInfo.completionTime.getOrElse(0L) - stageInfo.submissionTime.getOrElse(0L)
      
      // Adjust resource allocation based on stage performance
      if (executionTime > 300000) { // > 5 minutes
        println(s"Stage ${stageInfo.stageId} took ${executionTime}ms - considering scale up")
        scaleUp()
      }
    }
    
    private def updateCurrentLoad(): Unit = {
      val statusTracker = spark.sparkContext.statusTracker
      val executorInfos = statusTracker.getExecutorInfos
      
      val totalTasks = executorInfos.map(_.activeTasks).sum
      val totalSlots = executorInfos.map(_.maxTasks).sum
      
      currentLoad = if (totalSlots > 0) totalTasks.toDouble / totalSlots else 0.0
    }
    
    private def scaleUp(): Unit = {
      val currentExecutors = spark.sparkContext.getExecutorIds().length
      val targetExecutors = Math.min(100, (currentExecutors * 1.5).toInt)
      
      if (targetExecutors > currentExecutors) {
        println(s"Scaling up from ${currentExecutors} to ${targetExecutors} executors")
        spark.sparkContext.requestTotalExecutors(targetExecutors, 0, Map.empty)
      }
    }
    
    private def scaleDown(): Unit = {
      val currentExecutors = spark.sparkContext.getExecutorIds().length
      val targetExecutors = Math.max(2, (currentExecutors * 0.8).toInt)
      
      if (targetExecutors < currentExecutors) {
        println(s"Scaling down from ${currentExecutors} to ${targetExecutors} executors")
        val executorsToRemove = spark.sparkContext.getExecutorIds().take(currentExecutors - targetExecutors)
        spark.sparkContext.killExecutors(executorsToRemove)
      }
    }
  }
  
  def optimizeResourceUtilization(spark: SparkSession): Unit = {
    // Monitor and optimize resource utilization
    val resourceMonitor = new ResourceMonitor(spark)
    resourceMonitor.startMonitoring()
  }
  
  class ResourceMonitor(spark: SparkSession) {
    private val monitoringInterval = 30000 // 30 seconds
    
    def startMonitoring(): Unit = {
      val timer = new java.util.Timer()
      timer.scheduleAtFixedRate(new java.util.TimerTask {
        def run() = monitorResources()
      }, 0, monitoringInterval)
    }
    
    private def monitorResources(): Unit = {
      val statusTracker = spark.sparkContext.statusTracker
      val executorInfos = statusTracker.getExecutorInfos
      
      val totalMemory = executorInfos.map(_.maxMemory).sum
      val usedMemory = executorInfos.map(_.memoryUsed).sum
      val memoryUtilization = if (totalMemory > 0) usedMemory.toDouble / totalMemory else 0.0
      
      val totalCores = executorInfos.map(_.maxTasks).sum
      val activeTasks = executorInfos.map(_.activeTasks).sum
      val cpuUtilization = if (totalCores > 0) activeTasks.toDouble / totalCores else 0.0
      
      println(s"Resource Utilization - Memory: ${(memoryUtilization * 100).formatted("%.2f")}%, CPU: ${(cpuUtilization * 100).formatted("%.2f")}%")
      
      // Alert on resource inefficiency
      if (memoryUtilization < 0.3 && cpuUtilization < 0.3) {
        println("WARNING: Low resource utilization detected - consider scaling down")
      } else if (memoryUtilization > 0.9 || cpuUtilization > 0.9) {
        println("WARNING: High resource utilization detected - consider scaling up")
      }
    }
  }
  
  def configureOptimalClusterSettings(
    nodeCount: Int,
    coresPerNode: Int,
    memoryPerNodeGB: Int
  ): Map[String, String] = {
    
    // Calculate optimal settings based on cluster resources
    val totalCores = nodeCount * coresPerNode
    val totalMemoryGB = nodeCount * memoryPerNodeGB
    
    // Reserve resources for OS and other processes
    val availableCores = (totalCores * 0.9).toInt
    val availableMemoryGB = (totalMemoryGB * 0.85).toInt
    
    // Calculate executor configuration
    val executorCores = Math.min(5, coresPerNode - 1) // Leave 1 core for OS
    val executorsPerNode = Math.max(1, (coresPerNode - 1) / executorCores)
    val totalExecutors = nodeCount * executorsPerNode
    val executorMemoryGB = (availableMemoryGB / totalExecutors) - 1 // Leave 1GB overhead
    
    Map(
      "spark.executor.cores" -> executorCores.toString,
      "spark.executor.instances" -> totalExecutors.toString,
      "spark.executor.memory" -> s"${executorMemoryGB}g",
      "spark.executor.memoryOverhead" -> s"${Math.max(1, executorMemoryGB / 10)}g",
      "spark.driver.memory" -> "4g",
      "spark.driver.cores" -> "2",
      "spark.sql.shuffle.partitions" -> (totalExecutors * executorCores * 2).toString,
      "spark.default.parallelism" -> (totalExecutors * executorCores).toString
    )
  }
}
```

## Performance Monitoring and Debugging

### Advanced Monitoring Implementation

```scala
// PerformanceMonitoring.scala
package com.supporttools.spark.optimization

import org.apache.spark.sql.SparkSession
import org.apache.spark.scheduler._
import org.apache.spark.util.JsonProtocol
import java.util.concurrent.ConcurrentHashMap
import scala.collection.JavaConverters._

object PerformanceMonitoring {
  
  case class PerformanceMetrics(
    taskDuration: Long,
    gcTime: Long,
    deserializeTime: Long,
    serializeTime: Long,
    shuffleReadTime: Long,
    shuffleWriteTime: Long,
    diskBytesSpilled: Long,
    memoryBytesSpilled: Long
  )
  
  class ComprehensiveSparkListener extends SparkListener {
    private val stageMetrics = new ConcurrentHashMap[Int, scala.collection.mutable.ListBuffer[PerformanceMetrics]]()
    private val jobStartTimes = new ConcurrentHashMap[Int, Long]()
    
    override def onJobStart(jobStart: SparkListenerJobStart): Unit = {
      jobStartTimes.put(jobStart.jobId, System.currentTimeMillis())
      println(s"Job ${jobStart.jobId} started with ${jobStart.stageIds.length} stages")
    }
    
    override def onJobEnd(jobEnd: SparkListenerJobEnd): Unit = {
      val startTime = jobStartTimes.remove(jobEnd.jobId)
      if (startTime != null) {
        val duration = System.currentTimeMillis() - startTime
        println(s"Job ${jobEnd.jobId} completed in ${duration}ms")
        
        jobEnd.jobResult match {
          case JobSucceeded => println(s"Job ${jobEnd.jobId} succeeded")
          case JobFailed(exception) => println(s"Job ${jobEnd.jobId} failed: ${exception}")
        }
      }
    }
    
    override def onStageCompleted(stageCompleted: SparkListenerStageCompleted): Unit = {
      val stageInfo = stageCompleted.stageInfo
      val metrics = stageMetrics.getOrDefault(stageInfo.stageId, scala.collection.mutable.ListBuffer.empty)
      
      // Calculate stage-level statistics
      if (metrics.nonEmpty) {
        val avgTaskDuration = metrics.map(_.taskDuration).sum / metrics.size
        val totalShuffleRead = metrics.map(_.shuffleReadTime).sum
        val totalShuffleWrite = metrics.map(_.shuffleWriteTime).sum
        val totalSpilled = metrics.map(_.diskBytesSpilled + _.memoryBytesSpilled).sum
        
        println(s"Stage ${stageInfo.stageId} completed:")
        println(s"  Tasks: ${stageInfo.numTasks}")
        println(s"  Average task duration: ${avgTaskDuration}ms")
        println(s"  Total shuffle read time: ${totalShuffleRead}ms")
        println(s"  Total shuffle write time: ${totalShuffleWrite}ms")
        println(s"  Total spilled: ${totalSpilled / (1024*1024)}MB")
        
        // Identify performance issues
        analyzeStagePerformance(stageInfo.stageId, metrics.toList)
      }
    }
    
    override def onTaskEnd(taskEnd: SparkListenerTaskEnd): Unit = {
      val taskInfo = taskEnd.taskInfo
      val taskMetrics = taskEnd.taskMetrics
      
      if (taskMetrics != null) {
        val metrics = PerformanceMetrics(
          taskDuration = taskInfo.duration,
          gcTime = taskMetrics.jvmGCTime,
          deserializeTime = taskMetrics.executorDeserializeTime,
          serializeTime = taskMetrics.resultSerializationTime,
          shuffleReadTime = Option(taskMetrics.shuffleReadMetrics).map(_.fetchWaitTime).getOrElse(0L),
          shuffleWriteTime = Option(taskMetrics.shuffleWriteMetrics).map(_.writeTime).getOrElse(0L),
          diskBytesSpilled = taskMetrics.diskBytesSpilled,
          memoryBytesSpilled = taskMetrics.memoryBytesSpilled
        )
        
        stageMetrics.computeIfAbsent(taskEnd.stageId, _ => scala.collection.mutable.ListBuffer.empty) += metrics
      }
    }
    
    private def analyzeStagePerformance(stageId: Int, metrics: List[PerformanceMetrics]): Unit = {
      val taskDurations = metrics.map(_.taskDuration)
      val avgDuration = taskDurations.sum / taskDurations.size
      val maxDuration = taskDurations.max
      val minDuration = taskDurations.min
      
      // Detect skewed tasks
      if (maxDuration > avgDuration * 3) {
        println(s"WARNING: Stage ${stageId} has skewed tasks (max: ${maxDuration}ms, avg: ${avgDuration}ms)")
      }
      
      // Detect excessive GC
      val avgGcTime = metrics.map(_.gcTime).sum / metrics.size
      if (avgGcTime > avgDuration * 0.1) {
        println(s"WARNING: Stage ${stageId} has excessive GC time (${avgGcTime}ms avg)")
      }
      
      // Detect spilling
      val totalSpilled = metrics.map(m => m.diskBytesSpilled + m.memoryBytesSpilled).sum
      if (totalSpilled > 0) {
        println(s"WARNING: Stage ${stageId} spilled ${totalSpilled / (1024*1024)}MB to disk")
      }
      
      // Detect shuffle issues
      val avgShuffleRead = metrics.map(_.shuffleReadTime).sum / metrics.size
      if (avgShuffleRead > avgDuration * 0.5) {
        println(s"WARNING: Stage ${stageId} spends significant time on shuffle reads (${avgShuffleRead}ms avg)")
      }
    }
    
    def getPerformanceReport(): String = {
      val report = new StringBuilder()
      report.append("=== Performance Report ===\n")
      
      stageMetrics.asScala.foreach { case (stageId, metrics) =>
        val avgDuration = metrics.map(_.taskDuration).sum / metrics.size
        val totalTasks = metrics.size
        
        report.append(s"Stage ${stageId}: ${totalTasks} tasks, avg duration: ${avgDuration}ms\n")
      }
      
      report.toString()
    }
  }
  
  def setupAdvancedMonitoring(spark: SparkSession): ComprehensiveSparkListener = {
    val listener = new ComprehensiveSparkListener()
    spark.sparkContext.addSparkListener(listener)
    
    // Configure additional monitoring
    spark.conf.set("spark.eventLog.enabled", "true")
    spark.conf.set("spark.eventLog.dir", "/tmp/spark-events")
    spark.conf.set("spark.history.fs.logDirectory", "/tmp/spark-events")
    
    listener
  }
  
  def generatePerformanceReport(spark: SparkSession): Unit = {
    val statusTracker = spark.sparkContext.statusTracker
    
    println("=== Cluster Performance Report ===")
    
    // Executor information
    val executorInfos = statusTracker.getExecutorInfos
    println(s"Active Executors: ${executorInfos.length}")
    
    executorInfos.foreach { executor =>
      val memUtilization = if (executor.maxMemory > 0) {
        (executor.memoryUsed.toDouble / executor.maxMemory * 100).formatted("%.2f")
      } else "0.00"
      
      println(s"Executor ${executor.executorId}:")
      println(s"  Memory: ${executor.memoryUsed / (1024*1024)}MB / ${executor.maxMemory / (1024*1024)}MB (${memUtilization}%)")
      println(s"  Active Tasks: ${executor.activeTasks}")
      println(s"  Total Tasks: ${executor.totalTasks}")
      println(s"  Failed Tasks: ${executor.failedTasks}")
    }
    
    // Application information
    val appId = spark.sparkContext.applicationId
    val appName = spark.sparkContext.appName
    val startTime = spark.sparkContext.startTime
    val uptime = System.currentTimeMillis() - startTime
    
    println(s"\nApplication: ${appName} (${appId})")
    println(s"Uptime: ${uptime / 1000} seconds")
    
    // Job and stage information
    val activeJobs = statusTracker.getActiveJobIds()
    val activeStages = statusTracker.getActiveStageIds()
    
    println(s"Active Jobs: ${activeJobs.length}")
    println(s"Active Stages: ${activeStages.length}")
  }
  
  def setupJVMProfiling(spark: SparkSession): Unit = {
    // Configure JVM profiling options
    val profilingOptions = Seq(
      "-XX:+UnlockCommercialFeatures",
      "-XX:+FlightRecorder",
      "-XX:StartFlightRecording=duration=300s,filename=/tmp/spark-profile.jfr",
      "-XX:FlightRecorderOptions=defaultrecording=true,disk=true,maxsize=1024m",
      "-XX:+PrintGCDetails",
      "-XX:+PrintGCTimeStamps",
      "-Xloggc:/tmp/gc.log"
    ).mkString(" ")
    
    spark.conf.set("spark.executor.extraJavaOptions", profilingOptions)
    spark.conf.set("spark.driver.extraJavaOptions", profilingOptions)
  }
  
  def analyzeDataSkew(df: DataFrame, columns: Seq[String]): Unit = {
    println(s"Analyzing data skew for columns: ${columns.mkString(", ")}")
    
    val skewAnalysis = df.groupBy(columns.map(col): _*)
      .count()
      .agg(
        min("count").alias("min_count"),
        max("count").alias("max_count"),
        avg("count").alias("avg_count"),
        stddev("count").alias("stddev_count")
      )
      .collect()
      .head
    
    val minCount = skewAnalysis.getLong(0)
    val maxCount = skewAnalysis.getLong(1)
    val avgCount = skewAnalysis.getDouble(2)
    val stddevCount = skewAnalysis.getDouble(3)
    
    val skewRatio = maxCount.toDouble / avgCount
    val cvCoefficient = stddevCount / avgCount
    
    println(s"Skew Analysis Results:")
    println(s"  Min partition size: ${minCount}")
    println(s"  Max partition size: ${maxCount}")
    println(s"  Average partition size: ${avgCount.formatted("%.2f")}")
    println(s"  Skew ratio (max/avg): ${skewRatio.formatted("%.2f")}")
    println(s"  Coefficient of variation: ${cvCoefficient.formatted("%.2f")}")
    
    if (skewRatio > 5.0) {
      println("WARNING: High data skew detected!")
    } else if (skewRatio > 2.0) {
      println("CAUTION: Moderate data skew detected")
    } else {
      println("INFO: Data distribution appears balanced")
    }
  }
}
```

## Production Deployment and Best Practices

### Kubernetes Deployment Configuration

```yaml
# spark-k8s-deployment.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spark-config
  namespace: data-platform
data:
  spark-defaults.conf: |
    spark.master=k8s://https://kubernetes.default.svc:443
    spark.kubernetes.container.image=spark:3.5.0-hadoop3
    spark.kubernetes.namespace=data-platform
    spark.kubernetes.authenticate.driver.serviceAccountName=spark-driver
    spark.kubernetes.authenticate.executor.serviceAccountName=spark-executor
    
    # Memory and CPU settings
    spark.executor.memory=8g
    spark.executor.cores=4
    spark.executor.instances=10
    spark.driver.memory=4g
    spark.driver.cores=2
    
    # Kubernetes-specific settings
    spark.kubernetes.executor.deleteOnTermination=true
    spark.kubernetes.executor.limit.cores=4
    spark.kubernetes.driver.limit.cores=2
    spark.kubernetes.executor.request.cores=3
    spark.kubernetes.driver.request.cores=1
    
    # Storage settings
    spark.kubernetes.local.dirs.tmpfs=true
    spark.kubernetes.executor.volumes.persistentVolumeClaim.data.options.claimName=spark-pvc
    spark.kubernetes.executor.volumes.persistentVolumeClaim.data.mount.path=/tmp/spark-local
    
    # Performance optimizations
    spark.serializer=org.apache.spark.serializer.KryoSerializer
    spark.sql.adaptive.enabled=true
    spark.sql.adaptive.coalescePartitions.enabled=true
    spark.sql.adaptive.skewJoin.enabled=true
    
    # Monitoring
    spark.eventLog.enabled=true
    spark.eventLog.dir=s3a://spark-logs/
    spark.metrics.conf.driver.source.jvm.class=org.apache.spark.metrics.source.JvmSource
    spark.metrics.conf.executor.source.jvm.class=org.apache.spark.metrics.source.JvmSource
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spark-driver
  namespace: data-platform
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spark-executor
  namespace: data-platform
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: spark-operator
subjects:
- kind: ServiceAccount
  name: spark-driver
  namespace: data-platform
- kind: ServiceAccount
  name: spark-executor
  namespace: data-platform
roleRef:
  kind: ClusterRole
  name: edit
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: spark-optimization-job
  namespace: data-platform
spec:
  schedule: "0 */6 * * *" # Every 6 hours
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: spark-driver
          containers:
          - name: spark-submit
            image: spark:3.5.0-hadoop3
            command:
            - /opt/spark/bin/spark-submit
            - --master=k8s://https://kubernetes.default.svc:443
            - --deploy-mode=cluster
            - --name=optimization-job
            - --conf=spark.kubernetes.container.image=spark:3.5.0-hadoop3
            - --conf=spark.kubernetes.namespace=data-platform
            - --conf=spark.executor.instances=20
            - --conf=spark.executor.cores=5
            - --conf=spark.executor.memory=8g
            - --conf=spark.driver.memory=4g
            - --class=com.supporttools.spark.optimization.OptimizationJob
            - s3a://spark-apps/optimization-job.jar
            resources:
              requests:
                memory: "1Gi"
                cpu: "500m"
              limits:
                memory: "2Gi"
                cpu: "1000m"
          restartPolicy: OnFailure
```

## Conclusion

Optimizing Apache Spark for large-scale data processing requires a comprehensive understanding of its architecture, execution model, and configuration options. This guide provides advanced optimization techniques covering memory management, shuffle optimization, code generation, I/O efficiency, and resource management.

Key optimization strategies include:

1. **Memory Management**: Proper executor configuration, intelligent caching strategies, and garbage collection tuning
2. **Shuffle Optimization**: Advanced partitioning, join optimization, and skew handling
3. **Code Generation**: Enabling whole-stage code generation and catalyst optimizations
4. **I/O Optimization**: Optimal file formats, compression, and partitioning strategies
5. **Resource Management**: Dynamic allocation and cluster optimization
6. **Monitoring**: Comprehensive performance monitoring and debugging

By implementing these optimization techniques systematically and continuously monitoring performance, you can achieve significant improvements in Spark application performance, often seeing 2-10x improvements in execution time and resource efficiency for large-scale data processing workloads.