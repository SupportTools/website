---
title: "MongoDB Sharding Strategies for Enterprise Applications: Comprehensive Production Guide"
date: 2026-09-25T00:00:00-05:00
draft: false
tags: ["MongoDB", "Sharding", "Database", "NoSQL", "Distributed Systems", "Enterprise", "Performance", "Scalability"]
categories: ["Database Administration", "MongoDB", "Distributed Systems", "NoSQL"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive enterprise guide to MongoDB sharding architecture, shard key selection strategies, zone sharding implementation, performance optimization, and migration patterns from replica sets to sharded clusters for production environments."
more_link: "yes"
url: "/mongodb-sharding-strategies-enterprise-applications/"
---

## Executive Summary

MongoDB sharding enables horizontal scaling for enterprise applications by distributing data across multiple servers. This comprehensive guide explores advanced sharding strategies, shard key design patterns, zone-based sharding for data locality, and migration approaches from replica sets to sharded clusters in production environments.

### Key Architecture Benefits

**Horizontal Scalability**: Distribute data and load across multiple shards, enabling linear scaling for both storage capacity and query throughput.

**Geographic Distribution**: Zone sharding enables data locality compliance and reduced latency by placing data near users.

**High Availability**: Combined with replica sets, sharding provides both scalability and fault tolerance for mission-critical applications.

**Workload Isolation**: Separate read and write workloads across different shards, optimizing resource utilization and performance.

<!--more-->

## MongoDB Sharding Architecture

### Sharded Cluster Components

```yaml
# mongodb-architecture.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mongodb-sharding-architecture
  namespace: mongodb
data:
  architecture: |
    ┌─────────────────────────────────────────────────────────────────┐
    │                    MongoDB Sharded Cluster                       │
    ├─────────────────────────────────────────────────────────────────┤
    │                                                                  │
    │  ┌─────────────────────────────────────────────────────────┐   │
    │  │                    Application Layer                      │   │
    │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │   │
    │  │  │  App 1  │  │  App 2  │  │  App 3  │  │  App N  │   │   │
    │  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘   │   │
    │  │       └────────────┴────────────┴────────────┘          │   │
    │  └───────────────────────────┬─────────────────────────────┘   │
    │                              │                                   │
    │  ┌─────────────────────────────────────────────────────────┐   │
    │  │                     Query Routers (mongos)               │   │
    │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │   │
    │  │  │ mongos1 │  │ mongos2 │  │ mongos3 │  │ mongosN │   │   │
    │  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘   │   │
    │  │       └────────────┴────────────┴────────────┘          │   │
    │  └───────────────────────────┬─────────────────────────────┘   │
    │                              │                                   │
    │  ┌───────────────────────────┴─────────────────────────────┐   │
    │  │                    Config Servers                        │   │
    │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │   │
    │  │  │  Config 1   │  │  Config 2   │  │  Config 3   │    │   │
    │  │  │  (Primary)  │  │ (Secondary) │  │ (Secondary) │    │   │
    │  │  └─────────────┘  └─────────────┘  └─────────────┘    │   │
    │  └─────────────────────────────────────────────────────────┘   │
    │                                                                  │
    │  ┌─────────────────────────────────────────────────────────┐   │
    │  │                      Shard Clusters                      │   │
    │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │   │
    │  │  │   Shard 1    │  │   Shard 2    │  │   Shard N    │ │   │
    │  │  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │ │   │
    │  │  │ │ Primary  │ │  │ │ Primary  │ │  │ │ Primary  │ │ │   │
    │  │  │ ├──────────┤ │  │ ├──────────┤ │  │ ├──────────┤ │ │   │
    │  │  │ │Secondary1│ │  │ │Secondary1│ │  │ │Secondary1│ │ │   │
    │  │  │ ├──────────┤ │  │ ├──────────┤ │  │ ├──────────┤ │ │   │
    │  │  │ │Secondary2│ │  │ │Secondary2│ │  │ │Secondary2│ │ │   │
    │  │  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │ │   │
    │  │  └──────────────┘  └──────────────┘  └──────────────┘ │   │
    │  └─────────────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────────────┘
```

### Comprehensive Sharding Configuration

```javascript
// sharding-config.js
// MongoDB Sharding Configuration Script

// Enable sharding for the database
sh.enableSharding("enterprise_db")

// Create indexes for shard keys
db.getSiblingDB("enterprise_db").users.createIndex(
    { "tenant_id": 1, "user_id": 1 },
    { background: true }
)

db.getSiblingDB("enterprise_db").transactions.createIndex(
    { "region": 1, "timestamp": 1 },
    { background: true }
)

db.getSiblingDB("enterprise_db").analytics.createIndex(
    { "date": 1, "customer_id": "hashed" },
    { background: true }
)

// Configure shard collections with different strategies
// 1. Range-based sharding for time-series data
sh.shardCollection(
    "enterprise_db.transactions",
    { "region": 1, "timestamp": 1 },
    false // unique
)

// 2. Hashed sharding for uniform distribution
sh.shardCollection(
    "enterprise_db.users",
    { "user_id": "hashed" },
    false
)

// 3. Compound shard key for multi-tenant applications
sh.shardCollection(
    "enterprise_db.tenant_data",
    { "tenant_id": 1, "data_id": 1 },
    true // unique
)

// 4. Zone-based sharding for geographic distribution
sh.shardCollection(
    "enterprise_db.geo_data",
    { "country": 1, "city": 1, "_id": 1 },
    false
)

// Configure zone sharding
sh.addShardToZone("shard01", "us-east")
sh.addShardToZone("shard02", "us-west")
sh.addShardToZone("shard03", "eu-west")
sh.addShardToZone("shard04", "ap-southeast")

// Define zone ranges
sh.updateZoneKeyRange(
    "enterprise_db.geo_data",
    { "country": "US", "city": MinKey },
    { "country": "US", "city": MaxKey },
    "us-east"
)

sh.updateZoneKeyRange(
    "enterprise_db.geo_data",
    { "country": "UK", "city": MinKey },
    { "country": "UK", "city": MaxKey },
    "eu-west"
)

sh.updateZoneKeyRange(
    "enterprise_db.geo_data",
    { "country": "SG", "city": MinKey },
    { "country": "SG", "city": MaxKey },
    "ap-southeast"
)

// Configure chunk size for optimal performance
use config
db.settings.updateOne(
    { _id: "chunksize" },
    { $set: { value: 128 } }, // 128MB chunks
    { upsert: true }
)

// Configure balancer window
sh.setBalancerState(true)
db.settings.updateOne(
    { _id: "balancer" },
    {
        $set: {
            activeWindow: {
                start: "02:00",
                stop: "06:00"
            },
            _secondaryThrottle: true,
            attemptToBalanceJumboChunks: true
        }
    },
    { upsert: true }
)

// Configure autosplit
db.settings.updateOne(
    { _id: "autosplit" },
    { $set: { enabled: true } },
    { upsert: true }
)
```

## Shard Key Selection Strategies

### Advanced Shard Key Patterns

```javascript
// shard-key-patterns.js
// Enterprise Shard Key Design Patterns

// Pattern 1: Time-series with bucketing
class TimeSeriesShardKeyDesign {
    constructor() {
        this.bucketSize = 3600; // 1 hour buckets
    }

    // Generate bucketed shard key for time-series data
    generateShardKey(timestamp, deviceId) {
        const bucket = Math.floor(timestamp / this.bucketSize) * this.bucketSize;
        return {
            bucket: bucket,
            deviceId: deviceId,
            timestamp: timestamp
        };
    }

    // Create optimal indexes
    createIndexes(db, collection) {
        // Shard key index
        db[collection].createIndex(
            { "bucket": 1, "deviceId": 1 },
            { background: true }
        );

        // Query optimization indexes
        db[collection].createIndex(
            { "deviceId": 1, "timestamp": -1 },
            { background: true }
        );

        db[collection].createIndex(
            { "timestamp": -1 },
            { 
                background: true,
                expireAfterSeconds: 2592000 // 30 days TTL
            }
        );
    }

    // Configure sharding
    enableSharding(sh, database, collection) {
        sh.shardCollection(
            `${database}.${collection}`,
            { "bucket": 1, "deviceId": 1 },
            false
        );

        // Pre-split chunks for known time ranges
        const now = new Date();
        const startTime = now.getTime();
        
        for (let i = 0; i < 24; i++) {
            const splitPoint = {
                bucket: Math.floor((startTime + (i * 3600000)) / this.bucketSize) * this.bucketSize,
                deviceId: MinKey
            };
            
            sh.splitAt(`${database}.${collection}`, splitPoint);
        }
    }
}

// Pattern 2: Multi-tenant with tenant isolation
class MultiTenantShardKeyDesign {
    // Generate compound shard key for tenant isolation
    generateShardKey(tenantId, entityType, entityId) {
        return {
            tenantId: tenantId,
            entityType: entityType,
            entityId: entityId
        };
    }

    // Configure tenant-based zones
    configureTenantZones(sh, database, collection, tenantMappings) {
        // Enable sharding with compound key
        sh.shardCollection(
            `${database}.${collection}`,
            { "tenantId": 1, "entityType": 1, "entityId": 1 },
            false
        );

        // Assign large tenants to dedicated shards
        for (const [tenantId, shardZone] of Object.entries(tenantMappings)) {
            sh.updateZoneKeyRange(
                `${database}.${collection}`,
                { "tenantId": tenantId, "entityType": MinKey, "entityId": MinKey },
                { "tenantId": tenantId, "entityType": MaxKey, "entityId": MaxKey },
                shardZone
            );
        }
    }

    // Monitor tenant distribution
    async analyzeTenantDistribution(db, collection) {
        const pipeline = [
            {
                $group: {
                    _id: "$tenantId",
                    count: { $sum: 1 },
                    totalSize: { $sum: "$size" }
                }
            },
            {
                $sort: { totalSize: -1 }
            },
            {
                $limit: 100
            }
        ];

        return await db[collection].aggregate(pipeline).toArray();
    }
}

// Pattern 3: Geographic sharding with data locality
class GeographicShardKeyDesign {
    constructor() {
        this.regionMappings = {
            'US': ['us-east-1', 'us-west-2'],
            'EU': ['eu-west-1', 'eu-central-1'],
            'APAC': ['ap-southeast-1', 'ap-northeast-1']
        };
    }

    // Generate location-aware shard key
    generateShardKey(location, customerId, timestamp) {
        const region = this.getRegionFromLocation(location);
        return {
            region: region,
            customerId: customerId,
            timestamp: timestamp
        };
    }

    // Get region from location coordinates or country
    getRegionFromLocation(location) {
        if (location.country) {
            // Country-based mapping
            const countryRegionMap = {
                'US': 'US', 'CA': 'US', 'MX': 'US',
                'UK': 'EU', 'DE': 'EU', 'FR': 'EU',
                'JP': 'APAC', 'SG': 'APAC', 'AU': 'APAC'
            };
            return countryRegionMap[location.country] || 'GLOBAL';
        } else if (location.coordinates) {
            // Coordinate-based mapping
            const [lng, lat] = location.coordinates;
            if (lng >= -180 && lng <= -30) return 'US';
            if (lng >= -30 && lng <= 60) return 'EU';
            if (lng >= 60 && lng <= 180) return 'APAC';
        }
        return 'GLOBAL';
    }

    // Configure geographic zones
    configureGeographicZones(sh, database, collection) {
        sh.shardCollection(
            `${database}.${collection}`,
            { "region": 1, "customerId": 1, "timestamp": 1 },
            false
        );

        // Configure zones for each region
        for (const [region, shards] of Object.entries(this.regionMappings)) {
            shards.forEach(shard => {
                sh.addShardToZone(shard, region);
            });

            sh.updateZoneKeyRange(
                `${database}.${collection}`,
                { "region": region, "customerId": MinKey, "timestamp": MinKey },
                { "region": region, "customerId": MaxKey, "timestamp": MaxKey },
                region
            );
        }
    }
}

// Pattern 4: Hybrid shard key for complex workloads
class HybridShardKeyDesign {
    // Combine multiple strategies for optimal distribution
    generateShardKey(tenantId, category, timestamp, entityId) {
        // Use hashed component for distribution
        const hashedComponent = this.hashString(tenantId + category);
        
        // Use range component for queries
        const timeComponent = Math.floor(timestamp / 86400000); // Daily buckets
        
        return {
            hashBucket: hashedComponent % 1000, // 1000 buckets
            timeComponent: timeComponent,
            tenantId: tenantId,
            entityId: entityId
        };
    }

    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }

    // Pre-split for optimal initial distribution
    preSplitCollection(sh, database, collection, numInitialChunks = 100) {
        sh.shardCollection(
            `${database}.${collection}`,
            { "hashBucket": 1, "timeComponent": 1, "tenantId": 1, "entityId": 1 },
            false
        );

        // Pre-split based on hash buckets
        for (let i = 1; i < numInitialChunks; i++) {
            const splitPoint = {
                hashBucket: Math.floor((1000 / numInitialChunks) * i),
                timeComponent: MinKey,
                tenantId: MinKey,
                entityId: MinKey
            };
            
            sh.splitAt(`${database}.${collection}`, splitPoint);
        }
    }
}
```

### Shard Key Analysis Tools

```javascript
// shard-key-analyzer.js
// Tools for analyzing shard key effectiveness

class ShardKeyAnalyzer {
    constructor(db, collection) {
        this.db = db;
        this.collection = collection;
    }

    // Analyze shard key cardinality
    async analyzeCardinality(shardKey) {
        const pipeline = [
            {
                $group: {
                    _id: shardKey,
                    count: { $sum: 1 }
                }
            },
            {
                $group: {
                    _id: null,
                    uniqueValues: { $sum: 1 },
                    totalDocuments: { $sum: "$count" },
                    distribution: {
                        $push: {
                            key: "$_id",
                            count: "$count"
                        }
                    }
                }
            }
        ];

        const result = await this.db[this.collection]
            .aggregate(pipeline, { allowDiskUse: true })
            .toArray();

        if (result.length > 0) {
            const stats = result[0];
            const cardinality = stats.uniqueValues / stats.totalDocuments;
            
            // Calculate distribution metrics
            const counts = stats.distribution.map(d => d.count);
            const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
            const variance = counts.reduce((sum, count) => 
                sum + Math.pow(count - mean, 2), 0) / counts.length;
            const stdDev = Math.sqrt(variance);
            const cv = stdDev / mean; // Coefficient of variation

            return {
                cardinality: cardinality,
                uniqueValues: stats.uniqueValues,
                totalDocuments: stats.totalDocuments,
                distributionScore: 1 - cv, // Higher is better
                recommendation: this.getCardinalityRecommendation(cardinality, cv)
            };
        }
    }

    getCardinalityRecommendation(cardinality, cv) {
        if (cardinality < 0.01) {
            return "Low cardinality - consider adding more fields to shard key";
        } else if (cardinality > 0.95) {
            return "Very high cardinality - good for even distribution";
        } else if (cv > 0.5) {
            return "Uneven distribution - some shard keys have significantly more documents";
        } else {
            return "Good cardinality and distribution";
        }
    }

    // Analyze query patterns
    async analyzeQueryPatterns(duration = 3600000) { // 1 hour
        const profileCollection = this.db.getSiblingDB("system").profile;
        const endTime = new Date();
        const startTime = new Date(endTime - duration);

        const pipeline = [
            {
                $match: {
                    ns: `${this.db.getName()}.${this.collection}`,
                    ts: { $gte: startTime, $lte: endTime },
                    op: { $in: ["query", "find", "aggregate", "update", "remove"] }
                }
            },
            {
                $project: {
                    op: 1,
                    command: 1,
                    filter: { $ifNull: ["$command.filter", "$command.query", {}] },
                    millis: 1,
                    keysExamined: 1,
                    docsExamined: 1,
                    nreturned: 1
                }
            },
            {
                $group: {
                    _id: {
                        op: "$op",
                        filterKeys: { $objectToArray: "$filter" }
                    },
                    count: { $sum: 1 },
                    avgMillis: { $avg: "$millis" },
                    totalMillis: { $sum: "$millis" },
                    avgKeysExamined: { $avg: "$keysExamined" },
                    avgDocsExamined: { $avg: "$docsExamined" }
                }
            },
            {
                $sort: { totalMillis: -1 }
            },
            {
                $limit: 20
            }
        ];

        return await profileCollection.aggregate(pipeline).toArray();
    }

    // Analyze chunk distribution
    async analyzeChunkDistribution() {
        const configDB = this.db.getSiblingDB("config");
        const namespace = `${this.db.getName()}.${this.collection}`;

        // Get chunk distribution by shard
        const chunkPipeline = [
            {
                $match: { ns: namespace }
            },
            {
                $group: {
                    _id: "$shard",
                    count: { $sum: 1 },
                    minBound: { $min: "$min" },
                    maxBound: { $max: "$max" }
                }
            },
            {
                $sort: { count: -1 }
            }
        ];

        const chunkDistribution = await configDB.chunks
            .aggregate(chunkPipeline)
            .toArray();

        // Calculate jumbo chunks
        const jumboChunks = await configDB.chunks.countDocuments({
            ns: namespace,
            jumbo: true
        });

        // Get collection stats from each shard
        const collStats = await this.db.runCommand({
            collStats: this.collection,
            indexDetails: false
        });

        return {
            chunkDistribution: chunkDistribution,
            totalChunks: chunkDistribution.reduce((sum, shard) => sum + shard.count, 0),
            jumboChunks: jumboChunks,
            shardStats: collStats.shards,
            recommendation: this.getDistributionRecommendation(chunkDistribution, jumboChunks)
        };
    }

    getDistributionRecommendation(distribution, jumboChunks) {
        const counts = distribution.map(s => s.count);
        const max = Math.max(...counts);
        const min = Math.min(...counts);
        const imbalanceRatio = max / min;

        const recommendations = [];

        if (imbalanceRatio > 2) {
            recommendations.push("Significant chunk imbalance detected - consider rebalancing");
        }

        if (jumboChunks > 0) {
            recommendations.push(`${jumboChunks} jumbo chunks detected - may need to refine shard key`);
        }

        return recommendations.length > 0 ? 
            recommendations.join("; ") : 
            "Chunk distribution is balanced";
    }
}
```

## Zone Sharding Implementation

### Geographic Data Distribution

```javascript
// zone-sharding-config.js
// Advanced Zone Sharding Configuration

class ZoneShardingManager {
    constructor(sh) {
        this.sh = sh;
        this.zones = new Map();
    }

    // Define geographic zones with compliance requirements
    defineGeographicZones() {
        const zones = [
            {
                name: "eu-gdpr",
                shards: ["shard-eu-1", "shard-eu-2"],
                countries: ["DE", "FR", "UK", "IT", "ES", "NL", "BE", "PL"],
                compliance: ["GDPR"],
                replication: { w: "majority", j: true }
            },
            {
                name: "us-east",
                shards: ["shard-us-east-1", "shard-us-east-2"],
                states: ["NY", "NJ", "PA", "MA", "CT", "VT", "NH", "ME"],
                compliance: ["SOC2", "HIPAA"],
                replication: { w: 2, j: true }
            },
            {
                name: "us-west",
                shards: ["shard-us-west-1", "shard-us-west-2"],
                states: ["CA", "OR", "WA", "NV", "AZ"],
                compliance: ["CCPA", "SOC2"],
                replication: { w: 2, j: true }
            },
            {
                name: "apac",
                shards: ["shard-apac-1", "shard-apac-2", "shard-apac-3"],
                countries: ["JP", "SG", "AU", "NZ", "KR", "IN"],
                compliance: ["PDPA"],
                replication: { w: "majority", j: true }
            },
            {
                name: "china",
                shards: ["shard-cn-1", "shard-cn-2"],
                countries: ["CN"],
                compliance: ["PIPL"],
                replication: { w: 3, j: true },
                isolated: true // Data sovereignty requirement
            }
        ];

        zones.forEach(zone => {
            this.zones.set(zone.name, zone);
            this.configureZone(zone);
        });
    }

    // Configure zone with shards and tags
    configureZone(zone) {
        // Add shards to zone
        zone.shards.forEach(shard => {
            this.sh.addShardToZone(shard, zone.name);
        });

        // Configure zone-specific settings
        if (zone.isolated) {
            // Ensure data doesn't leave the zone
            this.configureIsolatedZone(zone);
        }
    }

    // Configure isolated zone for data sovereignty
    configureIsolatedZone(zone) {
        // Set zone-specific balancer settings
        const config = this.sh._getConfigDB();
        
        config.settings.updateOne(
            { _id: `balancer-${zone.name}` },
            {
                $set: {
                    zone: zone.name,
                    isolated: true,
                    crossZoneBalancing: false
                }
            },
            { upsert: true }
        );
    }

    // Configure collection for zone sharding
    enableZoneSharding(database, collection, zoneKeyField, additionalKeys = []) {
        const namespace = `${database}.${collection}`;
        
        // Build shard key
        const shardKey = { [zoneKeyField]: 1 };
        additionalKeys.forEach(key => {
            shardKey[key] = 1;
        });

        // Enable sharding
        this.sh.shardCollection(namespace, shardKey);

        // Configure zone ranges for each zone
        this.zones.forEach((zone, zoneName) => {
            if (zone.countries) {
                zone.countries.forEach(country => {
                    this.sh.updateZoneKeyRange(
                        namespace,
                        { [zoneKeyField]: country, ...this.getMinKeys(additionalKeys) },
                        { [zoneKeyField]: country, ...this.getMaxKeys(additionalKeys) },
                        zoneName
                    );
                });
            }

            if (zone.states) {
                zone.states.forEach(state => {
                    this.sh.updateZoneKeyRange(
                        namespace,
                        { [zoneKeyField]: state, ...this.getMinKeys(additionalKeys) },
                        { [zoneKeyField]: state, ...this.getMaxKeys(additionalKeys) },
                        zoneName
                    );
                });
            }
        });
    }

    getMinKeys(keys) {
        const minKeys = {};
        keys.forEach(key => {
            minKeys[key] = MinKey;
        });
        return minKeys;
    }

    getMaxKeys(keys) {
        const maxKeys = {};
        keys.forEach(key => {
            maxKeys[key] = MaxKey;
        });
        return maxKeys;
    }

    // Move chunks between zones
    async moveChunkToZone(namespace, chunk, targetZone) {
        const zone = this.zones.get(targetZone);
        if (!zone) {
            throw new Error(`Zone ${targetZone} not found`);
        }

        // Select target shard in the zone
        const targetShard = zone.shards[Math.floor(Math.random() * zone.shards.length)];

        // Move chunk
        try {
            const result = await this.sh._adminCommand({
                moveChunk: namespace,
                bounds: [chunk.min, chunk.max],
                to: targetShard,
                _secondaryThrottle: true,
                writeConcern: zone.replication
            });

            return {
                success: true,
                chunk: chunk,
                targetShard: targetShard,
                result: result
            };
        } catch (error) {
            return {
                success: false,
                chunk: chunk,
                error: error.message
            };
        }
    }

    // Rebalance zones based on data distribution
    async rebalanceZones(namespace) {
        const configDB = this.sh._getConfigDB();
        
        // Analyze current distribution
        const distribution = await configDB.chunks.aggregate([
            { $match: { ns: namespace } },
            {
                $lookup: {
                    from: "shards",
                    localField: "shard",
                    foreignField: "_id",
                    as: "shardInfo"
                }
            },
            {
                $group: {
                    _id: "$shard",
                    count: { $sum: 1 },
                    dataSize: { $sum: "$dataSize" }
                }
            }
        ]).toArray();

        // Calculate target distribution
        const totalChunks = distribution.reduce((sum, shard) => sum + shard.count, 0);
        const avgChunksPerShard = totalChunks / distribution.length;

        // Identify over and under-utilized shards
        const rebalanceOperations = [];
        
        distribution.forEach(shard => {
            const deviation = shard.count - avgChunksPerShard;
            if (Math.abs(deviation) > avgChunksPerShard * 0.1) { // 10% threshold
                rebalanceOperations.push({
                    shard: shard._id,
                    currentChunks: shard.count,
                    targetChunks: Math.round(avgChunksPerShard),
                    chunksToMove: Math.round(deviation)
                });
            }
        });

        return {
            distribution: distribution,
            avgChunksPerShard: avgChunksPerShard,
            rebalanceNeeded: rebalanceOperations.length > 0,
            operations: rebalanceOperations
        };
    }
}

// Zone-aware application code
class ZoneAwareMongoClient {
    constructor(connectionString, options = {}) {
        this.client = new MongoClient(connectionString, {
            ...options,
            readPreference: "nearest",
            readConcern: { level: "majority" },
            writeConcern: { w: "majority", j: true }
        });
        
        this.zoneMapping = new Map();
        this.initializeZoneMapping();
    }

    initializeZoneMapping() {
        // Map regions to read preferences
        this.zoneMapping.set("eu-gdpr", {
            readPreference: "nearest",
            readPreferenceTags: [{ zone: "eu-gdpr" }]
        });
        
        this.zoneMapping.set("us-east", {
            readPreference: "nearest",
            readPreferenceTags: [{ zone: "us-east" }]
        });
        
        this.zoneMapping.set("china", {
            readPreference: "primary", // Ensure data doesn't leave zone
            readPreferenceTags: [{ zone: "china" }]
        });
    }

    // Get collection with zone-aware read preference
    getCollection(database, collection, userRegion) {
        const zoneConfig = this.zoneMapping.get(userRegion) || {
            readPreference: "nearest"
        };

        return this.client
            .db(database)
            .collection(collection)
            .withOptions(zoneConfig);
    }

    // Execute zone-aware query
    async findWithZoneAwareness(database, collection, query, userLocation) {
        const zone = this.getZoneFromLocation(userLocation);
        const coll = this.getCollection(database, collection, zone);

        // Add zone hint to query for optimization
        const zoneAwareQuery = {
            ...query,
            _zoneHint: zone
        };

        return await coll.find(zoneAwareQuery).toArray();
    }

    getZoneFromLocation(location) {
        // Implement logic to map location to zone
        if (location.country === "CN") return "china";
        if (["DE", "FR", "UK"].includes(location.country)) return "eu-gdpr";
        if (location.country === "US") {
            if (["NY", "NJ", "PA"].includes(location.state)) return "us-east";
            if (["CA", "OR", "WA"].includes(location.state)) return "us-west";
        }
        if (["JP", "SG", "AU"].includes(location.country)) return "apac";
        
        return "default";
    }
}
```

## Performance Optimization

### Query Optimization for Sharded Clusters

```javascript
// sharding-performance-optimizer.js
// Advanced performance optimization for sharded MongoDB

class ShardingPerformanceOptimizer {
    constructor(db, collection) {
        this.db = db;
        this.collection = collection;
    }

    // Optimize queries for sharded environment
    async optimizeQuery(query, options = {}) {
        const queryPlan = await this.analyzeQueryPlan(query);
        const optimizedQuery = this.applyOptimizations(query, queryPlan);
        
        return {
            originalQuery: query,
            optimizedQuery: optimizedQuery,
            expectedImprovement: queryPlan.improvement,
            recommendations: queryPlan.recommendations
        };
    }

    // Analyze query execution plan
    async analyzeQueryPlan(query) {
        const explainResult = await this.db[this.collection]
            .find(query)
            .explain("executionStats");

        const analysis = {
            usesShardKey: false,
            targetedShards: [],
            scatterGather: false,
            indexUsage: [],
            recommendations: []
        };

        // Check if query targets specific shards
        if (explainResult.queryPlanner) {
            const winningPlan = explainResult.queryPlanner.winningPlan;
            
            if (winningPlan.shards) {
                analysis.targetedShards = winningPlan.shards.map(s => s.shardName);
                analysis.scatterGather = winningPlan.shards.length > 1;
            }

            // Check index usage
            if (winningPlan.inputStage && winningPlan.inputStage.indexName) {
                analysis.indexUsage.push(winningPlan.inputStage.indexName);
                analysis.usesShardKey = winningPlan.inputStage.indexName.includes("shard");
            }
        }

        // Generate recommendations
        if (analysis.scatterGather) {
            analysis.recommendations.push(
                "Query causes scatter-gather. Include shard key in query filter."
            );
        }

        if (!analysis.usesShardKey) {
            analysis.recommendations.push(
                "Query doesn't use shard key. Consider adding shard key fields."
            );
        }

        if (analysis.indexUsage.length === 0) {
            analysis.recommendations.push(
                "No index used. Create appropriate indexes for query patterns."
            );
        }

        return analysis;
    }

    // Apply query optimizations
    applyOptimizations(query, queryPlan) {
        let optimizedQuery = { ...query };

        // Add shard key hints if missing
        if (!queryPlan.usesShardKey && this.shardKey) {
            optimizedQuery = this.addShardKeyHint(optimizedQuery);
        }

        // Optimize sort operations
        if (query.sort) {
            optimizedQuery.sort = this.optimizeSortOrder(query.sort);
        }

        // Add read preference for read-heavy queries
        if (!query.writeConcern) {
            optimizedQuery.readPreference = "secondaryPreferred";
        }

        return optimizedQuery;
    }

    // Batch operations for better performance
    createBatchProcessor(batchSize = 1000) {
        return new BatchProcessor(this.db, this.collection, batchSize);
    }

    // Parallel processing across shards
    async parallelProcess(operation, options = {}) {
        const shards = await this.getShardList();
        const promises = [];

        for (const shard of shards) {
            const shardOperation = this.createShardSpecificOperation(
                operation,
                shard,
                options
            );
            promises.push(shardOperation);
        }

        const results = await Promise.allSettled(promises);
        
        return this.aggregateShardResults(results);
    }

    // Create shard-specific operation
    createShardSpecificOperation(operation, shard, options) {
        return new Promise(async (resolve, reject) => {
            try {
                // Add shard targeting hint
                const shardTargetedOp = {
                    ...operation,
                    $readPreference: {
                        mode: "primary",
                        tags: [{ shard: shard.name }]
                    }
                };

                const result = await this.executeOperation(shardTargetedOp);
                resolve({
                    shard: shard.name,
                    result: result,
                    metrics: {
                        executionTime: result.executionTimeMillis,
                        documentsExamined: result.docsExamined
                    }
                });
            } catch (error) {
                reject({
                    shard: shard.name,
                    error: error.message
                });
            }
        });
    }

    // Index optimization for sharded collections
    async optimizeIndexes() {
        const currentIndexes = await this.db[this.collection].getIndexes();
        const queryPatterns = await this.analyzeQueryPatterns();
        
        const recommendations = [];

        // Check for missing shard key index
        const shardKeyIndex = currentIndexes.find(idx => 
            Object.keys(idx.key).includes(this.shardKey)
        );

        if (!shardKeyIndex) {
            recommendations.push({
                action: "create",
                index: { [this.shardKey]: 1 },
                reason: "Missing shard key index"
            });
        }

        // Analyze query patterns for compound indexes
        for (const pattern of queryPatterns) {
            const optimalIndex = this.suggestOptimalIndex(pattern, currentIndexes);
            if (optimalIndex) {
                recommendations.push(optimalIndex);
            }
        }

        // Check for redundant indexes
        const redundantIndexes = this.findRedundantIndexes(currentIndexes);
        for (const index of redundantIndexes) {
            recommendations.push({
                action: "drop",
                index: index.name,
                reason: "Redundant with other indexes"
            });
        }

        return recommendations;
    }
}

// Batch processor for efficient bulk operations
class BatchProcessor {
    constructor(db, collection, batchSize = 1000) {
        this.db = db;
        this.collection = collection;
        this.batchSize = batchSize;
        this.queue = [];
        this.processing = false;
    }

    // Add operation to batch
    add(operation) {
        this.queue.push(operation);
        
        if (this.queue.length >= this.batchSize) {
            this.flush();
        }
    }

    // Process batch
    async flush() {
        if (this.queue.length === 0 || this.processing) {
            return;
        }

        this.processing = true;
        const batch = this.queue.splice(0, this.batchSize);

        try {
            // Group operations by type
            const grouped = this.groupOperations(batch);
            
            // Execute each group in parallel
            const promises = [];
            
            if (grouped.inserts.length > 0) {
                promises.push(this.bulkInsert(grouped.inserts));
            }
            
            if (grouped.updates.length > 0) {
                promises.push(this.bulkUpdate(grouped.updates));
            }
            
            if (grouped.deletes.length > 0) {
                promises.push(this.bulkDelete(grouped.deletes));
            }

            const results = await Promise.all(promises);
            
            return this.aggregateResults(results);
        } finally {
            this.processing = false;
            
            // Process remaining items
            if (this.queue.length > 0) {
                await this.flush();
            }
        }
    }

    // Group operations by type
    groupOperations(operations) {
        const grouped = {
            inserts: [],
            updates: [],
            deletes: []
        };

        for (const op of operations) {
            switch (op.type) {
                case 'insert':
                    grouped.inserts.push(op.document);
                    break;
                case 'update':
                    grouped.updates.push({
                        filter: op.filter,
                        update: op.update,
                        options: op.options
                    });
                    break;
                case 'delete':
                    grouped.deletes.push(op.filter);
                    break;
            }
        }

        return grouped;
    }

    // Bulk insert with ordered execution
    async bulkInsert(documents) {
        const bulkOp = this.db[this.collection].initializeOrderedBulkOp();
        
        for (const doc of documents) {
            // Add shard key if missing
            if (!doc[this.shardKey]) {
                doc[this.shardKey] = this.generateShardKey(doc);
            }
            bulkOp.insert(doc);
        }

        return await bulkOp.execute();
    }

    // Bulk update with sharding awareness
    async bulkUpdate(updates) {
        const bulkOp = this.db[this.collection].initializeUnorderedBulkOp();
        
        for (const update of updates) {
            // Ensure shard key is in filter for targeted updates
            if (!update.filter[this.shardKey]) {
                console.warn("Update missing shard key in filter - may cause scatter-gather");
            }
            
            bulkOp.find(update.filter).update(update.update);
        }

        return await bulkOp.execute();
    }
}
```

### Connection Pooling and Load Balancing

```javascript
// sharded-connection-manager.js
// Advanced connection management for sharded clusters

class ShardedConnectionManager {
    constructor(config) {
        this.config = config;
        this.mongosConnections = new Map();
        this.shardConnections = new Map();
        this.healthChecker = new HealthChecker(this);
        
        this.initializeConnections();
    }

    // Initialize connections to all mongos instances
    async initializeConnections() {
        for (const mongos of this.config.mongosServers) {
            const connection = await this.createMongosConnection(mongos);
            this.mongosConnections.set(mongos.name, connection);
        }

        // Start health monitoring
        this.healthChecker.start();
    }

    // Create optimized mongos connection
    async createMongosConnection(mongosConfig) {
        const options = {
            // Connection pool settings
            maxPoolSize: mongosConfig.maxPoolSize || 100,
            minPoolSize: mongosConfig.minPoolSize || 10,
            maxIdleTimeMS: 60000,
            waitQueueTimeoutMS: 30000,
            
            // Socket settings
            socketTimeoutMS: 300000,
            connectTimeoutMS: 30000,
            
            // Server selection
            serverSelectionTimeoutMS: 30000,
            localThresholdMS: 15,
            
            // Read/Write preferences
            readPreference: mongosConfig.readPreference || "primaryPreferred",
            readConcern: { level: "majority" },
            writeConcern: { 
                w: "majority", 
                j: true,
                wtimeout: 30000 
            },
            
            // Retry settings
            retryWrites: true,
            retryReads: true,
            
            // Monitoring
            monitorCommands: true,
            
            // Load balancing
            loadBalanced: true
        };

        const client = new MongoClient(mongosConfig.url, options);
        await client.connect();

        // Set up connection monitoring
        this.setupConnectionMonitoring(client, mongosConfig.name);

        return {
            client: client,
            config: mongosConfig,
            metrics: {
                activeConnections: 0,
                totalRequests: 0,
                errorCount: 0,
                avgResponseTime: 0
            }
        };
    }

    // Setup connection monitoring
    setupConnectionMonitoring(client, name) {
        // Monitor command starts
        client.on('commandStarted', (event) => {
            this.updateMetrics(name, 'commandStarted', event);
        });

        // Monitor command completions
        client.on('commandSucceeded', (event) => {
            this.updateMetrics(name, 'commandSucceeded', event);
        });

        // Monitor command failures
        client.on('commandFailed', (event) => {
            this.updateMetrics(name, 'commandFailed', event);
        });

        // Monitor connection pool events
        client.on('connectionPoolCreated', (event) => {
            console.log(`Connection pool created for ${name}`);
        });

        client.on('connectionPoolClosed', (event) => {
            console.log(`Connection pool closed for ${name}`);
        });
    }

    // Get optimal connection based on load
    getOptimalConnection(operation = 'read') {
        let optimalConnection = null;
        let minLoad = Infinity;

        for (const [name, connection] of this.mongosConnections) {
            if (!connection.healthy) continue;

            const load = this.calculateConnectionLoad(connection);
            
            // Apply operation-specific preferences
            if (operation === 'write' && connection.config.preferredForWrites) {
                load *= 0.8; // Give preference to write-optimized mongos
            } else if (operation === 'read' && connection.config.preferredForReads) {
                load *= 0.8; // Give preference to read-optimized mongos
            }

            if (load < minLoad) {
                minLoad = load;
                optimalConnection = connection;
            }
        }

        return optimalConnection;
    }

    // Calculate connection load
    calculateConnectionLoad(connection) {
        const metrics = connection.metrics;
        
        // Composite load score based on multiple factors
        const activeConnectionsScore = metrics.activeConnections / connection.config.maxPoolSize;
        const errorRate = metrics.errorCount / Math.max(metrics.totalRequests, 1);
        const responseTimeScore = metrics.avgResponseTime / 1000; // Normalize to seconds

        // Weighted load calculation
        const load = (activeConnectionsScore * 0.4) + 
                    (errorRate * 0.3) + 
                    (responseTimeScore * 0.3);

        return load;
    }

    // Execute operation with automatic failover
    async executeWithFailover(operation, options = {}) {
        const maxRetries = options.maxRetries || 3;
        let lastError = null;

        for (let i = 0; i < maxRetries; i++) {
            const connection = this.getOptimalConnection(options.type);
            
            if (!connection) {
                throw new Error("No healthy mongos connections available");
            }

            try {
                const startTime = Date.now();
                const result = await operation(connection.client);
                
                // Update success metrics
                this.updateResponseTime(connection, Date.now() - startTime);
                connection.metrics.totalRequests++;
                
                return result;
            } catch (error) {
                lastError = error;
                connection.metrics.errorCount++;
                
                // Check if error is retryable
                if (!this.isRetryableError(error)) {
                    throw error;
                }

                // Mark connection as unhealthy if too many errors
                if (connection.metrics.errorCount > 10) {
                    connection.healthy = false;
                }

                // Exponential backoff
                await this.sleep(Math.pow(2, i) * 100);
            }
        }

        throw lastError;
    }

    // Check if error is retryable
    isRetryableError(error) {
        const retryableErrors = [
            'NetworkTimeout',
            'ConnectionClosed',
            'NotPrimaryError',
            'NodeNotFound'
        ];

        return retryableErrors.some(errType => 
            error.message.includes(errType) || error.code === errType
        );
    }

    // Update response time metrics
    updateResponseTime(connection, responseTime) {
        const metrics = connection.metrics;
        const alpha = 0.2; // Exponential moving average factor
        
        if (metrics.avgResponseTime === 0) {
            metrics.avgResponseTime = responseTime;
        } else {
            metrics.avgResponseTime = 
                alpha * responseTime + (1 - alpha) * metrics.avgResponseTime;
        }
    }

    // Close all connections
    async close() {
        this.healthChecker.stop();

        const promises = [];
        for (const [name, connection] of this.mongosConnections) {
            promises.push(connection.client.close());
        }

        await Promise.all(promises);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Health checker for connections
class HealthChecker {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this.interval = null;
    }

    start() {
        this.interval = setInterval(() => {
            this.checkHealth();
        }, 30000); // Check every 30 seconds
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
        }
    }

    async checkHealth() {
        for (const [name, connection] of this.connectionManager.mongosConnections) {
            try {
                // Ping the server
                await connection.client.db('admin').command({ ping: 1 });
                
                // Check shard status
                const shardStatus = await connection.client.db('admin').command({ 
                    listShards: 1 
                });
                
                connection.healthy = true;
                connection.shardInfo = shardStatus.shards;
                
                // Reset error count on successful health check
                if (connection.metrics.errorCount > 0) {
                    connection.metrics.errorCount = Math.floor(
                        connection.metrics.errorCount * 0.5
                    );
                }
            } catch (error) {
                console.error(`Health check failed for ${name}:`, error);
                connection.healthy = false;
            }
        }
    }
}
```

## Migration from Replica Sets to Sharded Clusters

### Migration Strategy and Implementation

```javascript
// replica-to-shard-migration.js
// Zero-downtime migration from replica set to sharded cluster

class ReplicaSetToShardMigration {
    constructor(sourceReplSet, targetCluster) {
        this.sourceReplSet = sourceReplSet;
        this.targetCluster = targetCluster;
        this.migrationState = new MigrationState();
        this.validator = new MigrationValidator();
    }

    // Execute complete migration
    async executeMigration(options = {}) {
        const startTime = new Date();
        
        try {
            // Phase 1: Pre-migration validation
            console.log("Phase 1: Pre-migration validation");
            await this.preMigrationValidation();

            // Phase 2: Initial data sync
            console.log("Phase 2: Initial data sync");
            await this.initialDataSync(options);

            // Phase 3: Setup change stream sync
            console.log("Phase 3: Setting up change stream sync");
            const changeStreamSync = await this.setupChangeStreamSync();

            // Phase 4: Final sync and validation
            console.log("Phase 4: Final sync and validation");
            await this.finalSync();

            // Phase 5: Application cutover
            console.log("Phase 5: Application cutover");
            await this.performCutover(options);

            // Phase 6: Post-migration validation
            console.log("Phase 6: Post-migration validation");
            await this.postMigrationValidation();

            const endTime = new Date();
            const duration = (endTime - startTime) / 1000;

            return {
                success: true,
                duration: duration,
                statistics: this.migrationState.getStatistics()
            };

        } catch (error) {
            await this.rollback();
            throw error;
        }
    }

    // Pre-migration validation
    async preMigrationValidation() {
        const validations = [];

        // Check source replica set health
        validations.push(this.validator.validateReplicaSetHealth(this.sourceReplSet));

        // Check target cluster health
        validations.push(this.validator.validateShardedClusterHealth(this.targetCluster));

        // Validate shard key choices
        validations.push(this.validator.validateShardKeys(this.migrationState.shardKeyMappings));

        // Check disk space
        validations.push(this.validator.validateDiskSpace(
            this.sourceReplSet,
            this.targetCluster
        ));

        const results = await Promise.all(validations);
        
        const failures = results.filter(r => !r.passed);
        if (failures.length > 0) {
            throw new Error(`Pre-migration validation failed: ${JSON.stringify(failures)}`);
        }
    }

    // Initial data sync
    async initialDataSync(options) {
        const collections = await this.getCollectionsToMigrate();
        
        for (const collection of collections) {
            await this.syncCollection(collection, options);
        }
    }

    // Sync individual collection
    async syncCollection(collection, options) {
        const { database, name } = collection;
        const namespace = `${database}.${name}`;

        console.log(`Syncing collection: ${namespace}`);

        // Get collection metadata
        const sourceDB = this.sourceReplSet.db(database);
        const targetDB = this.targetCluster.db(database);

        const collStats = await sourceDB.command({ 
            collStats: name, 
            indexDetails: false 
        });

        const docCount = collStats.count;
        const dataSize = collStats.size;

        console.log(`Collection ${namespace}: ${docCount} documents, ${dataSize} bytes`);

        // Create indexes first
        await this.syncIndexes(sourceDB, targetDB, name);

        // Enable sharding for the collection
        await this.enableShardingForCollection(database, name, collection.shardKey);

        // Sync data in batches
        const batchSize = options.batchSize || 10000;
        let processed = 0;

        const cursor = sourceDB.collection(name).find({}).batchSize(batchSize);

        while (await cursor.hasNext()) {
            const batch = [];
            
            for (let i = 0; i < batchSize && await cursor.hasNext(); i++) {
                const doc = await cursor.next();
                batch.push(doc);
            }

            if (batch.length > 0) {
                await this.insertBatch(targetDB.collection(name), batch);
                processed += batch.length;
                
                this.migrationState.updateProgress(namespace, processed, docCount);
                
                // Throttle if needed
                if (options.throttleMs) {
                    await this.sleep(options.throttleMs);
                }
            }
        }

        await cursor.close();
    }

    // Sync indexes
    async syncIndexes(sourceDB, targetDB, collectionName) {
        const sourceIndexes = await sourceDB.collection(collectionName).getIndexes();
        
        for (const index of sourceIndexes) {
            if (index.name === '_id_') continue; // Skip default _id index
            
            const indexSpec = { ...index };
            delete indexSpec.v;
            delete indexSpec.ns;
            
            try {
                await targetDB.collection(collectionName).createIndex(
                    index.key,
                    {
                        name: index.name,
                        ...indexSpec
                    }
                );
                console.log(`Created index ${index.name} on ${collectionName}`);
            } catch (error) {
                if (error.code !== 86) { // Index already exists
                    throw error;
                }
            }
        }
    }

    // Setup change stream synchronization
    async setupChangeStreamSync() {
        const changeStreams = new Map();
        const collections = await this.getCollectionsToMigrate();

        for (const collection of collections) {
            const { database, name } = collection;
            const namespace = `${database}.${name}`;

            const changeStream = this.sourceReplSet
                .db(database)
                .collection(name)
                .watch([], {
                    fullDocument: 'updateLookup',
                    resumeAfter: this.migrationState.getResumeToken(namespace)
                });

            changeStream.on('change', async (change) => {
                await this.processChangeEvent(change, database, name);
            });

            changeStream.on('error', (error) => {
                console.error(`Change stream error for ${namespace}:`, error);
                this.handleChangeStreamError(namespace, error);
            });

            changeStreams.set(namespace, changeStream);
        }

        this.migrationState.changeStreams = changeStreams;
        return changeStreams;
    }

    // Process change stream event
    async processChangeEvent(change, database, collectionName) {
        const targetCollection = this.targetCluster
            .db(database)
            .collection(collectionName);

        try {
            switch (change.operationType) {
                case 'insert':
                    await targetCollection.insertOne(change.fullDocument);
                    break;
                
                case 'update':
                    await targetCollection.replaceOne(
                        { _id: change.documentKey._id },
                        change.fullDocument,
                        { upsert: true }
                    );
                    break;
                
                case 'replace':
                    await targetCollection.replaceOne(
                        { _id: change.documentKey._id },
                        change.fullDocument,
                        { upsert: true }
                    );
                    break;
                
                case 'delete':
                    await targetCollection.deleteOne({ _id: change.documentKey._id });
                    break;
            }

            // Store resume token
            this.migrationState.updateResumeToken(
                `${database}.${collectionName}`,
                change._id
            );
        } catch (error) {
            console.error(`Error processing change event:`, error);
            throw error;
        }
    }

    // Final sync phase
    async finalSync() {
        // Pause application writes if possible
        console.log("Performing final sync...");

        // Wait for change streams to catch up
        await this.waitForChangeStreamsCatchUp();

        // Verify data consistency
        const consistent = await this.validator.validateDataConsistency(
            this.sourceReplSet,
            this.targetCluster
        );

        if (!consistent) {
            throw new Error("Data consistency validation failed");
        }
    }

    // Perform application cutover
    async performCutover(options) {
        if (options.dryRun) {
            console.log("Dry run mode - skipping actual cutover");
            return;
        }

        // Update application configuration
        console.log("Updating application configuration...");
        
        // This would typically involve:
        // 1. Updating connection strings
        // 2. Deploying new application version
        // 3. Gradual traffic shift
        
        // For this example, we'll simulate the cutover
        await this.updateApplicationConfig({
            connectionString: this.targetCluster.connectionString,
            readPreference: "primaryPreferred",
            writeConcern: { w: "majority", j: true }
        });
    }

    // Post-migration validation
    async postMigrationValidation() {
        const validations = [];

        // Verify document counts
        validations.push(this.validator.validateDocumentCounts(
            this.sourceReplSet,
            this.targetCluster
        ));

        // Verify shard distribution
        validations.push(this.validator.validateShardDistribution(
            this.targetCluster
        ));

        // Test application connectivity
        validations.push(this.validator.validateApplicationConnectivity(
            this.targetCluster
        ));

        const results = await Promise.all(validations);
        
        const failures = results.filter(r => !r.passed);
        if (failures.length > 0) {
            console.warn("Post-migration validation warnings:", failures);
        }
    }

    // Rollback mechanism
    async rollback() {
        console.log("Initiating rollback...");

        try {
            // Stop change streams
            if (this.migrationState.changeStreams) {
                for (const [namespace, stream] of this.migrationState.changeStreams) {
                    await stream.close();
                }
            }

            // Revert application configuration
            await this.revertApplicationConfig();

            // Clean up target cluster if needed
            if (this.migrationState.phase === 'initial_sync') {
                await this.cleanupTargetCluster();
            }

            console.log("Rollback completed");
        } catch (error) {
            console.error("Error during rollback:", error);
            throw error;
        }
    }
}

// Migration state management
class MigrationState {
    constructor() {
        this.phase = 'not_started';
        this.progress = new Map();
        this.resumeTokens = new Map();
        this.startTime = null;
        this.statistics = {
            totalDocuments: 0,
            migratedDocuments: 0,
            errors: 0
        };
    }

    updateProgress(namespace, processed, total) {
        this.progress.set(namespace, {
            processed: processed,
            total: total,
            percentage: (processed / total) * 100
        });

        // Update overall statistics
        this.statistics.migratedDocuments = 
            Array.from(this.progress.values())
                .reduce((sum, p) => sum + p.processed, 0);
    }

    updateResumeToken(namespace, token) {
        this.resumeTokens.set(namespace, token);
    }

    getResumeToken(namespace) {
        return this.resumeTokens.get(namespace);
    }

    getStatistics() {
        return {
            ...this.statistics,
            progress: Object.fromEntries(this.progress),
            duration: this.startTime ? 
                (new Date() - this.startTime) / 1000 : 0
        };
    }
}

// Migration validator
class MigrationValidator {
    async validateReplicaSetHealth(replSet) {
        try {
            const status = await replSet.admin().command({ replSetGetStatus: 1 });
            
            // Check if all members are healthy
            const unhealthyMembers = status.members.filter(m => 
                m.state !== 1 && m.state !== 2 // PRIMARY or SECONDARY
            );

            return {
                passed: unhealthyMembers.length === 0,
                message: unhealthyMembers.length === 0 ? 
                    "Replica set is healthy" : 
                    `Unhealthy members: ${unhealthyMembers.map(m => m.name).join(', ')}`
            };
        } catch (error) {
            return {
                passed: false,
                message: `Failed to check replica set health: ${error.message}`
            };
        }
    }

    async validateShardedClusterHealth(cluster) {
        try {
            // Check shard status
            const shardStatus = await cluster.admin().command({ listShards: 1 });
            
            // Check config server status
            const configStatus = await cluster.admin().command({ 
                replSetGetStatus: 1,
                $readPreference: { mode: "primaryPreferred" }
            });

            // Check balancer status
            const balancerStatus = await cluster.admin().command({ 
                balancerStatus: 1 
            });

            return {
                passed: true,
                message: "Sharded cluster is healthy",
                details: {
                    shards: shardStatus.shards.length,
                    balancerRunning: balancerStatus.inBalancerRound
                }
            };
        } catch (error) {
            return {
                passed: false,
                message: `Failed to check sharded cluster health: ${error.message}`
            };
        }
    }

    async validateDataConsistency(source, target) {
        // Implement consistency checks
        // This is a simplified version - real implementation would be more thorough
        
        const sourceCollections = await source.listCollections().toArray();
        
        for (const coll of sourceCollections) {
            const sourceCount = await source.collection(coll.name).countDocuments();
            const targetCount = await target.collection(coll.name).countDocuments();
            
            if (sourceCount !== targetCount) {
                return {
                    passed: false,
                    message: `Document count mismatch for ${coll.name}: source=${sourceCount}, target=${targetCount}`
                };
            }
        }

        return {
            passed: true,
            message: "Data consistency check passed"
        };
    }
}
```

## Production Monitoring and Maintenance

### Comprehensive Monitoring Setup

```yaml
# mongodb-monitoring-stack.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mongodb-exporter-config
  namespace: mongodb
data:
  mongodb-exporter.yml: |
    mongodb:
      uri: "mongodb://monitoring:password@mongos-1:27017,mongos-2:27017,mongos-3:27017/admin?replicaSet=configReplSet"
      
    # Collect all metrics
    collect_all: true
    
    # Shard-specific metrics
    collect_sharding_metrics: true
    
    # Collect slow queries
    collect_profile: true
    profile_time_ts: 1000  # Queries slower than 1 second
    
    # Collection-specific metrics
    collections_to_collect:
      - database: "*"
        collection: "*"
        indexes: true
        top: true
    
    # Custom metrics
    custom_queries:
      - name: "shard_distribution"
        query: |
          db.getSiblingDB("config").chunks.aggregate([
            { $group: { _id: "$shard", count: { $sum: 1 } } },
            { $project: { shard: "$_id", chunks: "$count" } }
          ])
        
      - name: "jumbo_chunks"
        query: |
          db.getSiblingDB("config").chunks.find({ jumbo: true }).count()
        
      - name: "migration_status"
        query: |
          db.getSiblingDB("config").changelog.find({
            what: "moveChunk.from",
            time: { $gte: new Date(Date.now() - 3600000) }
          }).count()

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mongodb-exporter
  namespace: mongodb
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mongodb-exporter
  template:
    metadata:
      labels:
        app: mongodb-exporter
    spec:
      containers:
      - name: mongodb-exporter
        image: percona/mongodb_exporter:0.35
        args:
          - --config.file=/etc/mongodb-exporter/mongodb-exporter.yml
          - --web.listen-address=:9216
          - --log.level=info
        ports:
        - containerPort: 9216
          name: metrics
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        volumeMounts:
        - name: config
          mountPath: /etc/mongodb-exporter
      volumes:
      - name: config
        configMap:
          name: mongodb-exporter-config

---
apiVersion: v1
kind: Service
metadata:
  name: mongodb-exporter
  namespace: mongodb
  labels:
    app: mongodb-exporter
spec:
  ports:
  - port: 9216
    targetPort: 9216
    name: metrics
  selector:
    app: mongodb-exporter
```

### Grafana Dashboard Configuration

```json
{
  "dashboard": {
    "title": "MongoDB Sharded Cluster Dashboard",
    "panels": [
      {
        "title": "Cluster Overview",
        "gridPos": {"h": 8, "w": 24, "x": 0, "y": 0},
        "targets": [
          {
            "expr": "mongodb_up",
            "legendFormat": "{{ instance }} - {{ shard }}"
          }
        ]
      },
      {
        "title": "Chunk Distribution",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
        "targets": [
          {
            "expr": "mongodb_chunks_per_shard",
            "legendFormat": "{{ shard }}"
          }
        ]
      },
      {
        "title": "Operations Per Second",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
        "targets": [
          {
            "expr": "rate(mongodb_opcounters_total[5m])",
            "legendFormat": "{{ operation }} - {{ instance }}"
          }
        ]
      },
      {
        "title": "Migration Activity",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 16},
        "targets": [
          {
            "expr": "rate(mongodb_chunk_migrations_total[5m])",
            "legendFormat": "{{ direction }} - {{ shard }}"
          }
        ]
      },
      {
        "title": "Query Performance",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 16},
        "targets": [
          {
            "expr": "histogram_quantile(0.95, mongodb_query_duration_seconds_bucket)",
            "legendFormat": "95th percentile"
          },
          {
            "expr": "histogram_quantile(0.99, mongodb_query_duration_seconds_bucket)",
            "legendFormat": "99th percentile"
          }
        ]
      },
      {
        "title": "Shard Key Efficiency",
        "gridPos": {"h": 8, "w": 24, "x": 0, "y": 24},
        "targets": [
          {
            "expr": "mongodb_shard_key_selectivity",
            "legendFormat": "{{ collection }} - {{ shard_key }}"
          }
        ]
      }
    ]
  }
}
```

## Best Practices and Production Considerations

### Shard Key Best Practices

```javascript
// shard-key-best-practices.js
// Production-ready shard key patterns and anti-patterns

class ShardKeyBestPractices {
    // Good shard key patterns
    static goodPatterns = {
        // Compound key with good cardinality
        userActivity: {
            key: { userId: 1, timestamp: 1 },
            description: "High cardinality userId with timestamp for range queries"
        },
        
        // Hashed key for uniform distribution
        documentStorage: {
            key: { documentId: "hashed" },
            description: "Hashed key for uniform distribution of random IDs"
        },
        
        // Location-based with additional uniqueness
        geoData: {
            key: { region: 1, city: 1, timestamp: 1, deviceId: 1 },
            description: "Geographic distribution with time-series and unique device"
        },
        
        // Multi-tenant with tenant isolation
        saasApplication: {
            key: { tenantId: 1, entityType: 1, entityId: 1 },
            description: "Tenant isolation with good distribution within tenants"
        }
    };

    // Anti-patterns to avoid
    static antiPatterns = {
        // Monotonically increasing values
        autoIncrement: {
            key: { _id: 1 },
            problem: "All writes go to one shard (hot shard)",
            solution: "Use hashed _id or compound key"
        },
        
        // Low cardinality
        status: {
            key: { status: 1 },
            problem: "Only few possible values, poor distribution",
            solution: "Add high-cardinality field to compound key"
        },
        
        // Timestamp only
        timestampOnly: {
            key: { createdAt: 1 },
            problem: "Creates hot shard for recent data",
            solution: "Use bucketed timestamps or add another field"
        }
    };

    // Validate proposed shard key
    static validateShardKey(collection, proposedKey) {
        const warnings = [];
        const recommendations = [];

        // Check cardinality
        if (Object.keys(proposedKey).length === 1) {
            const field = Object.keys(proposedKey)[0];
            
            // Check for monotonic patterns
            if (field === '_id' || field.includes('timestamp') || field.includes('date')) {
                warnings.push("Single monotonic field may cause hot shards");
                recommendations.push("Consider compound key or hashing");
            }
        }

        // Check for low cardinality fields
        const lowCardinalityFields = ['status', 'type', 'category', 'state'];
        for (const field of Object.keys(proposedKey)) {
            if (lowCardinalityFields.includes(field)) {
                warnings.push(`Field '${field}' may have low cardinality`);
                recommendations.push("Add high-cardinality field to improve distribution");
            }
        }

        return {
            valid: warnings.length === 0,
            warnings: warnings,
            recommendations: recommendations
        };
    }
}

// Production maintenance procedures
class ShardMaintenanceProcedures {
    // Rebalance chunks across shards
    static async rebalanceChunks(sh, namespace, options = {}) {
        const dryRun = options.dryRun || false;
        const maxChunkMoves = options.maxChunkMoves || 100;
        
        // Get current distribution
        const distribution = await sh.status();
        
        // Calculate ideal distribution
        const totalChunks = distribution.chunks.total;
        const numShards = distribution.shards.length;
        const idealChunksPerShard = Math.floor(totalChunks / numShards);
        
        const moves = [];
        
        // Identify over and under-utilized shards
        const overloaded = [];
        const underloaded = [];
        
        distribution.shards.forEach(shard => {
            const deviation = shard.chunks - idealChunksPerShard;
            
            if (deviation > idealChunksPerShard * 0.1) {
                overloaded.push({ shard: shard.name, excess: deviation });
            } else if (deviation < -idealChunksPerShard * 0.1) {
                underloaded.push({ shard: shard.name, deficit: -deviation });
            }
        });
        
        // Plan chunk movements
        for (const source of overloaded) {
            for (const target of underloaded) {
                const chunksToMove = Math.min(source.excess, target.deficit, maxChunkMoves - moves.length);
                
                if (chunksToMove > 0) {
                    moves.push({
                        from: source.shard,
                        to: target.shard,
                        chunks: chunksToMove
                    });
                    
                    source.excess -= chunksToMove;
                    target.deficit -= chunksToMove;
                }
                
                if (moves.length >= maxChunkMoves) break;
            }
            
            if (moves.length >= maxChunkMoves) break;
        }
        
        if (dryRun) {
            return {
                dryRun: true,
                plannedMoves: moves,
                estimatedTime: moves.length * 30 // Assume 30 seconds per chunk
            };
        }
        
        // Execute moves
        for (const move of moves) {
            await sh.moveChunk(namespace, move.from, move.to);
        }
        
        return {
            success: true,
            movesMade: moves.length
        };
    }

    // Handle jumbo chunks
    static async splitJumboChunks(db, namespace) {
        const configDB = db.getSiblingDB("config");
        
        // Find jumbo chunks
        const jumboChunks = await configDB.chunks.find({
            ns: namespace,
            jumbo: true
        }).toArray();
        
        const results = [];
        
        for (const chunk of jumboChunks) {
            try {
                // Attempt to split the chunk
                const midpoint = this.calculateChunkMidpoint(chunk.min, chunk.max);
                
                await db.adminCommand({
                    split: namespace,
                    bounds: [chunk.min, chunk.max],
                    middle: midpoint
                });
                
                // Clear jumbo flag
                await configDB.chunks.updateOne(
                    { _id: chunk._id },
                    { $unset: { jumbo: "" } }
                );
                
                results.push({
                    chunk: chunk._id,
                    success: true
                });
            } catch (error) {
                results.push({
                    chunk: chunk._id,
                    success: false,
                    error: error.message
                });
            }
        }
        
        return results;
    }
}
```

## Conclusion

MongoDB sharding provides a robust solution for horizontal scaling of enterprise applications. Key considerations for successful implementation include:

- **Careful Shard Key Selection**: Choose shard keys that provide good cardinality and align with query patterns
- **Zone Sharding**: Implement geographic data distribution for compliance and performance
- **Performance Optimization**: Use connection pooling, batch operations, and query optimization
- **Migration Strategy**: Plan and execute zero-downtime migrations from replica sets
- **Monitoring**: Implement comprehensive monitoring for proactive issue detection

By following these strategies and best practices, organizations can build scalable, performant MongoDB deployments that meet enterprise requirements for availability, compliance, and performance.