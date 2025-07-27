---
title: "Enterprise Linux Swap and Memory Management: Comprehensive Performance Optimization and Infrastructure Automation"
date: 2025-07-29T10:00:00-05:00
draft: false
tags: ["Linux", "Swap", "Memory Management", "Performance", "Ubuntu", "Enterprise Infrastructure", "Automation", "Monitoring", "Optimization", "DevOps"]
categories:
- Performance Optimization
- Enterprise Infrastructure
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to Linux swap configuration, advanced memory management, performance optimization frameworks, and production infrastructure automation for mission-critical systems"
more_link: "yes"
url: "/enterprise-linux-swap-memory-management-comprehensive-optimization-guide/"
---

Enterprise Linux environments require sophisticated swap and memory management strategies to ensure optimal performance, prevent out-of-memory conditions, and maintain system stability across thousands of servers running mission-critical workloads. This guide covers advanced swap configuration, enterprise memory optimization frameworks, automated performance tuning, and comprehensive monitoring solutions for production infrastructures.

<!--more-->

# [Enterprise Memory Management Architecture](#enterprise-memory-management-architecture)

## Comprehensive Swap Strategy Framework

Enterprise systems demand intelligent swap management that balances performance, reliability, and resource utilization while preventing catastrophic failures and maintaining predictable application behavior under varying load conditions.

### Enterprise Memory Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│            Enterprise Memory Management Architecture            │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│  Physical Layer │  Virtual Layer  │  Application    │ Monitoring│
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ RAM/DIMM    │ │ │ Page Tables │ │ │ Process Mem │ │ │Metrics│ │
│ │ NUMA Nodes  │ │ │ Swap Space  │ │ │ Shared Mem  │ │ │Alerts │ │
│ │ Memory Ctrl │ │ │ Page Cache  │ │ │ Heap/Stack  │ │ │Logs   │ │
│ │ ECC/Correct │ │ │ Huge Pages  │ │ │ Memory Maps │ │ │Trace  │ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Hardware      │ • Kernel managed│ • App specific  │ • Real    │
│ • NUMA aware    │ • Transparent   │ • Controllable  │ • Time    │
│ • Error correct │ • Optimized     │ • Monitored     │ • Alert   │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Memory Management Maturity Model

| Level | Swap Config | Monitoring | Optimization | Scale |
|-------|------------|------------|--------------|--------|
| **Basic** | Default swap | Manual checks | None | Single server |
| **Managed** | Sized swap | Basic alerts | Tuned params | 10s of servers |
| **Advanced** | Dynamic swap | Automated monitoring | Performance profiling | 100s of servers |
| **Enterprise** | Intelligent swap | Predictive analytics | ML-based optimization | 1000s+ servers |

## Advanced Swap Management Framework

### Enterprise Swap Configuration System

