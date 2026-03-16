---
title: "Python Async Performance Patterns: Production Optimization Guide"
date: 2026-10-30T00:00:00-05:00
draft: false
tags: ["Python", "AsyncIO", "Performance", "Concurrency", "Event Loop", "FastAPI", "Production"]
categories: ["Performance Optimization", "Python", "Asynchronous Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Python async performance optimization, including event loop tuning, concurrency patterns, FastAPI optimization, and production-ready async patterns for high-performance applications."
more_link: "yes"
url: "/python-async-performance-patterns-production-guide/"
---

Master Python async performance optimization for production environments. Learn event loop tuning, concurrency patterns, memory management, FastAPI optimization techniques, and enterprise-grade async patterns for building high-performance asynchronous applications.

<!--more-->

# Python Async Performance Patterns: Production Optimization Guide

## Executive Summary

Asynchronous Python has become the standard for building high-performance I/O-bound applications, but improper implementation can lead to performance degradation, memory leaks, and scalability issues. This comprehensive guide covers production-proven async patterns, event loop optimization, concurrency management, and FastAPI tuning techniques that enable building enterprise-grade asynchronous applications capable of handling thousands of concurrent connections efficiently.

## Understanding Python AsyncIO Architecture

### Event Loop Fundamentals

#### Event Loop Performance Comparison
```python
# event_loop_comparison.py
import asyncio
import time
import uvloop
from typing import Callable

class EventLoopBenchmark:
    """Compare different event loop implementations"""

    def __init__(self, num_tasks: int = 10000):
        self.num_tasks = num_tasks

    async def dummy_task(self):
        """Simple async task for benchmarking"""
        await asyncio.sleep(0.001)

    async def benchmark_loop(self, name: str, setup_func: Callable = None):
        """Benchmark a specific event loop configuration"""
        if setup_func:
            setup_func()

        tasks = [self.dummy_task() for _ in range(self.num_tasks)]

        start = time.perf_counter()
        await asyncio.gather(*tasks)
        duration = time.perf_counter() - start

        print(f"{name}: {duration:.4f}s ({self.num_tasks/duration:.0f} tasks/sec)")

    def run_benchmarks(self):
        """Run all event loop benchmarks"""
        print(f"Benchmarking {self.num_tasks} concurrent tasks\n")

        # Standard asyncio event loop
        asyncio.run(self.benchmark_loop("Standard asyncio"))

        # uvloop (fastest production event loop)
        def setup_uvloop():
            asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())

        asyncio.run(self.benchmark_loop("uvloop", setup_uvloop))

if __name__ == "__main__":
    benchmark = EventLoopBenchmark(num_tasks=10000)
    benchmark.run_benchmarks()
```

### AsyncIO Memory Model

#### Memory Profiling for Async Code
```python
# async_memory_profiler.py
import asyncio
import tracemalloc
from typing import List, Dict, Any
from dataclasses import dataclass
from datetime import datetime

@dataclass
class MemorySnapshot:
    """Memory usage snapshot"""
    timestamp: datetime
    current: int
    peak: int
    task_count: int

class AsyncMemoryProfiler:
    """Profile memory usage in async applications"""

    def __init__(self, interval: float = 5.0):
        self.interval = interval
        self.snapshots: List[MemorySnapshot] = []
        self._running = False

    async def start(self):
        """Start memory profiling"""
        tracemalloc.start()
        self._running = True

        print("[MemoryProfiler] Started profiling")

        while self._running:
            await asyncio.sleep(self.interval)
            self.take_snapshot()

    def take_snapshot(self):
        """Take a memory snapshot"""
        current, peak = tracemalloc.get_traced_memory()
        tasks = len(asyncio.all_tasks())

        snapshot = MemorySnapshot(
            timestamp=datetime.now(),
            current=current,
            peak=peak,
            task_count=tasks
        )

        self.snapshots.append(snapshot)

        print(f"[MemoryProfiler] "
              f"Current: {current / 1024 / 1024:.2f} MB, "
              f"Peak: {peak / 1024 / 1024:.2f} MB, "
              f"Tasks: {tasks}")

    def stop(self):
        """Stop profiling and display statistics"""
        self._running = False
        tracemalloc.stop()

        if not self.snapshots:
            return

        print("\n=== Memory Profile Summary ===")
        print(f"Total snapshots: {len(self.snapshots)}")

        avg_memory = sum(s.current for s in self.snapshots) / len(self.snapshots)
        max_memory = max(s.peak for s in self.snapshots)
        avg_tasks = sum(s.task_count for s in self.snapshots) / len(self.snapshots)

        print(f"Average memory: {avg_memory / 1024 / 1024:.2f} MB")
        print(f"Peak memory: {max_memory / 1024 / 1024:.2f} MB")
        print(f"Average tasks: {avg_tasks:.0f}")

    def get_top_allocations(self, limit: int = 10):
        """Get top memory allocations"""
        snapshot = tracemalloc.take_snapshot()
        top_stats = snapshot.statistics('lineno')

        print(f"\n=== Top {limit} Memory Allocations ===")
        for stat in top_stats[:limit]:
            print(f"{stat.size / 1024:.1f} KB: {stat}")

# Usage example
async def example_usage():
    profiler = AsyncMemoryProfiler(interval=5.0)

    # Start profiling in background
    profiler_task = asyncio.create_task(profiler.start())

    try:
        # Your async application code here
        await asyncio.sleep(30)
    finally:
        profiler.stop()
        profiler_task.cancel()
        try:
            await profiler_task
        except asyncio.CancelledError:
            pass

if __name__ == "__main__":
    asyncio.run(example_usage())
```

## Production Async Patterns

### Connection Pooling

#### High-Performance Database Connection Pool
```python
# async_db_pool.py
import asyncio
import asyncpg
from typing import Optional, Dict, Any
from contextlib import asynccontextmanager
from dataclasses import dataclass
import time

@dataclass
class PoolConfig:
    """Database pool configuration"""
    min_size: int = 10
    max_size: int = 100
    max_queries: int = 50000
    max_inactive_connection_lifetime: float = 300.0
    command_timeout: float = 60.0
    server_settings: Optional[Dict[str, str]] = None

class AsyncDatabasePool:
    """Production-ready async database connection pool"""

    def __init__(self, dsn: str, config: Optional[PoolConfig] = None):
        self.dsn = dsn
        self.config = config or PoolConfig()
        self.pool: Optional[asyncpg.Pool] = None
        self._stats = {
            'queries': 0,
            'errors': 0,
            'total_time': 0.0,
            'connections_created': 0,
            'connections_closed': 0
        }

    async def initialize(self):
        """Initialize the connection pool"""
        if self.pool is not None:
            return

        print(f"[DBPool] Initializing pool (min={self.config.min_size}, max={self.config.max_size})")

        self.pool = await asyncpg.create_pool(
            self.dsn,
            min_size=self.config.min_size,
            max_size=self.config.max_size,
            max_queries=self.config.max_queries,
            max_inactive_connection_lifetime=self.config.max_inactive_connection_lifetime,
            command_timeout=self.config.command_timeout,
            server_settings=self.config.server_settings or {},
            init=self._init_connection
        )

        print(f"[DBPool] Pool initialized successfully")

    async def _init_connection(self, conn):
        """Initialize each connection"""
        self._stats['connections_created'] += 1

        # Set connection parameters
        await conn.execute('SET TIME ZONE UTC')

        # Register custom types if needed
        # await conn.set_type_codec(...)

    async def close(self):
        """Close the connection pool"""
        if self.pool:
            print("[DBPool] Closing pool")
            await self.pool.close()
            self.pool = None
            print("[DBPool] Pool closed")

    @asynccontextmanager
    async def acquire(self):
        """Acquire a connection from the pool"""
        if self.pool is None:
            await self.initialize()

        async with self.pool.acquire() as conn:
            yield conn

    async def execute(self, query: str, *args, timeout: Optional[float] = None):
        """Execute a query"""
        start = time.perf_counter()

        try:
            async with self.acquire() as conn:
                result = await conn.execute(query, *args, timeout=timeout)

            self._stats['queries'] += 1
            self._stats['total_time'] += time.perf_counter() - start

            return result

        except Exception as e:
            self._stats['errors'] += 1
            raise

    async def fetch(self, query: str, *args, timeout: Optional[float] = None):
        """Fetch multiple rows"""
        start = time.perf_counter()

        try:
            async with self.acquire() as conn:
                rows = await conn.fetch(query, *args, timeout=timeout)

            self._stats['queries'] += 1
            self._stats['total_time'] += time.perf_counter() - start

            return rows

        except Exception as e:
            self._stats['errors'] += 1
            raise

    async def fetchrow(self, query: str, *args, timeout: Optional[float] = None):
        """Fetch a single row"""
        start = time.perf_counter()

        try:
            async with self.acquire() as conn:
                row = await conn.fetchrow(query, *args, timeout=timeout)

            self._stats['queries'] += 1
            self._stats['total_time'] += time.perf_counter() - start

            return row

        except Exception as e:
            self._stats['errors'] += 1
            raise

    async def fetchval(self, query: str, *args, column: int = 0, timeout: Optional[float] = None):
        """Fetch a single value"""
        start = time.perf_counter()

        try:
            async with self.acquire() as conn:
                value = await conn.fetchval(query, *args, column=column, timeout=timeout)

            self._stats['queries'] += 1
            self._stats['total_time'] += time.perf_counter() - start

            return value

        except Exception as e:
            self._stats['errors'] += 1
            raise

    def get_stats(self) -> Dict[str, Any]:
        """Get pool statistics"""
        stats = self._stats.copy()

        if self.pool:
            stats.update({
                'pool_size': self.pool.get_size(),
                'pool_free': self.pool.get_idle_size(),
                'pool_used': self.pool.get_size() - self.pool.get_idle_size()
            })

        if stats['queries'] > 0:
            stats['avg_query_time'] = stats['total_time'] / stats['queries']

        return stats

    async def health_check(self) -> bool:
        """Check if pool is healthy"""
        try:
            await self.fetchval('SELECT 1', timeout=5.0)
            return True
        except Exception:
            return False

# Usage example
async def example_usage():
    pool = AsyncDatabasePool(
        dsn="postgresql://user:pass@localhost/db",
        config=PoolConfig(min_size=10, max_size=100)
    )

    try:
        await pool.initialize()

        # Execute queries
        await pool.execute('INSERT INTO users (name) VALUES ($1)', 'John')

        # Fetch data
        users = await pool.fetch('SELECT * FROM users WHERE active = $1', True)

        # Get single value
        count = await pool.fetchval('SELECT COUNT(*) FROM users')

        # Print statistics
        print(pool.get_stats())

    finally:
        await pool.close()

if __name__ == "__main__":
    asyncio.run(example_usage())
```

### Concurrent Request Processing

#### Advanced Concurrency Control
```python
# async_concurrency.py
import asyncio
from typing import List, TypeVar, Callable, Awaitable, Optional
from asyncio import Semaphore, Queue
from dataclasses import dataclass
from enum import Enum
import time

T = TypeVar('T')

class ConcurrencyStrategy(Enum):
    """Concurrency control strategies"""
    GATHER = "gather"           # Process all at once
    SEMAPHORE = "semaphore"     # Limit concurrent tasks
    QUEUE = "queue"             # Process via worker queue
    BATCH = "batch"             # Process in batches

@dataclass
class ConcurrencyConfig:
    """Concurrency configuration"""
    strategy: ConcurrencyStrategy = ConcurrencyStrategy.SEMAPHORE
    max_concurrent: int = 100
    queue_size: int = 10000
    batch_size: int = 100
    timeout: Optional[float] = 30.0
    retry_attempts: int = 3
    retry_delay: float = 1.0

class AsyncConcurrencyManager:
    """Manage concurrent async operations"""

    def __init__(self, config: Optional[ConcurrencyConfig] = None):
        self.config = config or ConcurrencyConfig()
        self.semaphore = Semaphore(self.config.max_concurrent)
        self.queue: Optional[Queue] = None
        self.workers: List[asyncio.Task] = []

    async def process_with_gather(
        self,
        items: List[T],
        processor: Callable[[T], Awaitable[Any]]
    ) -> List[Any]:
        """Process all items concurrently with asyncio.gather"""
        tasks = [processor(item) for item in items]
        return await asyncio.gather(*tasks, return_exceptions=True)

    async def process_with_semaphore(
        self,
        items: List[T],
        processor: Callable[[T], Awaitable[Any]]
    ) -> List[Any]:
        """Process items with semaphore-limited concurrency"""
        async def limited_processor(item):
            async with self.semaphore:
                return await processor(item)

        tasks = [limited_processor(item) for item in items]
        return await asyncio.gather(*tasks, return_exceptions=True)

    async def process_with_queue(
        self,
        items: List[T],
        processor: Callable[[T], Awaitable[Any]],
        num_workers: Optional[int] = None
    ) -> List[Any]:
        """Process items using a worker queue"""
        num_workers = num_workers or self.config.max_concurrent
        self.queue = Queue(maxsize=self.config.queue_size)
        results = []

        async def worker():
            while True:
                try:
                    item, result_idx = await self.queue.get()
                    if item is None:  # Poison pill
                        break

                    try:
                        result = await processor(item)
                        results.append((result_idx, result))
                    except Exception as e:
                        results.append((result_idx, e))
                    finally:
                        self.queue.task_done()

                except asyncio.CancelledError:
                    break

        # Start workers
        self.workers = [
            asyncio.create_task(worker())
            for _ in range(num_workers)
        ]

        # Enqueue items
        for idx, item in enumerate(items):
            await self.queue.put((item, idx))

        # Wait for all items to be processed
        await self.queue.join()

        # Stop workers
        for _ in range(num_workers):
            await self.queue.put((None, None))

        await asyncio.gather(*self.workers)
        self.workers.clear()

        # Sort results by original index
        results.sort(key=lambda x: x[0])
        return [r[1] for r in results]

    async def process_in_batches(
        self,
        items: List[T],
        processor: Callable[[T], Awaitable[Any]],
        batch_size: Optional[int] = None
    ) -> List[Any]:
        """Process items in batches"""
        batch_size = batch_size or self.config.batch_size
        results = []

        for i in range(0, len(items), batch_size):
            batch = items[i:i + batch_size]
            batch_results = await self.process_with_semaphore(batch, processor)
            results.extend(batch_results)

            # Small delay between batches to prevent overwhelming the system
            if i + batch_size < len(items):
                await asyncio.sleep(0.1)

        return results

    async def process_with_retry(
        self,
        item: T,
        processor: Callable[[T], Awaitable[Any]]
    ) -> Any:
        """Process an item with retry logic"""
        for attempt in range(self.config.retry_attempts):
            try:
                if self.config.timeout:
                    return await asyncio.wait_for(
                        processor(item),
                        timeout=self.config.timeout
                    )
                else:
                    return await processor(item)

            except asyncio.TimeoutError:
                if attempt == self.config.retry_attempts - 1:
                    raise
                print(f"Timeout on attempt {attempt + 1}, retrying...")
                await asyncio.sleep(self.config.retry_delay * (attempt + 1))

            except Exception as e:
                if attempt == self.config.retry_attempts - 1:
                    raise
                print(f"Error on attempt {attempt + 1}: {e}, retrying...")
                await asyncio.sleep(self.config.retry_delay * (attempt + 1))

    async def process(
        self,
        items: List[T],
        processor: Callable[[T], Awaitable[Any]]
    ) -> List[Any]:
        """Process items using configured strategy"""
        start = time.perf_counter()

        if self.config.strategy == ConcurrencyStrategy.GATHER:
            results = await self.process_with_gather(items, processor)
        elif self.config.strategy == ConcurrencyStrategy.SEMAPHORE:
            results = await self.process_with_semaphore(items, processor)
        elif self.config.strategy == ConcurrencyStrategy.QUEUE:
            results = await self.process_with_queue(items, processor)
        elif self.config.strategy == ConcurrencyStrategy.BATCH:
            results = await self.process_in_batches(items, processor)
        else:
            raise ValueError(f"Unknown strategy: {self.config.strategy}")

        duration = time.perf_counter() - start
        print(f"Processed {len(items)} items in {duration:.2f}s "
              f"({len(items)/duration:.0f} items/sec)")

        return results

# Usage example
async def example_usage():
    import aiohttp

    async def fetch_url(url: str) -> str:
        """Fetch URL content"""
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                return await response.text()

    # URLs to fetch
    urls = [f"https://httpbin.org/delay/{i%3}" for i in range(100)]

    # Test different strategies
    strategies = [
        ConcurrencyStrategy.SEMAPHORE,
        ConcurrencyStrategy.QUEUE,
        ConcurrencyStrategy.BATCH
    ]

    for strategy in strategies:
        print(f"\n=== Testing {strategy.value} strategy ===")

        config = ConcurrencyConfig(
            strategy=strategy,
            max_concurrent=20,
            batch_size=10,
            timeout=10.0
        )

        manager = AsyncConcurrencyManager(config)
        results = await manager.process(urls, fetch_url)

        successful = sum(1 for r in results if not isinstance(r, Exception))
        failed = len(results) - successful

        print(f"Successful: {successful}, Failed: {failed}")

if __name__ == "__main__":
    asyncio.run(example_usage())
```

## FastAPI Performance Optimization

### Production FastAPI Configuration

#### High-Performance FastAPI Application
```python
# fastapi_optimized.py
from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.responses import JSONResponse, ORJSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZIPMiddleware
from contextlib import asynccontextmanager
import uvicorn
import uvloop
from typing import Optional, Dict, Any
import time
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
import asyncio

# Install uvloop for better performance
asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())

# Prometheus metrics
REQUEST_COUNT = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']
)

REQUEST_DURATION = Histogram(
    'http_request_duration_seconds',
    'HTTP request duration',
    ['method', 'endpoint']
)

ACTIVE_REQUESTS = Gauge(
    'http_requests_active',
    'Active HTTP requests'
)

# Application state
class AppState:
    """Application state management"""

    def __init__(self):
        self.db_pool = None
        self.redis_pool = None
        self.http_session = None
        self.start_time = time.time()

app_state = AppState()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle"""
    print("[FastAPI] Starting up...")

    # Initialize resources
    from async_db_pool import AsyncDatabasePool, PoolConfig

    app_state.db_pool = AsyncDatabasePool(
        dsn="postgresql://user:pass@localhost/db",
        config=PoolConfig(min_size=10, max_size=100)
    )
    await app_state.db_pool.initialize()

    # Initialize HTTP session
    import aiohttp
    app_state.http_session = aiohttp.ClientSession()

    print("[FastAPI] Startup complete")

    yield

    # Cleanup
    print("[FastAPI] Shutting down...")

    if app_state.db_pool:
        await app_state.db_pool.close()

    if app_state.http_session:
        await app_state.http_session.close()

    print("[FastAPI] Shutdown complete")

# Create FastAPI app with optimizations
app = FastAPI(
    title="Optimized FastAPI Application",
    version="1.0.0",
    lifespan=lifespan,
    default_response_class=ORJSONResponse,  # Faster JSON serialization
    docs_url="/api/docs",
    redoc_url="/api/redoc"
)

# Add middleware
app.add_middleware(GZIPMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

# Performance monitoring middleware
@app.middleware("http")
async def monitor_requests(request: Request, call_next):
    """Monitor request performance"""
    ACTIVE_REQUESTS.inc()
    start = time.perf_counter()

    try:
        response = await call_next(request)

        # Record metrics
        duration = time.perf_counter() - start
        REQUEST_DURATION.labels(
            method=request.method,
            endpoint=request.url.path
        ).observe(duration)

        REQUEST_COUNT.labels(
            method=request.method,
            endpoint=request.url.path,
            status=response.status_code
        ).inc()

        # Add performance headers
        response.headers["X-Process-Time"] = f"{duration:.4f}"

        return response

    finally:
        ACTIVE_REQUESTS.dec()

# Request size limiting middleware
@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    """Limit request body size"""
    max_size = 10 * 1024 * 1024  # 10MB

    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > max_size:
        return JSONResponse(
            status_code=413,
            content={"error": "Request body too large"}
        )

    return await call_next(request)

# Health check endpoints
@app.get("/health/live")
async def liveness():
    """Liveness probe"""
    return {"status": "ok"}

@app.get("/health/ready")
async def readiness():
    """Readiness probe"""
    # Check database health
    if app_state.db_pool:
        db_healthy = await app_state.db_pool.health_check()
        if not db_healthy:
            raise HTTPException(status_code=503, detail="Database unhealthy")

    return {"status": "ready"}

# Metrics endpoint
@app.get("/metrics")
async def metrics():
    """Prometheus metrics"""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )

# Stats endpoint
@app.get("/api/stats")
async def stats():
    """Application statistics"""
    uptime = time.time() - app_state.start_time

    stats = {
        "uptime_seconds": uptime,
        "active_requests": ACTIVE_REQUESTS._value.get()
    }

    if app_state.db_pool:
        stats["database"] = app_state.db_pool.get_stats()

    return stats

# Example API endpoints
@app.get("/api/users/{user_id}")
async def get_user(user_id: int):
    """Get user by ID"""
    if not app_state.db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    user = await app_state.db_pool.fetchrow(
        "SELECT * FROM users WHERE id = $1",
        user_id
    )

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return dict(user)

@app.get("/api/users")
async def list_users(
    limit: int = 100,
    offset: int = 0
):
    """List users with pagination"""
    if not app_state.db_pool:
        raise HTTPException(status_code=503, detail="Database not available")

    # Limit maximum page size
    limit = min(limit, 1000)

    users = await app_state.db_pool.fetch(
        "SELECT * FROM users ORDER BY id LIMIT $1 OFFSET $2",
        limit,
        offset
    )

    return [dict(user) for user in users]

# Efficient streaming endpoint
from fastapi.responses import StreamingResponse

@app.get("/api/stream")
async def stream_data():
    """Stream data efficiently"""
    async def generate():
        for i in range(1000):
            yield f"data: {i}\n\n"
            await asyncio.sleep(0.01)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream"
    )

# Run server with optimal configuration
def run_server():
    """Run FastAPI server with uvicorn"""
    uvicorn.run(
        "fastapi_optimized:app",
        host="0.0.0.0",
        port=8000,
        loop="uvloop",  # Use uvloop for better performance
        http="httptools",  # Use httptools for better HTTP parsing
        workers=4,  # Number of worker processes
        log_level="info",
        access_log=True,
        use_colors=True,
        limit_concurrency=1000,  # Max concurrent connections
        limit_max_requests=100000,  # Restart worker after N requests
        timeout_keep_alive=5,  # Keep-alive timeout
        backlog=2048  # Socket backlog
    )

if __name__ == "__main__":
    run_server()
```

### FastAPI Kubernetes Deployment

```yaml
# fastapi-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fastapi-app
  namespace: production
  labels:
    app: fastapi-app
    version: v1.0.0
spec:
  replicas: 3
  selector:
    matchLabels:
      app: fastapi-app
  template:
    metadata:
      labels:
        app: fastapi-app
        version: v1.0.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8000"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: fastapi
        image: company/fastapi-app:1.0.0
        command:
          - uvicorn
          - fastapi_optimized:app
          - --host=0.0.0.0
          - --port=8000
          - --loop=uvloop
          - --http=httptools
          - --workers=4
          - --limit-concurrency=1000
          - --backlog=2048
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: database-credentials
              key: url
        - name: PYTHONUNBUFFERED
          value: "1"
        - name: PYTHONUTF8
          value: "1"
        ports:
        - containerPort: 8000
          name: http
          protocol: TCP
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8000
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
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
                  - fastapi-app
              topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: fastapi-app
  namespace: production
spec:
  selector:
    app: fastapi-app
  ports:
  - port: 80
    targetPort: 8000
    protocol: TCP
  type: ClusterIP
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: fastapi-app-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: fastapi-app
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
      - type: Pods
        value: 4
        periodSeconds: 30
      selectPolicy: Max
```

## Conclusion

Python async performance optimization requires deep understanding of the event loop, proper concurrency management, and production-ready patterns. Key takeaways:

1. **Use uvloop**: 2-4x faster than standard asyncio event loop
2. **Implement Connection Pooling**: Reuse connections for database and HTTP clients
3. **Control Concurrency**: Use semaphores, queues, or batching to prevent overwhelming systems
4. **Monitor Continuously**: Track memory usage, event loop lag, and task counts
5. **Optimize FastAPI**: Use ORJSONResponse, uvloop, and httptools for maximum performance

Proper async optimization can improve application throughput by 10-20x while reducing latency and resource consumption. Regular profiling and monitoring ensure sustained performance in production.