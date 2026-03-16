---
title: "Node.js Memory Optimization in Containers: Production Performance Guide"
date: 2026-10-12T00:00:00-05:00
draft: false
tags: ["Node.js", "JavaScript", "Kubernetes", "Memory Management", "Performance", "V8", "Containers"]
categories: ["Performance Optimization", "Node.js", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Node.js memory optimization in containerized environments, including V8 heap tuning, memory leak detection, garbage collection strategies, and production monitoring for enterprise workloads."
more_link: "yes"
url: "/nodejs-memory-optimization-containers-production-guide/"
---

Master Node.js memory optimization for containerized applications in Kubernetes. Learn V8 engine tuning, memory leak detection and prevention, garbage collection optimization, and production-ready monitoring strategies for high-performance Node.js deployments.

<!--more-->

# Node.js Memory Optimization in Containers: Production Performance Guide

## Executive Summary

Node.js applications in containerized environments face unique memory management challenges. The V8 JavaScript engine's default heap size limits, combined with container memory constraints, can lead to out-of-memory errors, performance degradation, and application crashes. This comprehensive guide covers production-proven techniques for optimizing Node.js memory usage in Kubernetes, including V8 heap tuning, memory leak detection, garbage collection optimization, and enterprise-grade monitoring strategies.

## Understanding Node.js Memory Architecture

### V8 Memory Model

#### Memory Components
```javascript
// Node.js memory breakdown
const v8 = require('v8');
const process = require('process');

function displayMemoryUsage() {
    const heapStats = v8.getHeapStatistics();
    const memUsage = process.memoryUsage();

    console.log('=== V8 Heap Statistics ===');
    console.log(`Total Heap Size: ${(heapStats.total_heap_size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Used Heap Size: ${(heapStats.used_heap_size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Heap Size Limit: ${(heapStats.heap_size_limit / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Available Size: ${(heapStats.total_available_size / 1024 / 1024).toFixed(2)} MB`);

    console.log('\n=== Process Memory Usage ===');
    console.log(`RSS (Resident Set Size): ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Heap Used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Heap Total: ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`External: ${(memUsage.external / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Array Buffers: ${(memUsage.arrayBuffers / 1024 / 1024).toFixed(2)} MB`);
}

// Monitor memory usage
setInterval(displayMemoryUsage, 60000); // Every minute
```

#### Memory Allocation Model
```yaml
# Node.js Container Memory Breakdown (4GB container)
Total Container Memory: 4096 MB
├── V8 Heap (New + Old Space): 2048 MB (--max-old-space-size)
│   ├── New Space (Young Generation): 64 MB (--max-semi-space-size)
│   └── Old Space: 1984 MB
├── Code Space: 512 MB (compiled JavaScript)
├── Map Space: 128 MB (hidden classes, maps)
├── Large Object Space: 256 MB (objects > 512KB)
├── External Memory: 512 MB (Buffers, native objects)
├── C++ Objects: 256 MB (Node.js core, addons)
└── OS Overhead: 384 MB (process metadata, stacks)
```

### Default Memory Limits

#### V8 Default Heap Sizes
```bash
# Default heap limits by system architecture
# 32-bit: ~512 MB
# 64-bit: ~1.4 GB (Node.js < 16)
# 64-bit: ~2 GB (Node.js 16+)

# Check current limits
node -e "console.log(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024 + ' MB')"
```

## Production Memory Configuration

### Container-Optimized Node.js Configuration

#### Dockerfile with Memory Tuning
```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

COPY . .

# Build if needed (TypeScript, etc.)
RUN npm run build

FROM node:20-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy application
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

USER nodejs

# Environment variables for memory tuning
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=3072 --max-semi-space-size=64"

EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/server.js"]
```

### Kubernetes Deployment Configuration

#### Production-Ready Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nodejs-application
  namespace: production
  labels:
    app: nodejs-application
    version: v1.0.0
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nodejs-application
  template:
    metadata:
      labels:
        app: nodejs-application
        version: v1.0.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: application
        image: company/nodejs-application:1.0.0
        env:
        # Memory Configuration
        - name: NODE_ENV
          value: "production"
        - name: NODE_OPTIONS
          value: "--max-old-space-size=3072 --max-semi-space-size=64 --expose-gc"

        # V8 Optimization Flags
        - name: UV_THREADPOOL_SIZE
          value: "8"  # Default is 4, increase for I/O heavy apps

        # Application Configuration
        - name: PORT
          value: "3000"
        - name: METRICS_PORT
          value: "9090"

        ports:
        - containerPort: 3000
          name: http
          protocol: TCP
        - containerPort: 9090
          name: metrics
          protocol: TCP

        resources:
          requests:
            memory: "4Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "2000m"

        livenessProbe:
          httpGet:
            path: /health/live
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3

        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3

        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 15"]

      terminationGracePeriodSeconds: 30

      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - nodejs-application
              topologyKey: kubernetes.io/hostname
```

## Memory Leak Detection and Prevention

### Heap Snapshot Analysis

#### Automated Heap Snapshot Capture
```javascript
// memory-profiler.js
const v8 = require('v8');
const fs = require('fs');
const path = require('path');

class MemoryProfiler {
    constructor(options = {}) {
        this.threshold = options.threshold || 0.85; // 85% memory usage
        this.snapshotDir = options.snapshotDir || '/var/log/heapdumps';
        this.checkInterval = options.checkInterval || 30000; // 30 seconds
        this.maxSnapshots = options.maxSnapshots || 5;

        this.ensureSnapshotDir();
        this.startMonitoring();
    }

    ensureSnapshotDir() {
        if (!fs.existsSync(this.snapshotDir)) {
            fs.mkdirSync(this.snapshotDir, { recursive: true });
        }
    }

    getMemoryUsagePercent() {
        const heapStats = v8.getHeapStatistics();
        return heapStats.used_heap_size / heapStats.heap_size_limit;
    }

    takeHeapSnapshot() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `heap-${timestamp}.heapsnapshot`;
        const filepath = path.join(this.snapshotDir, filename);

        console.log(`[MemoryProfiler] Taking heap snapshot: ${filename}`);

        const writeStream = fs.createWriteStream(filepath);
        const snapshotStream = v8.writeHeapSnapshot();

        fs.createReadStream(snapshotStream).pipe(writeStream);

        writeStream.on('finish', () => {
            console.log(`[MemoryProfiler] Heap snapshot saved: ${filepath}`);
            this.cleanupOldSnapshots();
        });

        return filepath;
    }

    cleanupOldSnapshots() {
        const files = fs.readdirSync(this.snapshotDir)
            .filter(f => f.endsWith('.heapsnapshot'))
            .map(f => ({
                name: f,
                path: path.join(this.snapshotDir, f),
                time: fs.statSync(path.join(this.snapshotDir, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        // Keep only the most recent snapshots
        const toDelete = files.slice(this.maxSnapshots);
        toDelete.forEach(file => {
            fs.unlinkSync(file.path);
            console.log(`[MemoryProfiler] Deleted old snapshot: ${file.name}`);
        });
    }

    checkMemoryUsage() {
        const usage = this.getMemoryUsagePercent();
        const memUsage = process.memoryUsage();

        console.log(`[MemoryProfiler] Memory usage: ${(usage * 100).toFixed(2)}%`);
        console.log(`  Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
        console.log(`  RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);

        if (usage >= this.threshold) {
            console.warn(`[MemoryProfiler] Memory threshold exceeded: ${(usage * 100).toFixed(2)}%`);
            this.takeHeapSnapshot();

            // Force garbage collection if enabled
            if (global.gc) {
                console.log('[MemoryProfiler] Forcing garbage collection');
                global.gc();
            }
        }
    }

    startMonitoring() {
        console.log(`[MemoryProfiler] Started monitoring with ${(this.threshold * 100)}% threshold`);
        setInterval(() => this.checkMemoryUsage(), this.checkInterval);
    }
}

module.exports = MemoryProfiler;

// Usage
if (require.main === module) {
    const profiler = new MemoryProfiler({
        threshold: 0.85,
        checkInterval: 30000,
        maxSnapshots: 5
    });
}
```

### Memory Leak Detection Patterns

#### Common Memory Leak Patterns and Solutions
```javascript
// memory-leak-patterns.js

// PROBLEM: Global variables accumulating data
class LeakyCache {
    constructor() {
        this.cache = {}; // Never cleared!
    }

    set(key, value) {
        this.cache[key] = value;
    }

    get(key) {
        return this.cache[key];
    }
}

// SOLUTION: Bounded cache with TTL
class BoundedCache {
    constructor(maxSize = 1000, ttl = 3600000) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttl = ttl;
    }

    set(key, value) {
        // Evict oldest if at capacity
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;

        // Check TTL
        if (Date.now() - entry.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        return entry.value;
    }

    clear() {
        this.cache.clear();
    }
}

// PROBLEM: Event listeners not removed
class LeakyEventHandler {
    constructor(eventEmitter) {
        this.handler = (data) => this.process(data);
        eventEmitter.on('data', this.handler); // Never removed!
    }

    process(data) {
        console.log(data);
    }
}

// SOLUTION: Proper cleanup
class ProperEventHandler {
    constructor(eventEmitter) {
        this.eventEmitter = eventEmitter;
        this.handler = (data) => this.process(data);
        this.eventEmitter.on('data', this.handler);
    }

    process(data) {
        console.log(data);
    }

    cleanup() {
        this.eventEmitter.removeListener('data', this.handler);
    }
}

// PROBLEM: Closures capturing large objects
class LeakyClosure {
    processLargeData(largeObject) {
        return setInterval(() => {
            console.log(largeObject.id); // Entire object kept in memory!
        }, 1000);
    }
}

// SOLUTION: Capture only what you need
class OptimizedClosure {
    processLargeData(largeObject) {
        const id = largeObject.id; // Copy only needed data
        return setInterval(() => {
            console.log(id);
        }, 1000);
    }
}

// PROBLEM: Promises not resolved
class LeakyPromise {
    async fetchData() {
        return new Promise((resolve, reject) => {
            // If this never resolves, the promise and its context stay in memory
            setTimeout(() => {
                // Oops, forgot to resolve or reject!
            }, 1000);
        });
    }
}

// SOLUTION: Always resolve/reject with timeout
class SafePromise {
    async fetchData(timeout = 5000) {
        return Promise.race([
            new Promise((resolve, reject) => {
                setTimeout(() => {
                    resolve('data');
                }, 1000);
            }),
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error('Timeout'));
                }, timeout);
            })
        ]);
    }
}

module.exports = {
    BoundedCache,
    ProperEventHandler,
    OptimizedClosure,
    SafePromise
};
```

### Production Memory Monitoring

#### Comprehensive Monitoring Service
```javascript
// monitoring.js
const promClient = require('prom-client');
const express = require('express');
const v8 = require('v8');

class MemoryMonitoringService {
    constructor(port = 9090) {
        this.port = port;
        this.register = new promClient.Registry();

        // Enable default metrics
        promClient.collectDefaultMetrics({
            register: this.register,
            prefix: 'nodejs_'
        });

        this.setupCustomMetrics();
        this.setupServer();
        this.startMonitoring();
    }

    setupCustomMetrics() {
        // Heap usage metrics
        this.heapUsedGauge = new promClient.Gauge({
            name: 'nodejs_heap_used_bytes',
            help: 'V8 heap used size in bytes',
            registers: [this.register]
        });

        this.heapTotalGauge = new promClient.Gauge({
            name: 'nodejs_heap_total_bytes',
            help: 'V8 heap total size in bytes',
            registers: [this.register]
        });

        this.heapLimitGauge = new promClient.Gauge({
            name: 'nodejs_heap_limit_bytes',
            help: 'V8 heap size limit in bytes',
            registers: [this.register]
        });

        // Memory usage metrics
        this.rssGauge = new promClient.Gauge({
            name: 'nodejs_rss_bytes',
            help: 'Resident set size in bytes',
            registers: [this.register]
        });

        this.externalGauge = new promClient.Gauge({
            name: 'nodejs_external_bytes',
            help: 'External memory usage in bytes',
            registers: [this.register]
        });

        // Garbage collection metrics
        this.gcDurationHistogram = new promClient.Histogram({
            name: 'nodejs_gc_duration_seconds',
            help: 'Garbage collection duration in seconds',
            labelNames: ['kind'],
            buckets: [0.001, 0.01, 0.1, 1, 2, 5],
            registers: [this.register]
        });

        this.gcCounter = new promClient.Counter({
            name: 'nodejs_gc_count_total',
            help: 'Total garbage collection count',
            labelNames: ['kind'],
            registers: [this.register]
        });

        // Event loop lag
        this.eventLoopLagGauge = new promClient.Gauge({
            name: 'nodejs_eventloop_lag_seconds',
            help: 'Event loop lag in seconds',
            registers: [this.register]
        });

        // Active handles and requests
        this.activeHandlesGauge = new promClient.Gauge({
            name: 'nodejs_active_handles',
            help: 'Number of active handles',
            registers: [this.register]
        });

        this.activeRequestsGauge = new promClient.Gauge({
            name: 'nodejs_active_requests',
            help: 'Number of active requests',
            registers: [this.register]
        });
    }

    setupServer() {
        const app = express();

        app.get('/metrics', async (req, res) => {
            res.set('Content-Type', this.register.contentType);
            res.end(await this.register.metrics());
        });

        app.get('/health/live', (req, res) => {
            res.json({ status: 'ok' });
        });

        app.get('/health/ready', (req, res) => {
            const memUsage = process.memoryUsage();
            const heapStats = v8.getHeapStatistics();
            const heapUsedPercent = heapStats.used_heap_size / heapStats.heap_size_limit;

            if (heapUsedPercent > 0.95) {
                return res.status(503).json({
                    status: 'not ready',
                    reason: 'high memory usage'
                });
            }

            res.json({ status: 'ready' });
        });

        this.server = app.listen(this.port, () => {
            console.log(`[Monitoring] Metrics server listening on port ${this.port}`);
        });
    }

    updateMetrics() {
        // Update heap metrics
        const heapStats = v8.getHeapStatistics();
        this.heapUsedGauge.set(heapStats.used_heap_size);
        this.heapTotalGauge.set(heapStats.total_heap_size);
        this.heapLimitGauge.set(heapStats.heap_size_limit);

        // Update memory usage metrics
        const memUsage = process.memoryUsage();
        this.rssGauge.set(memUsage.rss);
        this.externalGauge.set(memUsage.external);

        // Update active handles/requests
        const handles = process._getActiveHandles().length;
        const requests = process._getActiveRequests().length;
        this.activeHandlesGauge.set(handles);
        this.activeRequestsGauge.set(requests);
    }

    measureEventLoopLag() {
        const start = Date.now();
        setImmediate(() => {
            const lag = (Date.now() - start) / 1000;
            this.eventLoopLagGauge.set(lag);
        });
    }

    monitorGarbageCollection() {
        const gcTypes = {
            1: 'Scavenge',
            2: 'MarkSweepCompact',
            4: 'IncrementalMarking',
            8: 'ProcessWeakCallbacks',
            15: 'All'
        };

        const obs = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            entries.forEach((entry) => {
                const kind = gcTypes[entry.detail.kind] || 'Unknown';
                this.gcDurationHistogram.observe({ kind }, entry.duration / 1000);
                this.gcCounter.inc({ kind });
            });
        });

        obs.observe({ entryTypes: ['gc'] });
    }

    startMonitoring() {
        // Update metrics every 5 seconds
        setInterval(() => this.updateMetrics(), 5000);

        // Measure event loop lag every second
        setInterval(() => this.measureEventLoopLag(), 1000);

        // Monitor garbage collection
        this.monitorGarbageCollection();

        console.log('[Monitoring] Started monitoring services');
    }

    close() {
        if (this.server) {
            this.server.close();
        }
    }
}

module.exports = MemoryMonitoringService;

// Usage
if (require.main === module) {
    const monitoring = new MemoryMonitoringService(9090);
}
```

## Garbage Collection Optimization

### Understanding V8 Garbage Collection

#### GC Monitoring Script
```javascript
// gc-monitor.js
const v8 = require('v8');
const { PerformanceObserver } = require('perf_hooks');

class GCMonitor {
    constructor() {
        this.gcStats = {
            scavenge: { count: 0, totalDuration: 0, maxDuration: 0 },
            markSweepCompact: { count: 0, totalDuration: 0, maxDuration: 0 },
            incrementalMarking: { count: 0, totalDuration: 0, maxDuration: 0 },
            processWeakCallbacks: { count: 0, totalDuration: 0, maxDuration: 0 }
        };

        this.setupObserver();
    }

    setupObserver() {
        const gcTypes = {
            1: 'scavenge',
            2: 'markSweepCompact',
            4: 'incrementalMarking',
            8: 'processWeakCallbacks'
        };

        const obs = new PerformanceObserver((list) => {
            const entries = list.getEntries();

            entries.forEach((entry) => {
                const kind = gcTypes[entry.detail.kind];
                if (kind && this.gcStats[kind]) {
                    const stats = this.gcStats[kind];
                    stats.count++;
                    stats.totalDuration += entry.duration;
                    stats.maxDuration = Math.max(stats.maxDuration, entry.duration);

                    console.log(`[GC] ${kind}: ${entry.duration.toFixed(2)}ms (${entry.detail.flags})`);
                }
            });
        });

        obs.observe({ entryTypes: ['gc'], buffered: true });
    }

    getStatistics() {
        const stats = {};

        for (const [type, data] of Object.entries(this.gcStats)) {
            if (data.count > 0) {
                stats[type] = {
                    count: data.count,
                    avgDuration: (data.totalDuration / data.count).toFixed(2) + 'ms',
                    maxDuration: data.maxDuration.toFixed(2) + 'ms',
                    totalDuration: data.totalDuration.toFixed(2) + 'ms'
                };
            }
        }

        return stats;
    }

    printStatistics() {
        console.log('\n=== Garbage Collection Statistics ===');
        const stats = this.getStatistics();

        for (const [type, data] of Object.entries(stats)) {
            console.log(`\n${type}:`);
            console.log(`  Count: ${data.count}`);
            console.log(`  Average Duration: ${data.avgDuration}`);
            console.log(`  Max Duration: ${data.maxDuration}`);
            console.log(`  Total Duration: ${data.totalDuration}`);
        }
    }
}

module.exports = GCMonitor;

// Usage
if (require.main === module) {
    const monitor = new GCMonitor();

    // Print statistics every minute
    setInterval(() => monitor.printStatistics(), 60000);
}
```

### GC Tuning Flags

#### Node.js GC Configuration
```bash
#!/bin/bash
# gc-tuning.sh - Different GC configurations for different workloads

# High Throughput Configuration
# For batch processing, data transformation pipelines
NODE_OPTIONS="--max-old-space-size=4096 \
  --max-semi-space-size=128 \
  --initial-old-space-size=2048"

# Low Latency Configuration
# For real-time APIs, WebSocket servers
NODE_OPTIONS="--max-old-space-size=2048 \
  --max-semi-space-size=32 \
  --expose-gc \
  --gc-interval=100"

# Memory Constrained Configuration
# For containerized environments with limited memory
NODE_OPTIONS="--max-old-space-size=1024 \
  --max-semi-space-size=16 \
  --optimize-for-size"

# Debug Configuration
# For development and troubleshooting
NODE_OPTIONS="--max-old-space-size=2048 \
  --expose-gc \
  --trace-gc \
  --trace-gc-verbose"
```

## Stream Processing and Memory Efficiency

### Efficient Stream Processing

#### Memory-Efficient File Processing
```javascript
// efficient-stream-processing.js
const fs = require('fs');
const { pipeline, Transform } = require('stream');
const { promisify } = require('util');
const zlib = require('zlib');

const pipelineAsync = promisify(pipeline);

// BAD: Loading entire file into memory
async function inefficientFileProcessing(inputFile, outputFile) {
    const data = await fs.promises.readFile(inputFile, 'utf8');
    const processed = data
        .split('\n')
        .map(line => line.toUpperCase())
        .join('\n');
    await fs.promises.writeFile(outputFile, processed);
}

// GOOD: Stream-based processing
async function efficientFileProcessing(inputFile, outputFile) {
    const transformStream = new Transform({
        transform(chunk, encoding, callback) {
            const processed = chunk.toString().toUpperCase();
            callback(null, processed);
        }
    });

    await pipelineAsync(
        fs.createReadStream(inputFile),
        transformStream,
        zlib.createGzip(),
        fs.createWriteStream(outputFile)
    );
}

// Advanced streaming with backpressure handling
class ChunkedProcessor extends Transform {
    constructor(processFunc, options = {}) {
        super({
            ...options,
            highWaterMark: options.highWaterMark || 16 * 1024 // 16KB
        });
        this.processFunc = processFunc;
        this.buffer = '';
    }

    _transform(chunk, encoding, callback) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');

        // Keep last incomplete line in buffer
        this.buffer = lines.pop();

        try {
            const processed = lines
                .map(this.processFunc)
                .join('\n') + '\n';

            callback(null, processed);
        } catch (error) {
            callback(error);
        }
    }

    _flush(callback) {
        if (this.buffer) {
            try {
                const processed = this.processFunc(this.buffer);
                callback(null, processed);
            } catch (error) {
                callback(error);
            }
        } else {
            callback();
        }
    }
}

// Usage
async function processLargeFile() {
    const processor = new ChunkedProcessor(
        line => line.trim().toUpperCase(),
        { highWaterMark: 64 * 1024 }
    );

    await pipelineAsync(
        fs.createReadStream('large-input.txt'),
        processor,
        zlib.createGzip(),
        fs.createWriteStream('output.txt.gz')
    );
}

module.exports = {
    efficientFileProcessing,
    ChunkedProcessor,
    processLargeFile
};
```

## Production Configuration Examples

### Complete Enterprise Setup

#### Production-Ready Application
```javascript
// server.js
const express = require('express');
const MemoryMonitoringService = require('./monitoring');
const MemoryProfiler = require('./memory-profiler');
const GCMonitor = require('./gc-monitor');

class ProductionServer {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;

        // Initialize monitoring
        this.monitoring = new MemoryMonitoringService(9090);
        this.profiler = new MemoryProfiler({
            threshold: 0.85,
            checkInterval: 30000,
            maxSnapshots: 5
        });
        this.gcMonitor = new GCMonitor();

        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
        this.setupGracefulShutdown();
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '1mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

        // Request size limiting
        this.app.use((req, res, next) => {
            const contentLength = req.get('content-length');
            if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
                return res.status(413).json({ error: 'Payload too large' });
            }
            next();
        });

        // Memory usage middleware
        this.app.use((req, res, next) => {
            const memUsage = process.memoryUsage();
            const heapUsedPercent = memUsage.heapUsed / memUsage.heapTotal;

            if (heapUsedPercent > 0.9) {
                return res.status(503).json({
                    error: 'Service temporarily unavailable',
                    reason: 'High memory usage'
                });
            }

            next();
        });
    }

    setupRoutes() {
        this.app.get('/health/live', (req, res) => {
            res.json({ status: 'ok' });
        });

        this.app.get('/health/ready', (req, res) => {
            const memUsage = process.memoryUsage();
            const heapUsedPercent = memUsage.heapUsed / memUsage.heapTotal;

            if (heapUsedPercent > 0.95) {
                return res.status(503).json({
                    status: 'not ready',
                    reason: 'high memory usage',
                    memoryUsage: {
                        heapUsedPercent: (heapUsedPercent * 100).toFixed(2) + '%',
                        heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
                        heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(2) + ' MB'
                    }
                });
            }

            res.json({ status: 'ready' });
        });

        this.app.get('/api/stats', (req, res) => {
            const memUsage = process.memoryUsage();
            const v8Stats = require('v8').getHeapStatistics();
            const gcStats = this.gcMonitor.getStatistics();

            res.json({
                memory: {
                    rss: (memUsage.rss / 1024 / 1024).toFixed(2) + ' MB',
                    heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
                    heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
                    external: (memUsage.external / 1024 / 1024).toFixed(2) + ' MB'
                },
                v8: {
                    heapSizeLimit: (v8Stats.heap_size_limit / 1024 / 1024).toFixed(2) + ' MB',
                    totalAvailable: (v8Stats.total_available_size / 1024 / 1024).toFixed(2) + ' MB'
                },
                gc: gcStats,
                uptime: process.uptime(),
                pid: process.pid
            });
        });

        // Force GC endpoint (for testing only)
        if (global.gc) {
            this.app.post('/api/gc', (req, res) => {
                const before = process.memoryUsage();
                global.gc();
                const after = process.memoryUsage();

                res.json({
                    freed: {
                        heapUsed: ((before.heapUsed - after.heapUsed) / 1024 / 1024).toFixed(2) + ' MB',
                        external: ((before.external - after.external) / 1024 / 1024).toFixed(2) + ' MB'
                    }
                });
            });
        }
    }

    setupErrorHandling() {
        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({ error: 'Not found' });
        });

        // Error handler
        this.app.use((err, req, res, next) => {
            console.error('[Error]', err);
            res.status(500).json({ error: 'Internal server error' });
        });

        // Uncaught exception handler
        process.on('uncaughtException', (err) => {
            console.error('[Uncaught Exception]', err);
            this.shutdown(1);
        });

        // Unhandled rejection handler
        process.on('unhandledRejection', (reason, promise) => {
            console.error('[Unhandled Rejection]', reason);
        });
    }

    setupGracefulShutdown() {
        const signals = ['SIGTERM', 'SIGINT'];

        signals.forEach(signal => {
            process.on(signal, () => {
                console.log(`[Server] Received ${signal}, starting graceful shutdown`);
                this.shutdown(0);
            });
        });
    }

    async shutdown(exitCode) {
        console.log('[Server] Closing HTTP server');

        if (this.server) {
            this.server.close(() => {
                console.log('[Server] HTTP server closed');

                // Close monitoring services
                if (this.monitoring) {
                    this.monitoring.close();
                }

                // Print final GC statistics
                console.log('\n=== Final Statistics ===');
                this.gcMonitor.printStatistics();

                process.exit(exitCode);
            });

            // Force close after 30 seconds
            setTimeout(() => {
                console.error('[Server] Forcing shutdown after timeout');
                process.exit(1);
            }, 30000);
        } else {
            process.exit(exitCode);
        }
    }

    start() {
        this.server = this.app.listen(this.port, () => {
            console.log(`[Server] Listening on port ${this.port}`);
            console.log(`[Server] PID: ${process.pid}`);
            console.log(`[Server] Node version: ${process.version}`);

            const memUsage = process.memoryUsage();
            console.log(`[Server] Initial memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
        });
    }
}

// Start server
if (require.main === module) {
    const server = new ProductionServer();
    server.start();
}

module.exports = ProductionServer;
```

### Kubernetes ConfigMap for Node Options

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nodejs-config
  namespace: production
data:
  # Standard configuration
  NODE_OPTIONS_STANDARD: |
    --max-old-space-size=3072
    --max-semi-space-size=64
    --expose-gc

  # High throughput configuration
  NODE_OPTIONS_THROUGHPUT: |
    --max-old-space-size=4096
    --max-semi-space-size=128
    --initial-old-space-size=2048
    --optimize-for-size=false

  # Low latency configuration
  NODE_OPTIONS_LATENCY: |
    --max-old-space-size=2048
    --max-semi-space-size=32
    --expose-gc
    --gc-interval=100

  # Debug configuration
  NODE_OPTIONS_DEBUG: |
    --max-old-space-size=2048
    --expose-gc
    --trace-gc
    --trace-gc-verbose
    --trace-gc-nvp
```

## Conclusion

Optimizing Node.js memory usage in containerized environments requires understanding V8's memory model, implementing proper monitoring, and following best practices for memory management. Key takeaways:

1. **Configure Heap Size Appropriately**: Set `--max-old-space-size` to 75-80% of container memory limit
2. **Monitor Continuously**: Implement comprehensive monitoring with Prometheus metrics
3. **Detect Leaks Early**: Use heap snapshots and automated profiling to catch memory leaks
4. **Use Streams**: Process large datasets with streams to avoid loading everything into memory
5. **Handle GC Properly**: Understand and tune garbage collection for your workload

Proper memory optimization can reduce container costs by 30-40% while improving application performance and stability. Regular monitoring and proactive leak detection ensure long-term production reliability.