```python
#!/usr/bin/env python3
"""
Enterprise Linux Swap and Memory Management Framework
"""

import os
import sys
import json
import yaml
import logging
import psutil
import asyncio
import subprocess
from typing import Dict, List, Optional, Tuple, Any, Union
from dataclasses import dataclass, asdict, field
from pathlib import Path
from enum import Enum
from datetime import datetime, timedelta
import numpy as np
from prometheus_client import Counter, Gauge, Histogram
import redis
import boto3
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import PolynomialFeatures
import warnings
warnings.filterwarnings('ignore')

class SwapType(Enum):
    PARTITION = "partition"
    FILE = "file"
    ZRAM = "zram"
    ZSWAP = "zswap"
    DISTRIBUTED = "distributed"

class MemoryPressure(Enum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"

class WorkloadType(Enum):
    DATABASE = "database"
    WEBSERVER = "webserver"
    COMPUTE = "compute"
    CONTAINER = "container"
    MIXED = "mixed"

@dataclass
class SwapConfiguration:
    """Swap configuration parameters"""
    swap_type: SwapType
    size_mb: int
    priority: int = -1
    device: Optional[str] = None
    file_path: Optional[str] = None
    compression_algo: Optional[str] = None
    max_pool_percent: Optional[int] = None
    swappiness: int = 60
    vfs_cache_pressure: int = 100
    min_free_kbytes: Optional[int] = None
    watermark_scale_factor: int = 10
    oom_kill_allocating_task: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class MemoryMetrics:
    """System memory metrics"""
    timestamp: datetime
    total_memory: int
    available_memory: int
    used_memory: int
    free_memory: int
    cached_memory: int
    buffer_memory: int
    swap_total: int
    swap_used: int
    swap_free: int
    swap_in_rate: float
    swap_out_rate: float
    page_fault_rate: float
    memory_pressure: MemoryPressure
    numa_stats: Dict[int, Dict[str, int]] = field(default_factory=dict)
    process_metrics: List[Dict[str, Any]] = field(default_factory=list)

@dataclass
class PerformanceProfile:
    """System performance profile"""
    workload_type: WorkloadType
    avg_memory_usage: float
    peak_memory_usage: float
    memory_volatility: float
    swap_usage_pattern: str
    recommended_swap_size: int
    recommended_swappiness: int
    optimization_params: Dict[str, Any] = field(default_factory=dict)

class EnterpriseSwapManager:
    """Enterprise swap and memory management system"""
    
    def __init__(self, config_path: str):
        self.config = self._load_config(config_path)
        self.logger = self._setup_logging()
        self.redis_client = self._init_redis()
        self.metrics_history: List[MemoryMetrics] = []
        self.performance_model = None
        
        # Metrics
        self.swap_operations = Counter('swap_operations_total',
                                     'Total swap operations',
                                     ['operation', 'status'])
        self.memory_usage_bytes = Gauge('memory_usage_bytes',
                                      'Memory usage in bytes',
                                      ['type'])
        self.swap_usage_bytes = Gauge('swap_usage_bytes',
                                    'Swap usage in bytes',
                                    ['device'])
        self.memory_pressure_score = Gauge('memory_pressure_score',
                                         'Memory pressure score (0-100)')
        self.swap_io_rate = Gauge('swap_io_rate_bytes_per_second',
                                'Swap I/O rate',
                                ['direction'])
        
    def _load_config(self, config_path: str) -> Dict[str, Any]:
        """Load configuration from file"""
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    
    def _setup_logging(self) -> logging.Logger:
        """Setup enterprise logging"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        
        # File handler with rotation
        from logging.handlers import RotatingFileHandler
        file_handler = RotatingFileHandler(
            '/var/log/swap-manager/swap-manager.log',
            maxBytes=50*1024*1024,  # 50MB
            backupCount=10
        )
        file_handler.setLevel(logging.DEBUG)
        
        # Syslog handler
        syslog_handler = logging.handlers.SysLogHandler(
            address=(self.config.get('syslog_host', 'localhost'), 514)
        )
        syslog_handler.setLevel(logging.WARNING)
        
        # Formatter
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        
        for handler in [console_handler, file_handler, syslog_handler]:
            handler.setFormatter(formatter)
            logger.addHandler(handler)
        
        return logger
    
    def _init_redis(self) -> redis.Redis:
        """Initialize Redis client for caching"""
        return redis.Redis(
            host=self.config.get('redis_host', 'localhost'),
            port=self.config.get('redis_port', 6379),
            decode_responses=True
        )
    
    async def analyze_system(self) -> PerformanceProfile:
        """Analyze system to determine optimal swap configuration"""
        self.logger.info("Analyzing system performance profile")
        
        # Collect metrics over time
        metrics = await self._collect_metrics_sample()
        
        # Determine workload type
        workload_type = await self._identify_workload_type(metrics)
        
        # Calculate memory statistics
        memory_stats = self._calculate_memory_statistics(metrics)
        
        # Generate performance profile
        profile = PerformanceProfile(
            workload_type=workload_type,
            avg_memory_usage=memory_stats['avg_usage'],
            peak_memory_usage=memory_stats['peak_usage'],
            memory_volatility=memory_stats['volatility'],
            swap_usage_pattern=memory_stats['swap_pattern'],
            recommended_swap_size=self._calculate_optimal_swap_size(memory_stats),
            recommended_swappiness=self._calculate_optimal_swappiness(workload_type, memory_stats),
            optimization_params=self._generate_optimization_params(workload_type, memory_stats)
        )
        
        # Store profile
        self._store_performance_profile(profile)
        
        return profile
    
    async def _collect_metrics_sample(self, duration_minutes: int = 60) -> List[MemoryMetrics]:
        """Collect memory metrics over specified duration"""
        metrics = []
        interval = 10  # seconds
        samples = (duration_minutes * 60) // interval
        
        self.logger.info(f"Collecting {samples} metric samples over {duration_minutes} minutes")
        
        for i in range(samples):
            metric = await self._get_current_metrics()
            metrics.append(metric)
            
            # Update Prometheus metrics
            self._update_prometheus_metrics(metric)
            
            # Store in history
            self.metrics_history.append(metric)
            if len(self.metrics_history) > 10000:  # Keep last 10k samples
                self.metrics_history.pop(0)
            
            await asyncio.sleep(interval)
        
        return metrics
    
    async def _get_current_metrics(self) -> MemoryMetrics:
        """Get current memory metrics"""
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        
        # Get swap I/O rates
        swap_stats = await self._get_swap_io_stats()
        
        # Get NUMA statistics
        numa_stats = await self._get_numa_stats()
        
        # Get top memory consumers
        process_metrics = self._get_process_memory_metrics()
        
        # Calculate memory pressure
        pressure = self._calculate_memory_pressure(mem, swap)
        
        return MemoryMetrics(
            timestamp=datetime.now(),
            total_memory=mem.total,
            available_memory=mem.available,
            used_memory=mem.used,
            free_memory=mem.free,
            cached_memory=mem.cached,
            buffer_memory=mem.buffers,
            swap_total=swap.total,
            swap_used=swap.used,
            swap_free=swap.free,
            swap_in_rate=swap_stats['swap_in_rate'],
            swap_out_rate=swap_stats['swap_out_rate'],
            page_fault_rate=swap_stats['page_fault_rate'],
            memory_pressure=pressure,
            numa_stats=numa_stats,
            process_metrics=process_metrics
        )
    
    async def _get_swap_io_stats(self) -> Dict[str, float]:
        """Get swap I/O statistics"""
        try:
            # Read from /proc/vmstat
            with open('/proc/vmstat', 'r') as f:
                vmstat = dict(line.strip().split() for line in f)
            
            # Calculate rates (this is simplified, should track deltas)
            return {
                'swap_in_rate': float(vmstat.get('pswpin', 0)),
                'swap_out_rate': float(vmstat.get('pswpout', 0)),
                'page_fault_rate': float(vmstat.get('pgfault', 0))
            }
        except Exception as e:
            self.logger.error(f"Failed to get swap I/O stats: {e}")
            return {'swap_in_rate': 0.0, 'swap_out_rate': 0.0, 'page_fault_rate': 0.0}
    
    async def _get_numa_stats(self) -> Dict[int, Dict[str, int]]:
        """Get NUMA node memory statistics"""
        numa_stats = {}
        
        try:
            # Check if system has NUMA
            numa_nodes = psutil.cpu_count() // psutil.cpu_count(logical=False)
            
            for node in range(numa_nodes):
                node_path = f"/sys/devices/system/node/node{node}"
                if os.path.exists(node_path):
                    meminfo_path = f"{node_path}/meminfo"
                    if os.path.exists(meminfo_path):
                        with open(meminfo_path, 'r') as f:
                            node_stats = {}
                            for line in f:
                                if 'MemTotal' in line or 'MemFree' in line or 'MemUsed' in line:
                                    parts = line.split()
                                    if len(parts) >= 4:
                                        key = parts[2].replace(':', '')
                                        value = int(parts[3]) * 1024  # Convert to bytes
                                        node_stats[key.lower()] = value
                            numa_stats[node] = node_stats
        except Exception as e:
            self.logger.debug(f"NUMA stats collection failed: {e}")
        
        return numa_stats
    
    def _get_process_memory_metrics(self, top_n: int = 10) -> List[Dict[str, Any]]:
        """Get memory metrics for top N processes"""
        processes = []
        
        try:
            for proc in psutil.process_iter(['pid', 'name', 'memory_info', 'memory_percent']):
                try:
                    pinfo = proc.info
                    processes.append({
                        'pid': pinfo['pid'],
                        'name': pinfo['name'],
                        'rss': pinfo['memory_info'].rss if pinfo['memory_info'] else 0,
                        'vms': pinfo['memory_info'].vms if pinfo['memory_info'] else 0,
                        'percent': pinfo['memory_percent'] or 0
                    })
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            
            # Sort by RSS and return top N
            processes.sort(key=lambda x: x['rss'], reverse=True)
            return processes[:top_n]
            
        except Exception as e:
            self.logger.error(f"Failed to get process metrics: {e}")
            return []
    
    def _calculate_memory_pressure(self, mem: Any, swap: Any) -> MemoryPressure:
        """Calculate memory pressure level"""
        # Calculate various pressure indicators
        mem_usage_percent = (mem.used / mem.total) * 100
        swap_usage_percent = (swap.used / swap.total * 100) if swap.total > 0 else 0
        available_percent = (mem.available / mem.total) * 100
        
        # Memory pressure scoring
        pressure_score = 0
        
        # Memory usage contribution
        if mem_usage_percent > 95:
            pressure_score += 40
        elif mem_usage_percent > 90:
            pressure_score += 30
        elif mem_usage_percent > 80:
            pressure_score += 20
        elif mem_usage_percent > 70:
            pressure_score += 10
        
        # Available memory contribution
        if available_percent < 5:
            pressure_score += 30
        elif available_percent < 10:
            pressure_score += 20
        elif available_percent < 20:
            pressure_score += 10
        
        # Swap usage contribution
        if swap_usage_percent > 80:
            pressure_score += 30
        elif swap_usage_percent > 50:
            pressure_score += 20
        elif swap_usage_percent > 25:
            pressure_score += 10
        
        # Update metric
        self.memory_pressure_score.set(pressure_score)
        
        # Determine pressure level
        if pressure_score >= 70:
            return MemoryPressure.CRITICAL
        elif pressure_score >= 50:
            return MemoryPressure.HIGH
        elif pressure_score >= 30:
            return MemoryPressure.MODERATE
        else:
            return MemoryPressure.LOW
    
    def _update_prometheus_metrics(self, metrics: MemoryMetrics):
        """Update Prometheus metrics"""
        # Memory usage
        self.memory_usage_bytes.labels(type='total').set(metrics.total_memory)
        self.memory_usage_bytes.labels(type='used').set(metrics.used_memory)
        self.memory_usage_bytes.labels(type='free').set(metrics.free_memory)
        self.memory_usage_bytes.labels(type='available').set(metrics.available_memory)
        self.memory_usage_bytes.labels(type='cached').set(metrics.cached_memory)
        self.memory_usage_bytes.labels(type='buffers').set(metrics.buffer_memory)
        
        # Swap usage
        self.swap_usage_bytes.labels(device='total').set(metrics.swap_total)
        self.swap_usage_bytes.labels(device='used').set(metrics.swap_used)
        self.swap_usage_bytes.labels(device='free').set(metrics.swap_free)
        
        # Swap I/O rates
        self.swap_io_rate.labels(direction='in').set(metrics.swap_in_rate)
        self.swap_io_rate.labels(direction='out').set(metrics.swap_out_rate)
    
    async def _identify_workload_type(self, metrics: List[MemoryMetrics]) -> WorkloadType:
        """Identify workload type based on memory patterns"""
        if not metrics:
            return WorkloadType.MIXED
        
        # Analyze memory usage patterns
        memory_usage = [m.used_memory / m.total_memory for m in metrics]
        swap_usage = [m.swap_used / m.swap_total if m.swap_total > 0 else 0 for m in metrics]
        
        # Calculate statistics
        avg_memory = np.mean(memory_usage)
        std_memory = np.std(memory_usage)
        cv_memory = std_memory / avg_memory if avg_memory > 0 else 0  # Coefficient of variation
        
        avg_swap = np.mean(swap_usage)
        
        # Analyze top processes
        process_types = {}
        for metric in metrics:
            for proc in metric.process_metrics:
                name = proc['name'].lower()
                if any(db in name for db in ['mysql', 'postgres', 'mongo', 'redis', 'cassandra']):
                    process_types['database'] = process_types.get('database', 0) + 1
                elif any(web in name for web in ['nginx', 'apache', 'httpd', 'node', 'java']):
                    process_types['webserver'] = process_types.get('webserver', 0) + 1
                elif any(cont in name for cont in ['docker', 'containerd', 'runc', 'kubelet']):
                    process_types['container'] = process_types.get('container', 0) + 1
                elif any(comp in name for comp in ['python', 'R', 'matlab', 'julia']):
                    process_types['compute'] = process_types.get('compute', 0) + 1
        
        # Determine workload type
        if process_types:
            dominant_type = max(process_types, key=process_types.get)
            if process_types[dominant_type] > len(metrics) * 5:  # Significant presence
                return WorkloadType[dominant_type.upper()]
        
        # Fallback to pattern-based detection
        if avg_memory > 0.8 and cv_memory < 0.1:  # High, stable memory usage
            return WorkloadType.DATABASE
        elif cv_memory > 0.3:  # Highly variable memory usage
            return WorkloadType.WEBSERVER
        elif avg_swap > 0.2:  # Significant swap usage
            return WorkloadType.COMPUTE
        else:
            return WorkloadType.MIXED
    
    def _calculate_memory_statistics(self, metrics: List[MemoryMetrics]) -> Dict[str, Any]:
        """Calculate memory usage statistics"""
        if not metrics:
            return {
                'avg_usage': 0,
                'peak_usage': 0,
                'volatility': 0,
                'swap_pattern': 'unknown'
            }
        
        memory_usage = [(m.used_memory / m.total_memory) * 100 for m in metrics]
        swap_usage = [(m.swap_used / m.swap_total * 100) if m.swap_total > 0 else 0 for m in metrics]
        
        # Swap pattern analysis
        swap_pattern = 'minimal'
        if np.mean(swap_usage) > 50:
            swap_pattern = 'heavy'
        elif np.mean(swap_usage) > 20:
            swap_pattern = 'moderate'
        elif np.std(swap_usage) > 10:
            swap_pattern = 'bursty'
        
        return {
            'avg_usage': np.mean(memory_usage),
            'peak_usage': np.max(memory_usage),
            'volatility': np.std(memory_usage),
            'swap_pattern': swap_pattern,
            'p95_usage': np.percentile(memory_usage, 95),
            'p99_usage': np.percentile(memory_usage, 99)
        }
    
    def _calculate_optimal_swap_size(self, memory_stats: Dict[str, Any]) -> int:
        """Calculate optimal swap size based on system profile"""
        total_ram = psutil.virtual_memory().total
        
        # Base calculation on RAM size and usage patterns
        if total_ram <= 2 * (1024**3):  # <= 2GB RAM
            base_swap = total_ram * 2
        elif total_ram <= 8 * (1024**3):  # <= 8GB RAM
            base_swap = total_ram
        elif total_ram <= 64 * (1024**3):  # <= 64GB RAM
            base_swap = int(total_ram * 0.5)
        else:  # > 64GB RAM
            base_swap = min(32 * (1024**3), int(total_ram * 0.25))
        
        # Adjust based on usage patterns
        if memory_stats['swap_pattern'] == 'heavy':
            swap_size = int(base_swap * 1.5)
        elif memory_stats['swap_pattern'] == 'bursty':
            swap_size = int(base_swap * 1.25)
        elif memory_stats['peak_usage'] > 90:
            swap_size = int(base_swap * 1.25)
        else:
            swap_size = base_swap
        
        # Ensure minimum swap for hibernation if configured
        if self.config.get('enable_hibernation', False):
            swap_size = max(swap_size, total_ram + (1024**3))  # RAM + 1GB
        
        return swap_size // (1024**2)  # Return in MB
    
    def _calculate_optimal_swappiness(self, 
                                    workload_type: WorkloadType,
                                    memory_stats: Dict[str, Any]) -> int:
        """Calculate optimal swappiness value"""
        # Base swappiness by workload type
        base_swappiness = {
            WorkloadType.DATABASE: 10,      # Minimize swapping for databases
            WorkloadType.WEBSERVER: 30,     # Moderate swapping
            WorkloadType.COMPUTE: 60,       # Default swapping
            WorkloadType.CONTAINER: 40,     # Container-friendly
            WorkloadType.MIXED: 50          # Balanced
        }
        
        swappiness = base_swappiness.get(workload_type, 60)
        
        # Adjust based on memory pressure
        if memory_stats['avg_usage'] > 85:
            swappiness = min(swappiness + 10, 100)
        elif memory_stats['avg_usage'] < 50:
            swappiness = max(swappiness - 10, 0)
        
        # Adjust based on swap pattern
        if memory_stats['swap_pattern'] == 'heavy':
            swappiness = min(swappiness + 10, 100)
        elif memory_stats['swap_pattern'] == 'minimal':
            swappiness = max(swappiness - 10, 0)
        
        return swappiness
    
    def _generate_optimization_params(self,
                                    workload_type: WorkloadType,
                                    memory_stats: Dict[str, Any]) -> Dict[str, Any]:
        """Generate optimization parameters"""
        params = {}
        
        # VFS cache pressure
        if workload_type == WorkloadType.DATABASE:
            params['vfs_cache_pressure'] = 50  # Prefer caching
        elif workload_type == WorkloadType.WEBSERVER:
            params['vfs_cache_pressure'] = 80
        else:
            params['vfs_cache_pressure'] = 100
        
        # Dirty ratio and background ratio
        total_ram_gb = psutil.virtual_memory().total // (1024**3)
        
        if total_ram_gb <= 4:
            params['dirty_ratio'] = 15
            params['dirty_background_ratio'] = 5
        elif total_ram_gb <= 16:
            params['dirty_ratio'] = 10
            params['dirty_background_ratio'] = 3
        else:
            params['dirty_ratio'] = 5
            params['dirty_background_ratio'] = 2
        
        # Min free kbytes
        params['min_free_kbytes'] = min(
            int(psutil.virtual_memory().total * 0.01 / 1024),  # 1% of RAM
            262144  # Max 256MB
        )
        
        # Watermark scale factor
        if memory_stats['volatility'] > 20:
            params['watermark_scale_factor'] = 200  # More aggressive
        else:
            params['watermark_scale_factor'] = 100
        
        # Zone reclaim mode
        if workload_type == WorkloadType.DATABASE:
            params['zone_reclaim_mode'] = 0  # Disable for databases
        else:
            params['zone_reclaim_mode'] = 1
        
        # Transparent huge pages
        if workload_type in [WorkloadType.DATABASE, WorkloadType.COMPUTE]:
            params['transparent_hugepage'] = 'madvise'
        else:
            params['transparent_hugepage'] = 'always'
        
        # OOM killer settings
        params['oom_kill_allocating_task'] = 0
        params['panic_on_oom'] = 0
        
        return params
    
    def _store_performance_profile(self, profile: PerformanceProfile):
        """Store performance profile for future reference"""
        try:
            # Store in Redis
            key = f"performance_profile:{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            self.redis_client.setex(
                key,
                timedelta(days=30),
                json.dumps(asdict(profile), default=str)
            )
            
            # Store latest profile
            self.redis_client.set(
                "performance_profile:latest",
                json.dumps(asdict(profile), default=str)
            )
            
        except Exception as e:
            self.logger.error(f"Failed to store performance profile: {e}")
    
    async def configure_swap(self, config: SwapConfiguration) -> Dict[str, Any]:
        """Configure swap based on provided configuration"""
        self.logger.info(f"Configuring swap: {config.swap_type.value}")
        
        result = {
            'status': 'pending',
            'config': asdict(config),
            'timestamp': datetime.now().isoformat()
        }
        
        try:
            # Disable existing swap if requested
            if self.config.get('disable_existing_swap', False):
                await self._disable_all_swap()
            
            # Configure based on swap type
            if config.swap_type == SwapType.PARTITION:
                swap_result = await self._configure_partition_swap(config)
            elif config.swap_type == SwapType.FILE:
                swap_result = await self._configure_file_swap(config)
            elif config.swap_type == SwapType.ZRAM:
                swap_result = await self._configure_zram_swap(config)
            elif config.swap_type == SwapType.ZSWAP:
                swap_result = await self._configure_zswap(config)
            else:
                raise ValueError(f"Unsupported swap type: {config.swap_type}")
            
            result.update(swap_result)
            
            # Apply system parameters
            await self._apply_system_parameters(config)
            
            # Verify configuration
            verification = await self._verify_swap_configuration(config)
            result['verification'] = verification
            
            if verification['success']:
                result['status'] = 'success'
                self.swap_operations.labels(
                    operation='configure',
                    status='success'
                ).inc()
            else:
                result['status'] = 'failed'
                self.swap_operations.labels(
                    operation='configure',
                    status='failure'
                ).inc()
            
        except Exception as e:
            self.logger.error(f"Swap configuration failed: {e}")
            result['status'] = 'error'
            result['error'] = str(e)
            self.swap_operations.labels(
                operation='configure',
                status='error'
            ).inc()
        
        return result
    
    async def _disable_all_swap(self):
        """Disable all swap devices"""
        self.logger.info("Disabling all swap devices")
        
        try:
            # Get current swap devices
            result = subprocess.run(
                ['swapon', '--show', '--raw', '--noheadings'],
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0 and result.stdout:
                for line in result.stdout.strip().split('\n'):
                    parts = line.split()
                    if parts:
                        device = parts[0]
                        subprocess.run(['swapoff', device], check=True)
                        self.logger.info(f"Disabled swap on {device}")
        
        except subprocess.CalledProcessError as e:
            self.logger.error(f"Failed to disable swap: {e}")
            raise
    
    async def _configure_partition_swap(self, config: SwapConfiguration) -> Dict[str, Any]:
        """Configure partition-based swap"""
        if not config.device:
            raise ValueError("Device path required for partition swap")
        
        self.logger.info(f"Configuring partition swap on {config.device}")
        
        # Check if device exists
        if not os.path.exists(config.device):
            raise FileNotFoundError(f"Device not found: {config.device}")
        
        # Create swap signature
        subprocess.run(['mkswap', config.device], check=True)
        
        # Enable swap with priority
        cmd = ['swapon', config.device]
        if config.priority >= 0:
            cmd.extend(['-p', str(config.priority)])
        
        subprocess.run(cmd, check=True)
        
        # Update /etc/fstab
        await self._update_fstab(config)
        
        return {
            'device': config.device,
            'enabled': True
        }
    
    async def _configure_file_swap(self, config: SwapConfiguration) -> Dict[str, Any]:
        """Configure file-based swap"""
        if not config.file_path:
            config.file_path = '/var/swap/swapfile'
        
        self.logger.info(f"Configuring file swap at {config.file_path}")
        
        # Create directory if needed
        swap_dir = os.path.dirname(config.file_path)
        os.makedirs(swap_dir, exist_ok=True)
        
        # Create swap file using dd (more reliable than fallocate on some filesystems)
        size_blocks = config.size_mb
        subprocess.run([
            'dd', 'if=/dev/zero', f'of={config.file_path}',
            f'bs=1M', f'count={size_blocks}', 'status=progress'
        ], check=True)
        
        # Set permissions
        os.chmod(config.file_path, 0o600)
        
        # Create swap signature
        subprocess.run(['mkswap', config.file_path], check=True)
        
        # Enable swap
        cmd = ['swapon', config.file_path]
        if config.priority >= 0:
            cmd.extend(['-p', str(config.priority)])
        
        subprocess.run(cmd, check=True)
        
        # Update /etc/fstab
        await self._update_fstab(config)
        
        return {
            'file': config.file_path,
            'size_mb': config.size_mb,
            'enabled': True
        }
    
    async def _configure_zram_swap(self, config: SwapConfiguration) -> Dict[str, Any]:
        """Configure ZRAM-based swap"""
        self.logger.info("Configuring ZRAM swap")
        
        # Load zram module
        subprocess.run(['modprobe', 'zram'], check=True)
        
        # Find available zram device
        zram_device = None
        for i in range(256):
            device = f"/dev/zram{i}"
            if not os.path.exists(device):
                # Create device
                with open('/sys/class/zram-control/hot_add', 'w') as f:
                    f.write('1')
                if os.path.exists(device):
                    zram_device = device
                    break
            else:
                # Check if unused
                with open(f'/sys/block/zram{i}/disksize', 'r') as f:
                    if f.read().strip() == '0':
                        zram_device = device
                        break
        
        if not zram_device:
            raise RuntimeError("No available zram device found")
        
        # Configure compression algorithm
        if config.compression_algo:
            algo_path = f'/sys/block/{os.path.basename(zram_device)}/comp_algorithm'
            with open(algo_path, 'w') as f:
                f.write(config.compression_algo)
        
        # Set size
        size_bytes = config.size_mb * 1024 * 1024
        size_path = f'/sys/block/{os.path.basename(zram_device)}/disksize'
        with open(size_path, 'w') as f:
            f.write(str(size_bytes))
        
        # Create swap on zram device
        subprocess.run(['mkswap', zram_device], check=True)
        
        # Enable swap
        cmd = ['swapon', zram_device]
        if config.priority >= 0:
            cmd.extend(['-p', str(config.priority)])
        
        subprocess.run(cmd, check=True)
        
        # Create systemd service for persistence
        await self._create_zram_service(config, zram_device)
        
        return {
            'device': zram_device,
            'compression': config.compression_algo or 'lzo',
            'size_mb': config.size_mb,
            'enabled': True
        }
    
    async def _configure_zswap(self, config: SwapConfiguration) -> Dict[str, Any]:
        """Configure ZSWAP (compressed swap cache)"""
        self.logger.info("Configuring ZSWAP")
        
        # Enable zswap
        with open('/sys/module/zswap/parameters/enabled', 'w') as f:
            f.write('1')
        
        # Configure compression algorithm
        if config.compression_algo:
            with open('/sys/module/zswap/parameters/compressor', 'w') as f:
                f.write(config.compression_algo)
        
        # Configure max pool percent
        if config.max_pool_percent:
            with open('/sys/module/zswap/parameters/max_pool_percent', 'w') as f:
                f.write(str(config.max_pool_percent))
        
        # Make persistent via kernel parameters
        grub_params = []
        grub_params.append('zswap.enabled=1')
        if config.compression_algo:
            grub_params.append(f'zswap.compressor={config.compression_algo}')
        if config.max_pool_percent:
            grub_params.append(f'zswap.max_pool_percent={config.max_pool_percent}')
        
        await self._update_grub_config(grub_params)
        
        return {
            'type': 'zswap',
            'enabled': True,
            'compressor': config.compression_algo or 'lzo',
            'max_pool_percent': config.max_pool_percent or 20
        }
    
    async def _apply_system_parameters(self, config: SwapConfiguration):
        """Apply system parameters for swap configuration"""
        self.logger.info("Applying system parameters")
        
        # Swappiness
        with open('/proc/sys/vm/swappiness', 'w') as f:
            f.write(str(config.swappiness))
        
        # VFS cache pressure
        with open('/proc/sys/vm/vfs_cache_pressure', 'w') as f:
            f.write(str(config.vfs_cache_pressure))
        
        # Min free kbytes
        if config.min_free_kbytes:
            with open('/proc/sys/vm/min_free_kbytes', 'w') as f:
                f.write(str(config.min_free_kbytes))
        
        # Watermark scale factor
        wm_path = '/proc/sys/vm/watermark_scale_factor'
        if os.path.exists(wm_path):
            with open(wm_path, 'w') as f:
                f.write(str(config.watermark_scale_factor))
        
        # OOM killer settings
        oom_path = '/proc/sys/vm/oom_kill_allocating_task'
        if os.path.exists(oom_path):
            with open(oom_path, 'w') as f:
                f.write('1' if config.oom_kill_allocating_task else '0')
        
        # Make persistent via sysctl
        await self._update_sysctl_conf(config)
    
    async def _update_fstab(self, config: SwapConfiguration):
        """Update /etc/fstab for swap persistence"""
        fstab_entry = None
        
        if config.swap_type == SwapType.PARTITION:
            # Get UUID
            result = subprocess.run(
                ['blkid', '-s', 'UUID', '-o', 'value', config.device],
                capture_output=True,
                text=True
            )
            if result.returncode == 0 and result.stdout:
                uuid = result.stdout.strip()
                fstab_entry = f"UUID={uuid} none swap sw,pri={config.priority} 0 0"
            else:
                fstab_entry = f"{config.device} none swap sw,pri={config.priority} 0 0"
        
        elif config.swap_type == SwapType.FILE:
            fstab_entry = f"{config.file_path} none swap sw,pri={config.priority} 0 0"
        
        if fstab_entry:
            # Check if entry already exists
            with open('/etc/fstab', 'r') as f:
                fstab_content = f.read()
            
            if fstab_entry not in fstab_content:
                # Backup fstab
                subprocess.run(['cp', '/etc/fstab', '/etc/fstab.bak'], check=True)
                
                # Add entry
                with open('/etc/fstab', 'a') as f:
                    f.write(f"\n# Added by swap manager - {datetime.now()}\n")
                    f.write(f"{fstab_entry}\n")
    
    async def _update_sysctl_conf(self, config: SwapConfiguration):
        """Update sysctl.conf for parameter persistence"""
        sysctl_params = {
            'vm.swappiness': config.swappiness,
            'vm.vfs_cache_pressure': config.vfs_cache_pressure,
            'vm.watermark_scale_factor': config.watermark_scale_factor,
            'vm.oom_kill_allocating_task': 1 if config.oom_kill_allocating_task else 0
        }
        
        if config.min_free_kbytes:
            sysctl_params['vm.min_free_kbytes'] = config.min_free_kbytes
        
        # Read existing sysctl.conf
        sysctl_file = '/etc/sysctl.d/99-swap-manager.conf'
        
        with open(sysctl_file, 'w') as f:
            f.write("# Swap Manager Configuration\n")
            f.write(f"# Generated: {datetime.now()}\n\n")
            
            for param, value in sysctl_params.items():
                f.write(f"{param} = {value}\n")
        
        # Apply settings
        subprocess.run(['sysctl', '-p', sysctl_file], check=True)
    
    async def _create_zram_service(self, config: SwapConfiguration, device: str):
        """Create systemd service for ZRAM persistence"""
        service_content = f"""[Unit]
Description=ZRAM Swap Device
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/setup-zram-swap.sh
ExecStop=/sbin/swapoff {device}

[Install]
WantedBy=multi-user.target
"""
        
        # Create service file
        service_file = '/etc/systemd/system/zram-swap.service'
        with open(service_file, 'w') as f:
            f.write(service_content)
        
        # Create setup script
        script_content = f"""#!/bin/bash
# ZRAM Swap Setup Script
# Generated by Swap Manager

modprobe zram

# Configure device
echo {config.compression_algo or 'lzo'} > /sys/block/{os.path.basename(device)}/comp_algorithm
echo {config.size_mb * 1024 * 1024} > /sys/block/{os.path.basename(device)}/disksize

# Create and enable swap
mkswap {device}
swapon -p {config.priority} {device}
"""
        
        script_file = '/usr/local/bin/setup-zram-swap.sh'
        with open(script_file, 'w') as f:
            f.write(script_content)
        
        os.chmod(script_file, 0o755)
        
        # Enable service
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'enable', 'zram-swap.service'], check=True)
    
    async def _update_grub_config(self, params: List[str]):
        """Update GRUB configuration for kernel parameters"""
        grub_file = '/etc/default/grub'
        
        # Backup
        subprocess.run(['cp', grub_file, f'{grub_file}.bak'], check=True)
        
        # Read current config
        with open(grub_file, 'r') as f:
            lines = f.readlines()
        
        # Update GRUB_CMDLINE_LINUX_DEFAULT
        param_string = ' '.join(params)
        updated = False
        
        for i, line in enumerate(lines):
            if line.startswith('GRUB_CMDLINE_LINUX_DEFAULT='):
                # Extract current parameters
                import re
                match = re.match(r'GRUB_CMDLINE_LINUX_DEFAULT="([^"]*)"', line)
                if match:
                    current_params = match.group(1)
                    # Add our parameters if not already present
                    for param in params:
                        if param not in current_params:
                            current_params += f' {param}'
                    lines[i] = f'GRUB_CMDLINE_LINUX_DEFAULT="{current_params}"\n'
                    updated = True
                    break
        
        if updated:
            # Write updated config
            with open(grub_file, 'w') as f:
                f.writelines(lines)
            
            # Update GRUB
            subprocess.run(['update-grub'], check=True)
    
    async def _verify_swap_configuration(self, config: SwapConfiguration) -> Dict[str, Any]:
        """Verify swap configuration is active and correct"""
        verification = {
            'success': False,
            'active_swap': [],
            'parameters': {}
        }
        
        try:
            # Check swap status
            result = subprocess.run(
                ['swapon', '--show', '--raw', '--noheadings'],
                capture_output=True,
                text=True
            )
            
            if result.returncode == 0:
                for line in result.stdout.strip().split('\n'):
                    if line:
                        parts = line.split()
                        if len(parts) >= 5:
                            swap_info = {
                                'name': parts[0],
                                'type': parts[1],
                                'size': parts[2],
                                'used': parts[3],
                                'priority': parts[4]
                            }
                            verification['active_swap'].append(swap_info)
                            
                            # Check if our swap is active
                            if config.swap_type == SwapType.PARTITION and parts[0] == config.device:
                                verification['success'] = True
                            elif config.swap_type == SwapType.FILE and parts[0] == config.file_path:
                                verification['success'] = True
                            elif config.swap_type == SwapType.ZRAM and 'zram' in parts[0]:
                                verification['success'] = True
            
            # Verify system parameters
            param_files = {
                'swappiness': '/proc/sys/vm/swappiness',
                'vfs_cache_pressure': '/proc/sys/vm/vfs_cache_pressure',
                'min_free_kbytes': '/proc/sys/vm/min_free_kbytes',
                'watermark_scale_factor': '/proc/sys/vm/watermark_scale_factor'
            }
            
            for param, path in param_files.items():
                if os.path.exists(path):
                    with open(path, 'r') as f:
                        verification['parameters'][param] = int(f.read().strip())
            
            # Check ZSWAP if configured
            if config.swap_type == SwapType.ZSWAP:
                with open('/sys/module/zswap/parameters/enabled', 'r') as f:
                    enabled = f.read().strip()
                    verification['zswap_enabled'] = enabled == 'Y'
                    verification['success'] = verification['zswap_enabled']
            
        except Exception as e:
            self.logger.error(f"Verification failed: {e}")
            verification['error'] = str(e)
        
        return verification
    
    async def monitor_memory_health(self) -> Dict[str, Any]:
        """Monitor memory health and provide recommendations"""
        self.logger.info("Monitoring memory health")
        
        # Collect current metrics
        metrics = await self._get_current_metrics()
        
        # Analyze health
        health_report = {
            'timestamp': datetime.now().isoformat(),
            'status': 'healthy',
            'memory_pressure': metrics.memory_pressure.value,
            'metrics': {
                'memory_usage_percent': (metrics.used_memory / metrics.total_memory) * 100,
                'swap_usage_percent': (metrics.swap_used / metrics.swap_total * 100) if metrics.swap_total > 0 else 0,
                'available_memory_gb': metrics.available_memory / (1024**3),
                'swap_io_rate': metrics.swap_in_rate + metrics.swap_out_rate
            },
            'issues': [],
            'recommendations': []
        }
        
        # Check for issues
        if metrics.memory_pressure == MemoryPressure.CRITICAL:
            health_report['status'] = 'critical'
            health_report['issues'].append("Critical memory pressure detected")
            health_report['recommendations'].append("Consider adding more RAM or increasing swap space")
        
        elif metrics.memory_pressure == MemoryPressure.HIGH:
            health_report['status'] = 'warning'
            health_report['issues'].append("High memory pressure detected")
            health_report['recommendations'].append("Monitor closely and consider memory optimization")
        
        # Check swap usage
        if metrics.swap_total > 0:
            swap_usage_percent = (metrics.swap_used / metrics.swap_total) * 100
            if swap_usage_percent > 80:
                health_report['issues'].append(f"High swap usage: {swap_usage_percent:.1f}%")
                health_report['recommendations'].append("Consider increasing swap space or optimizing memory usage")
        
        # Check swap I/O
        if metrics.swap_in_rate + metrics.swap_out_rate > 1000000:  # 1MB/s
            health_report['issues'].append("High swap I/O activity")
            health_report['recommendations'].append("Consider using faster storage for swap or adding more RAM")
        
        # Check for memory leaks in top processes
        for proc in metrics.process_metrics[:5]:
            if proc['percent'] > 20:
                health_report['issues'].append(
                    f"Process {proc['name']} (PID: {proc['pid']}) using {proc['percent']:.1f}% memory"
                )
        
        # Machine learning predictions if model is trained
        if self.performance_model:
            prediction = self._predict_memory_usage()
            if prediction:
                health_report['prediction'] = prediction
        
        return health_report
    
    def _predict_memory_usage(self) -> Optional[Dict[str, Any]]:
        """Predict future memory usage using ML model"""
        if not self.metrics_history or len(self.metrics_history) < 100:
            return None
        
        try:
            # Prepare data for prediction
            X = []
            y = []
            
            for i in range(len(self.metrics_history) - 1):
                features = [
                    self.metrics_history[i].used_memory / self.metrics_history[i].total_memory,
                    self.metrics_history[i].swap_used / max(self.metrics_history[i].swap_total, 1),
                    self.metrics_history[i].swap_in_rate,
                    self.metrics_history[i].swap_out_rate,
                    i  # Time component
                ]
                X.append(features)
                y.append(self.metrics_history[i + 1].used_memory / self.metrics_history[i + 1].total_memory)
            
            X = np.array(X)
            y = np.array(y)
            
            # Train simple model if not already trained
            if not self.performance_model:
                self.performance_model = LinearRegression()
                self.performance_model.fit(X, y)
            
            # Predict next hour
            predictions = []
            current_features = X[-1].copy()
            
            for i in range(6):  # 6 x 10 minutes = 1 hour
                pred = self.performance_model.predict([current_features])[0]
                predictions.append(pred * 100)  # Convert to percentage
                
                # Update features for next prediction
                current_features[0] = pred
                current_features[4] += 1
            
            return {
                'next_hour_avg': np.mean(predictions),
                'next_hour_max': np.max(predictions),
                'trend': 'increasing' if predictions[-1] > predictions[0] else 'decreasing'
            }
            
        except Exception as e:
            self.logger.error(f"Prediction failed: {e}")
            return None


class SwapOptimizationEngine:
    """Automated swap optimization engine"""
    
    def __init__(self, manager: EnterpriseSwapManager):
        self.manager = manager
        self.logger = logging.getLogger(__name__)
    
    async def auto_optimize(self) -> Dict[str, Any]:
        """Automatically optimize swap configuration"""
        self.logger.info("Starting automatic swap optimization")
        
        # Analyze system
        profile = await self.manager.analyze_system()
        
        # Generate optimal configuration
        optimal_config = SwapConfiguration(
            swap_type=self._determine_best_swap_type(profile),
            size_mb=profile.recommended_swap_size,
            priority=-1,
            swappiness=profile.recommended_swappiness,
            vfs_cache_pressure=profile.optimization_params.get('vfs_cache_pressure', 100),
            min_free_kbytes=profile.optimization_params.get('min_free_kbytes'),
            watermark_scale_factor=profile.optimization_params.get('watermark_scale_factor', 100),
            oom_kill_allocating_task=profile.optimization_params.get('oom_kill_allocating_task', False)
        )
        
        # Apply configuration
        result = await self.manager.configure_swap(optimal_config)
        
        return {
            'profile': asdict(profile),
            'configuration': asdict(optimal_config),
            'result': result
        }
    
    def _determine_best_swap_type(self, profile: PerformanceProfile) -> SwapType:
        """Determine best swap type based on profile"""
        # Check available storage
        disk_usage = psutil.disk_usage('/')
        free_space_gb = disk_usage.free / (1024**3)
        
        # Check for SSD
        is_ssd = self._check_ssd()
        
        # Decision logic
        if profile.workload_type == WorkloadType.DATABASE and is_ssd:
            # Use ZRAM for databases on SSD to minimize I/O
            return SwapType.ZRAM
        elif free_space_gb < profile.recommended_swap_size / 1024:
            # Not enough disk space, use ZRAM
            return SwapType.ZRAM
        elif is_ssd:
            # SSD available, use file swap
            return SwapType.FILE
        else:
            # HDD, check for dedicated partition
            if self._find_swap_partition():
                return SwapType.PARTITION
            else:
                return SwapType.FILE
    
    def _check_ssd(self) -> bool:
        """Check if root filesystem is on SSD"""
        try:
            # Simple heuristic - check rotational flag
            with open('/sys/block/sda/queue/rotational', 'r') as f:
                return f.read().strip() == '0'
        except:
            return False
    
    def _find_swap_partition(self) -> Optional[str]:
        """Find available swap partition"""
        try:
            result = subprocess.run(
                ['blkid', '-t', 'TYPE=swap'],
                capture_output=True,
                text=True
            )
            if result.returncode == 0 and result.stdout:
                # Extract device path
                parts = result.stdout.split(':')
                if parts:
                    return parts[0]
        except:
            pass
        return None


async def main():
    """Main execution function"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise Swap Manager')
    parser.add_argument('--config', default='/etc/swap-manager/config.yaml',
                       help='Configuration file path')
    parser.add_argument('--action', required=True,
                       choices=['analyze', 'configure', 'optimize', 'monitor', 'report'],
                       help='Action to perform')
    parser.add_argument('--swap-type', choices=['partition', 'file', 'zram', 'zswap'],
                       help='Swap type for configure action')
    parser.add_argument('--size', type=int, help='Swap size in MB')
    parser.add_argument('--device', help='Device path for partition swap')
    parser.add_argument('--output', default='json',
                       choices=['json', 'yaml', 'table'],
                       help='Output format')
    
    args = parser.parse_args()
    
    # Initialize manager
    manager = EnterpriseSwapManager(args.config)
    
    try:
        if args.action == 'analyze':
            # Analyze system
            profile = await manager.analyze_system()
            
            if args.output == 'json':
                print(json.dumps(asdict(profile), indent=2, default=str))
            elif args.output == 'yaml':
                print(yaml.dump(asdict(profile), default_flow_style=False))
            else:
                print(f"Workload Type: {profile.workload_type.value}")
                print(f"Average Memory Usage: {profile.avg_memory_usage:.1f}%")
                print(f"Peak Memory Usage: {profile.peak_memory_usage:.1f}%")
                print(f"Recommended Swap Size: {profile.recommended_swap_size} MB")
                print(f"Recommended Swappiness: {profile.recommended_swappiness}")
        
        elif args.action == 'configure':
            if not args.swap_type:
                parser.error('--swap-type required for configure action')
            
            # Create configuration
            config = SwapConfiguration(
                swap_type=SwapType(args.swap_type),
                size_mb=args.size or 4096,
                device=args.device
            )
            
            # Apply configuration
            result = await manager.configure_swap(config)
            print(json.dumps(result, indent=2))
        
        elif args.action == 'optimize':
            # Auto-optimize
            optimizer = SwapOptimizationEngine(manager)
            result = await optimizer.auto_optimize()
            print(json.dumps(result, indent=2, default=str))
        
        elif args.action == 'monitor':
            # Monitor health
            health = await manager.monitor_memory_health()
            
            if args.output == 'json':
                print(json.dumps(health, indent=2))
            else:
                print(f"Status: {health['status'].upper()}")
                print(f"Memory Pressure: {health['memory_pressure']}")
                print(f"Memory Usage: {health['metrics']['memory_usage_percent']:.1f}%")
                print(f"Swap Usage: {health['metrics']['swap_usage_percent']:.1f}%")
                
                if health['issues']:
                    print("\nIssues:")
                    for issue in health['issues']:
                        print(f"  - {issue}")
                
                if health['recommendations']:
                    print("\nRecommendations:")
                    for rec in health['recommendations']:
                        print(f"  - {rec}")
        
        elif args.action == 'report':
            # Generate detailed report
            print("Generating comprehensive memory report...")
            
            # This would generate a detailed report
            # Implementation depends on specific requirements
    
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
```

# [Enterprise Swap Management Implementation](#enterprise-swap-management-implementation)

## Production Deployment Scripts

### Automated Swap Configuration Script

```bash
#!/bin/bash
# enterprise-swap-deploy.sh - Enterprise swap deployment automation

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-/etc/swap-manager/config.yaml}"
LOG_DIR="/var/log/swap-manager"
STATE_DIR="/var/lib/swap-manager"

# Create directories
mkdir -p "$LOG_DIR" "$STATE_DIR"

# Logging
LOG_FILE="$LOG_DIR/swap-deploy-$(date +%Y%m%d-%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
    exit 1
}

# Check system requirements
check_requirements() {
    log "Checking system requirements"
    
    # Check for required tools
    local required_tools=("python3" "swapon" "mkswap" "dd" "blkid")
    for tool in "${required_tools[@]}"; do
        if ! command -v "$tool" &> /dev/null; then
            error "Required tool not found: $tool"
        fi
    done
    
    # Check Python modules
    python3 -c "import psutil, yaml, prometheus_client" || \
        error "Required Python modules not installed"
    
    # Check if running as root
    if [[ $EUID -ne 0 ]]; then
        error "This script must be run as root"
    fi
    
    log "Requirements check passed"
}

# Analyze system and get recommendations
analyze_system() {
    log "Analyzing system configuration"
    
    # Run analysis
    local analysis_output
    analysis_output=$(python3 /usr/local/bin/swap-manager.py \
        --config "$CONFIG_FILE" \
        --action analyze \
        --output json)
    
    # Save analysis
    echo "$analysis_output" > "$STATE_DIR/last-analysis.json"
    
    # Extract recommendations
    RECOMMENDED_SWAP_SIZE=$(echo "$analysis_output" | \
        python3 -c "import sys, json; print(json.load(sys.stdin)['recommended_swap_size'])")
    RECOMMENDED_SWAPPINESS=$(echo "$analysis_output" | \
        python3 -c "import sys, json; print(json.load(sys.stdin)['recommended_swappiness'])")
    WORKLOAD_TYPE=$(echo "$analysis_output" | \
        python3 -c "import sys, json; print(json.load(sys.stdin)['workload_type'])")
    
    log "Analysis complete:"
    log "  Workload type: $WORKLOAD_TYPE"
    log "  Recommended swap size: ${RECOMMENDED_SWAP_SIZE}MB"
    log "  Recommended swappiness: $RECOMMENDED_SWAPPINESS"
}

# Configure optimal swap
configure_swap() {
    local swap_type="${1:-auto}"
    local swap_size="${2:-$RECOMMENDED_SWAP_SIZE}"
    
    log "Configuring swap (type: $swap_type, size: ${swap_size}MB)"
    
    # Determine swap type if auto
    if [[ "$swap_type" == "auto" ]]; then
        swap_type=$(determine_swap_type)
    fi
    
    case "$swap_type" in
        partition)
            configure_partition_swap "$swap_size"
            ;;
        file)
            configure_file_swap "$swap_size"
            ;;
        zram)
            configure_zram_swap "$swap_size"
            ;;
        zswap)
            configure_zswap
            ;;
        *)
            error "Unknown swap type: $swap_type"
            ;;
    esac
    
    # Apply system parameters
    apply_system_parameters
    
    # Verify configuration
    verify_swap_configuration
}

# Determine best swap type
determine_swap_type() {
    local swap_type="file"  # Default
    
    # Check for existing swap partition
    if blkid -t TYPE=swap &> /dev/null; then
        swap_type="partition"
    # Check available disk space
    elif [[ $(df -BG / | tail -1 | awk '{print $4}' | sed 's/G//') -lt 10 ]]; then
        # Less than 10GB free, use ZRAM
        swap_type="zram"
    # Check if SSD
    elif [[ -f /sys/block/sda/queue/rotational ]] && \
         [[ $(cat /sys/block/sda/queue/rotational) -eq 0 ]]; then
        # SSD detected, prefer ZRAM for databases
        if [[ "$WORKLOAD_TYPE" == "database" ]]; then
            swap_type="zram"
        fi
    fi
    
    echo "$swap_type"
}

# Configure partition swap
configure_partition_swap() {
    local size_mb="$1"
    
    log "Configuring partition swap"
    
    # Find swap partition
    local swap_device
    swap_device=$(blkid -t TYPE=swap -o device | head -1)
    
    if [[ -z "$swap_device" ]]; then
        error "No swap partition found"
    fi
    
    # Disable existing swap
    swapoff -a 2>/dev/null || true
    
    # Setup swap
    mkswap "$swap_device"
    swapon -p -1 "$swap_device"
    
    # Update fstab
    update_fstab "$swap_device" "partition"
    
    log "Partition swap configured on $swap_device"
}

# Configure file swap
configure_file_swap() {
    local size_mb="$1"
    local swap_file="/var/swap/swapfile"
    
    log "Configuring file swap (${size_mb}MB)"
    
    # Create swap directory
    mkdir -p "$(dirname "$swap_file")"
    
    # Remove existing swap file if present
    if [[ -f "$swap_file" ]]; then
        swapoff "$swap_file" 2>/dev/null || true
        rm -f "$swap_file"
    fi
    
    # Create swap file
    log "Creating swap file..."
    dd if=/dev/zero of="$swap_file" bs=1M count="$size_mb" status=progress
    
    # Set permissions
    chmod 600 "$swap_file"
    
    # Setup swap
    mkswap "$swap_file"
    swapon -p -1 "$swap_file"
    
    # Update fstab
    update_fstab "$swap_file" "file"
    
    log "File swap configured at $swap_file"
}

# Configure ZRAM swap
configure_zram_swap() {
    local size_mb="$1"
    
    log "Configuring ZRAM swap (${size_mb}MB)"
    
    # Load module
    modprobe zram num_devices=1
    
    # Configure compression algorithm
    echo lz4 > /sys/block/zram0/comp_algorithm
    
    # Set size
    echo "${size_mb}M" > /sys/block/zram0/disksize
    
    # Create swap
    mkswap /dev/zram0
    swapon -p 5 /dev/zram0
    
    # Create systemd service
    create_zram_service "$size_mb"
    
    log "ZRAM swap configured"
}

# Configure ZSWAP
configure_zswap() {
    log "Configuring ZSWAP"
    
    # Enable zswap
    echo 1 > /sys/module/zswap/parameters/enabled
    echo lz4 > /sys/module/zswap/parameters/compressor
    echo 20 > /sys/module/zswap/parameters/max_pool_percent
    
    # Update GRUB
    update_grub_for_zswap
    
    log "ZSWAP configured (requires reboot to fully activate)"
}

# Apply system parameters
apply_system_parameters() {
    log "Applying system parameters"
    
    # Apply recommended swappiness
    echo "$RECOMMENDED_SWAPPINESS" > /proc/sys/vm/swappiness
    
    # Apply other parameters based on workload
    case "$WORKLOAD_TYPE" in
        database)
            echo 50 > /proc/sys/vm/vfs_cache_pressure
            echo 5 > /proc/sys/vm/dirty_ratio
            echo 2 > /proc/sys/vm/dirty_background_ratio
            ;;
        webserver)
            echo 80 > /proc/sys/vm/vfs_cache_pressure
            echo 10 > /proc/sys/vm/dirty_ratio
            echo 5 > /proc/sys/vm/dirty_background_ratio
            ;;
        *)
            echo 100 > /proc/sys/vm/vfs_cache_pressure
            echo 15 > /proc/sys/vm/dirty_ratio
            echo 5 > /proc/sys/vm/dirty_background_ratio
            ;;
    esac
    
    # Calculate min_free_kbytes (1% of RAM, max 256MB)
    local total_ram_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    local min_free_kb=$((total_ram_kb / 100))
    if [[ $min_free_kb -gt 262144 ]]; then
        min_free_kb=262144
    fi
    echo "$min_free_kb" > /proc/sys/vm/min_free_kbytes
    
    # Make persistent
    cat > /etc/sysctl.d/99-swap-optimization.conf <<EOF
# Swap optimization parameters
# Generated by enterprise-swap-deploy.sh

vm.swappiness = $RECOMMENDED_SWAPPINESS
vm.vfs_cache_pressure = $(cat /proc/sys/vm/vfs_cache_pressure)
vm.dirty_ratio = $(cat /proc/sys/vm/dirty_ratio)
vm.dirty_background_ratio = $(cat /proc/sys/vm/dirty_background_ratio)
vm.min_free_kbytes = $min_free_kb
vm.watermark_scale_factor = 100
EOF
    
    sysctl -p /etc/sysctl.d/99-swap-optimization.conf
}

# Update fstab
update_fstab() {
    local device="$1"
    local type="$2"
    
    log "Updating /etc/fstab"
    
    # Backup fstab
    cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d-%H%M%S)"
    
    # Remove existing swap entries
    sed -i '/\sswap\s/d' /etc/fstab
    
    # Add new entry
    if [[ "$type" == "partition" ]]; then
        local uuid=$(blkid -s UUID -o value "$device")
        echo "UUID=$uuid none swap sw,pri=-1 0 0" >> /etc/fstab
    else
        echo "$device none swap sw,pri=-1 0 0" >> /etc/fstab
    fi
}

# Create ZRAM systemd service
create_zram_service() {
    local size_mb="$1"
    
    cat > /etc/systemd/system/zram-swap.service <<EOF
[Unit]
Description=Configure ZRAM swap device
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/configure-zram.sh $size_mb
ExecStop=/sbin/swapoff /dev/zram0

[Install]
WantedBy=multi-user.target
EOF
    
    cat > /usr/local/bin/configure-zram.sh <<'EOF'
#!/bin/bash
SIZE_MB=$1
modprobe zram
echo lz4 > /sys/block/zram0/comp_algorithm
echo "${SIZE_MB}M" > /sys/block/zram0/disksize
mkswap /dev/zram0
swapon -p 5 /dev/zram0
EOF
    
    chmod +x /usr/local/bin/configure-zram.sh
    systemctl daemon-reload
    systemctl enable zram-swap.service
}

# Update GRUB for ZSWAP
update_grub_for_zswap() {
    log "Updating GRUB configuration"
    
    # Backup
    cp /etc/default/grub "/etc/default/grub.bak.$(date +%Y%m%d-%H%M%S)"
    
    # Add zswap parameters
    sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 zswap.enabled=1 zswap.compressor=lz4 zswap.max_pool_percent=20"/' /etc/default/grub
    
    # Update GRUB
    update-grub
}

# Verify swap configuration
verify_swap_configuration() {
    log "Verifying swap configuration"
    
    # Check swap status
    if ! swapon --show | grep -q swap; then
        error "No swap configured"
    fi
    
    # Display swap info
    log "Current swap configuration:"
    swapon --show
    
    # Check parameters
    log "System parameters:"
    log "  Swappiness: $(cat /proc/sys/vm/swappiness)"
    log "  VFS cache pressure: $(cat /proc/sys/vm/vfs_cache_pressure)"
    log "  Min free kbytes: $(cat /proc/sys/vm/min_free_kbytes)"
    
    # Run health check
    python3 /usr/local/bin/swap-manager.py \
        --config "$CONFIG_FILE" \
        --action monitor
}

# Setup monitoring
setup_monitoring() {
    log "Setting up monitoring"
    
    # Create monitoring script
    cat > /usr/local/bin/swap-monitor.sh <<'EOF'
#!/bin/bash
# Continuous swap monitoring

while true; do
    # Get metrics
    SWAP_USED=$(free -b | grep Swap | awk '{print $3}')
    SWAP_TOTAL=$(free -b | grep Swap | awk '{print $2}')
    
    if [[ $SWAP_TOTAL -gt 0 ]]; then
        SWAP_PERCENT=$((SWAP_USED * 100 / SWAP_TOTAL))
        
        # Alert if swap usage is high
        if [[ $SWAP_PERCENT -gt 80 ]]; then
            logger -p warning "High swap usage: ${SWAP_PERCENT}%"
        fi
    fi
    
    sleep 60
done
EOF
    
    chmod +x /usr/local/bin/swap-monitor.sh
    
    # Create systemd service
    cat > /etc/systemd/system/swap-monitor.service <<EOF
[Unit]
Description=Swap usage monitor
After=multi-user.target

[Service]
Type=simple
ExecStart=/usr/local/bin/swap-monitor.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
    systemctl enable swap-monitor.service
    systemctl start swap-monitor.service
}

# Main execution
main() {
    local action="${1:-deploy}"
    
    case "$action" in
        deploy)
            check_requirements
            analyze_system
            configure_swap "${2:-auto}" "${3:-}"
            setup_monitoring
            log "Swap deployment completed successfully"
            ;;
        analyze)
            check_requirements
            analyze_system
            ;;
        optimize)
            check_requirements
            python3 /usr/local/bin/swap-manager.py \
                --config "$CONFIG_FILE" \
                --action optimize
            ;;
        status)
            swapon --show
            free -h
            ;;
        help|*)
            cat <<EOF
Usage: $0 [action] [options]

Actions:
    deploy [type] [size]  - Deploy swap configuration
    analyze              - Analyze system only
    optimize             - Auto-optimize swap
    status               - Show current status
    help                 - Show this help

Swap types:
    auto      - Automatically determine best type
    partition - Use swap partition
    file      - Use swap file
    zram      - Use compressed RAM swap
    zswap     - Use kernel swap compression

Examples:
    $0 deploy              # Auto-deploy with recommendations
    $0 deploy file 8192    # Deploy 8GB file swap
    $0 deploy zram         # Deploy ZRAM with recommended size
EOF
            ;;
    esac
}

# Execute main function
main "$@"
```

## Memory Monitoring Dashboard

### Grafana Dashboard Configuration

```json
{
  "dashboard": {
    "title": "Enterprise Memory and Swap Management",
    "uid": "memory-swap-dashboard",
    "panels": [
      {
        "title": "Memory Usage Overview",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
        "targets": [
          {
            "expr": "memory_usage_bytes{type=\"used\"} / memory_usage_bytes{type=\"total\"} * 100",
            "legendFormat": "Memory Usage %"
          },
          {
            "expr": "swap_usage_bytes{device=\"used\"} / swap_usage_bytes{device=\"total\"} * 100",
            "legendFormat": "Swap Usage %"
          }
        ]
      },
      {
        "title": "Memory Pressure Score",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
        "targets": [
          {
            "expr": "memory_pressure_score",
            "legendFormat": "Pressure Score"
          }
        ],
        "thresholds": [
          {"value": 30, "color": "green"},
          {"value": 50, "color": "yellow"},
          {"value": 70, "color": "red"}
        ]
      },
      {
        "title": "Swap I/O Activity",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
        "targets": [
          {
            "expr": "rate(swap_io_rate_bytes_per_second{direction=\"in\"}[5m])",
            "legendFormat": "Swap In"
          },
          {
            "expr": "rate(swap_io_rate_bytes_per_second{direction=\"out\"}[5m])",
            "legendFormat": "Swap Out"
          }
        ]
      },
      {
        "title": "Top Memory Consumers",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
        "type": "table",
        "targets": [
          {
            "expr": "topk(10, process_memory_rss_bytes)",
            "format": "table"
          }
        ]
      }
    ]
  }
}
```

## Troubleshooting Common Issues

### High Swap Usage

```bash
#!/bin/bash
# diagnose-swap-usage.sh - Diagnose high swap usage

echo "=== Swap Usage Diagnosis ==="
echo

# Current swap status
echo "Current Swap Status:"
free -h
echo

# Top swap consumers
echo "Top Swap Consumers:"
for file in /proc/*/status; do
    if [[ -r $file ]]; then
        awk '/^Name:|^Pid:|^VmSwap:/ {printf "%s ", $2} END {print ""}' "$file"
    fi
done 2>/dev/null | grep -v " 0 kB" | sort -k3 -rn | head -20
echo

# Swap activity
echo "Recent Swap Activity:"
sar -W 1 5
echo

# Memory pressure
echo "Memory Pressure Indicators:"
cat /proc/pressure/memory
echo

# Recommendations
echo "Recommendations:"
python3 -c "
import psutil
mem = psutil.virtual_memory()
swap = psutil.swap_memory()

if swap.percent > 80:
    print('- CRITICAL: Swap usage exceeds 80%')
    print('- Consider adding more RAM or increasing swap space')
elif swap.percent > 50:
    print('- WARNING: Moderate swap usage')
    print('- Monitor closely and optimize memory usage')

if mem.available < mem.total * 0.1:
    print('- Low available memory - consider memory optimization')
"
```

### Memory Performance Tuning

```bash
#!/bin/bash
# memory-performance-tune.sh - Tune memory performance

# Huge pages configuration for databases
configure_hugepages() {
    local pages="${1:-1024}"  # Default 2GB (1024 * 2MB)
    
    echo "Configuring huge pages..."
    
    # Set number of huge pages
    echo "$pages" > /proc/sys/vm/nr_hugepages
    
    # Make persistent
    echo "vm.nr_hugepages = $pages" >> /etc/sysctl.d/99-hugepages.conf
    
    # Create hugetlbfs mount
    mkdir -p /dev/hugepages
    mount -t hugetlbfs none /dev/hugepages
    
    # Add to fstab
    echo "none /dev/hugepages hugetlbfs defaults 0 0" >> /etc/fstab
}

# NUMA optimization
optimize_numa() {
    echo "Optimizing NUMA settings..."
    
    # Set NUMA balancing
    echo 1 > /proc/sys/kernel/numa_balancing
    
    # Configure zone reclaim
    echo 0 > /proc/sys/vm/zone_reclaim_mode
    
    # Display NUMA topology
    numactl --hardware
}

# Transparent huge pages for applications
configure_thp() {
    local mode="${1:-madvise}"  # always, madvise, never
    
    echo "Configuring transparent huge pages: $mode"
    
    echo "$mode" > /sys/kernel/mm/transparent_hugepage/enabled
    echo "$mode" > /sys/kernel/mm/transparent_hugepage/defrag
    
    # Make persistent
    cat >> /etc/rc.local <<EOF
echo $mode > /sys/kernel/mm/transparent_hugepage/enabled
echo $mode > /sys/kernel/mm/transparent_hugepage/defrag
EOF
}

# Main tuning
echo "=== Memory Performance Tuning ==="
echo

# Detect workload type
if pgrep -x mysqld > /dev/null || pgrep -x postgres > /dev/null; then
    echo "Database workload detected"
    configure_hugepages 2048  # 4GB
    configure_thp "never"     # Disable THP for databases
elif pgrep -x java > /dev/null; then
    echo "Java application detected"
    configure_hugepages 1024  # 2GB
    configure_thp "madvise"
else
    echo "General workload"
    configure_thp "always"
fi

# NUMA optimization if available
if command -v numactl &> /dev/null; then
    optimize_numa
fi

echo "Tuning complete"
```

## Best Practices

### 1. Swap Sizing Guidelines
- **Small Systems (≤2GB RAM)**: 2x RAM
- **Medium Systems (4-8GB RAM)**: Equal to RAM
- **Large Systems (16-64GB RAM)**: 0.5x RAM
- **Very Large Systems (>64GB RAM)**: 16-32GB fixed
- **With Hibernation**: RAM + 10%

### 2. Swap Type Selection
- **Databases**: ZRAM or minimal swap
- **Web Servers**: File swap on SSD
- **Compute Workloads**: Large file/partition swap
- **Containers**: ZRAM with memory limits
- **Virtual Machines**: Disable swap in guest

### 3. Performance Optimization
- Monitor swap I/O patterns
- Use appropriate swappiness values
- Enable ZSWAP for compression
- Consider ZRAM for low-latency needs
- Regular memory leak detection

### 4. Monitoring Requirements
- Real-time memory pressure tracking
- Swap usage trends and patterns
- Per-process memory consumption
- OOM killer activity logging
- Predictive analytics for capacity

## Conclusion

Enterprise Linux swap and memory management requires sophisticated strategies that balance performance, reliability, and resource utilization. By implementing comprehensive monitoring, intelligent configuration, and automated optimization frameworks, organizations can ensure optimal memory performance across diverse workloads while preventing out-of-memory conditions and maintaining system stability.

The combination of advanced swap technologies, machine learning-based predictions, and automated management systems provides the foundation for resilient memory management in modern data centers, enabling systems to handle varying workloads efficiently while maintaining predictable performance characteristics.