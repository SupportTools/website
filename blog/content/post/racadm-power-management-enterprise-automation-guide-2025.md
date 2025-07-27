---
title: "Dell RACADM Power Management & Automation Guide 2025: Enterprise Energy Optimization & Cost Control"
date: 2025-09-09T10:00:00-08:00
draft: false
tags: ["racadm", "power-management", "dell-servers", "energy-efficiency", "automation", "idrac", "enterprise", "monitoring", "cost-optimization", "data-center", "server-management", "power-capping", "infrastructure", "devops"]
categories: ["Tech", "Misc", "racadm"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Dell server power management with RACADM in 2025. Comprehensive guide covering enterprise automation, power capping strategies, energy monitoring dashboards, cost optimization, and large-scale deployment best practices for data center efficiency."
---

# Dell RACADM Power Management & Automation Guide 2025: Enterprise Energy Optimization & Cost Control

Managing power consumption across hundreds or thousands of Dell servers requires sophisticated automation and monitoring strategies. This comprehensive guide transforms basic RACADM power commands into enterprise-scale energy management solutions that can save organizations millions in operational costs while ensuring performance and reliability.

## Table of Contents

- [Power Management Architecture Overview](#power-management-architecture-overview)
- [Advanced Power Monitoring Framework](#advanced-power-monitoring-framework)
- [Enterprise Power Capping Strategies](#enterprise-power-capping-strategies)
- [Automated Power Management System](#automated-power-management-system)
- [Real-Time Power Analytics Dashboard](#real-time-power-analytics-dashboard)
- [Dynamic Power Optimization](#dynamic-power-optimization)
- [Cost Analysis and Reporting](#cost-analysis-and-reporting)
- [Multi-Site Power Orchestration](#multi-site-power-orchestration)
- [Integration with Enterprise Systems](#integration-with-enterprise-systems)
- [Advanced Troubleshooting](#advanced-troubleshooting)
- [Best Practices and Guidelines](#best-practices-and-guidelines)

## Power Management Architecture Overview

### Understanding Dell Power Technologies

Modern Dell servers implement sophisticated power management capabilities:

```bash
# Comprehensive power feature discovery
#!/bin/bash

IDRAC_IP="$1"
USERNAME="$2"
PASSWORD="$3"

echo "=== Dell Power Management Feature Discovery ==="

# Check available power groups
racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD help | grep -i power

# Get power supply information
racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD get System.Power

# Check power monitoring capabilities
racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD get System.Power.PowerCapabilities

# List power profiles
racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD get BIOS.SysProfileSettings
```

### Power Management Components

Key components in Dell's power management ecosystem:

1. **iDRAC Power Monitoring**: Real-time consumption tracking
2. **Dynamic Power Capping**: Runtime power limit enforcement
3. **Power Profiles**: Predefined optimization strategies
4. **Multi-Node Power**: Chassis-level power coordination
5. **Thermal Management**: Temperature-based power adjustments

## Advanced Power Monitoring Framework

### Enterprise Power Collection System

Build a comprehensive power monitoring infrastructure:

```python
#!/usr/bin/env python3
"""
Enterprise Dell Power Monitoring System
Collects and stores power metrics from entire server fleet
"""

import asyncio
import aiohttp
import asyncssh
import json
import time
from datetime import datetime
from typing import Dict, List, Optional
import influxdb_client
from influxdb_client.client.write_api import SYNCHRONOUS
import prometheus_client
import logging
from dataclasses import dataclass
import yaml

@dataclass
class PowerMetrics:
    """Power consumption metrics"""
    timestamp: datetime
    server_id: str
    current_watts: float
    peak_watts: float
    min_watts: float
    cumulative_kwh: float
    inlet_temp: float
    power_cap: Optional[float]
    power_state: str
    psu_redundancy: str
    efficiency_percent: float

class PowerMonitor:
    """Enterprise power monitoring for Dell servers"""
    
    def __init__(self, config_file: str):
        with open(config_file, 'r') as f:
            self.config = yaml.safe_load(f)
        
        self.setup_logging()
        self.setup_metrics_storage()
        self.setup_prometheus()
        
    def setup_logging(self):
        """Configure logging"""
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        self.logger = logging.getLogger(__name__)
        
    def setup_metrics_storage(self):
        """Initialize InfluxDB connection"""
        self.influx_client = influxdb_client.InfluxDBClient(
            url=self.config['influxdb']['url'],
            token=self.config['influxdb']['token'],
            org=self.config['influxdb']['org']
        )
        self.write_api = self.influx_client.write_api(write_options=SYNCHRONOUS)
        
    def setup_prometheus(self):
        """Setup Prometheus metrics"""
        self.prom_power_current = prometheus_client.Gauge(
            'dell_server_power_watts',
            'Current power consumption in watts',
            ['server_id', 'datacenter', 'rack']
        )
        self.prom_power_cap = prometheus_client.Gauge(
            'dell_server_power_cap_watts',
            'Power cap setting in watts',
            ['server_id', 'datacenter', 'rack']
        )
        self.prom_inlet_temp = prometheus_client.Gauge(
            'dell_server_inlet_temp_celsius',
            'Inlet temperature in Celsius',
            ['server_id', 'datacenter', 'rack']
        )
        
    async def collect_power_metrics(self, server: Dict) -> Optional[PowerMetrics]:
        """Collect power metrics from a single server"""
        try:
            async with asyncssh.connect(
                server['idrac_ip'],
                username=server['username'],
                password=server['password'],
                known_hosts=None
            ) as conn:
                # Get current power consumption
                result = await conn.run('racadm get System.Power.PowerConsumption')
                current_power = self._parse_power_value(result.stdout)
                
                # Get power statistics
                result = await conn.run('racadm get System.Power.PowerStatistics')
                stats = self._parse_power_stats(result.stdout)
                
                # Get thermal data
                result = await conn.run('racadm get System.Thermal.InletTemp')
                inlet_temp = self._parse_temperature(result.stdout)
                
                # Get power cap settings
                result = await conn.run('racadm get System.Power.PowerCap')
                power_cap = self._parse_power_cap(result.stdout)
                
                # Get PSU status
                result = await conn.run('racadm get System.Power.RedundancyStatus')
                psu_redundancy = self._parse_redundancy(result.stdout)
                
                return PowerMetrics(
                    timestamp=datetime.utcnow(),
                    server_id=server['id'],
                    current_watts=current_power,
                    peak_watts=stats['peak'],
                    min_watts=stats['min'],
                    cumulative_kwh=stats['cumulative_kwh'],
                    inlet_temp=inlet_temp,
                    power_cap=power_cap,
                    power_state=stats['state'],
                    psu_redundancy=psu_redundancy,
                    efficiency_percent=stats['efficiency']
                )
                
        except Exception as e:
            self.logger.error(f"Failed to collect metrics from {server['id']}: {e}")
            return None
            
    def _parse_power_value(self, output: str) -> float:
        """Parse power consumption value"""
        for line in output.splitlines():
            if 'CurrentReading' in line:
                # Extract watts value
                watts = float(line.split('=')[1].strip().split()[0])
                return watts
        return 0.0
        
    def _parse_power_stats(self, output: str) -> Dict:
        """Parse power statistics"""
        stats = {
            'peak': 0.0,
            'min': 0.0,
            'cumulative_kwh': 0.0,
            'state': 'Unknown',
            'efficiency': 0.0
        }
        
        for line in output.splitlines():
            if 'PeakPower' in line:
                stats['peak'] = float(line.split('=')[1].strip().split()[0])
            elif 'MinPower' in line:
                stats['min'] = float(line.split('=')[1].strip().split()[0])
            elif 'CumulativeEnergy' in line:
                stats['cumulative_kwh'] = float(line.split('=')[1].strip().split()[0])
            elif 'PowerState' in line:
                stats['state'] = line.split('=')[1].strip()
            elif 'Efficiency' in line:
                stats['efficiency'] = float(line.split('=')[1].strip().rstrip('%'))
                
        return stats
        
    def _parse_temperature(self, output: str) -> float:
        """Parse inlet temperature"""
        for line in output.splitlines():
            if 'InletTemp' in line:
                temp = float(line.split('=')[1].strip().split()[0])
                return temp
        return 0.0
        
    def _parse_power_cap(self, output: str) -> Optional[float]:
        """Parse power cap setting"""
        for line in output.splitlines():
            if 'PowerCapValue' in line and 'Enabled=True' in output:
                cap = float(line.split('=')[1].strip().split()[0])
                return cap
        return None
        
    def _parse_redundancy(self, output: str) -> str:
        """Parse PSU redundancy status"""
        for line in output.splitlines():
            if 'RedundancyStatus' in line:
                return line.split('=')[1].strip()
        return 'Unknown'
        
    async def monitor_server_fleet(self):
        """Monitor entire server fleet"""
        while True:
            tasks = []
            
            for server in self.config['servers']:
                task = self.collect_power_metrics(server)
                tasks.append(task)
                
            # Collect metrics concurrently
            metrics_list = await asyncio.gather(*tasks)
            
            # Store and export metrics
            for metrics in metrics_list:
                if metrics:
                    self.store_metrics(metrics)
                    self.export_prometheus(metrics)
                    
            # Wait for next collection cycle
            await asyncio.sleep(self.config['collection_interval'])
            
    def store_metrics(self, metrics: PowerMetrics):
        """Store metrics in InfluxDB"""
        point = influxdb_client.Point("power_metrics") \
            .tag("server_id", metrics.server_id) \
            .tag("datacenter", self._get_datacenter(metrics.server_id)) \
            .tag("rack", self._get_rack(metrics.server_id)) \
            .field("current_watts", metrics.current_watts) \
            .field("peak_watts", metrics.peak_watts) \
            .field("min_watts", metrics.min_watts) \
            .field("cumulative_kwh", metrics.cumulative_kwh) \
            .field("inlet_temp", metrics.inlet_temp) \
            .field("efficiency_percent", metrics.efficiency_percent) \
            .time(metrics.timestamp)
            
        if metrics.power_cap:
            point.field("power_cap", metrics.power_cap)
            
        self.write_api.write(
            bucket=self.config['influxdb']['bucket'],
            record=point
        )
        
    def export_prometheus(self, metrics: PowerMetrics):
        """Export metrics to Prometheus"""
        labels = {
            'server_id': metrics.server_id,
            'datacenter': self._get_datacenter(metrics.server_id),
            'rack': self._get_rack(metrics.server_id)
        }
        
        self.prom_power_current.labels(**labels).set(metrics.current_watts)
        self.prom_inlet_temp.labels(**labels).set(metrics.inlet_temp)
        
        if metrics.power_cap:
            self.prom_power_cap.labels(**labels).set(metrics.power_cap)
            
    def _get_datacenter(self, server_id: str) -> str:
        """Extract datacenter from server ID"""
        # Implement your naming convention
        return server_id.split('-')[0]
        
    def _get_rack(self, server_id: str) -> str:
        """Extract rack from server ID"""
        # Implement your naming convention
        return server_id.split('-')[1]

# Configuration file example
config_example = """
influxdb:
  url: http://influxdb:8086
  token: your-token-here
  org: your-org
  bucket: power_metrics

collection_interval: 30  # seconds

servers:
  - id: DC1-R1-SRV001
    idrac_ip: 10.1.1.1
    username: root
    password: calvin
  - id: DC1-R1-SRV002
    idrac_ip: 10.1.1.2
    username: root
    password: calvin
"""

if __name__ == "__main__":
    monitor = PowerMonitor("power_config.yaml")
    
    # Start Prometheus metrics server
    prometheus_client.start_http_server(8000)
    
    # Run monitoring
    asyncio.run(monitor.monitor_server_fleet())
```

### Power Anomaly Detection

Implement intelligent anomaly detection for power consumption:

```python
#!/usr/bin/env python3
"""
Power Anomaly Detection System
Uses machine learning to detect unusual power consumption patterns
"""

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import pandas as pd
from datetime import datetime, timedelta
import joblib
import warnings
warnings.filterwarnings('ignore')

class PowerAnomalyDetector:
    """Detect anomalous power consumption patterns"""
    
    def __init__(self, training_days: int = 30):
        self.training_days = training_days
        self.models = {}
        self.scalers = {}
        self.alert_handler = AlertHandler()
        
    def train_model(self, server_id: str, historical_data: pd.DataFrame):
        """Train anomaly detection model for specific server"""
        # Feature engineering
        features = self._extract_features(historical_data)
        
        # Scale features
        scaler = StandardScaler()
        scaled_features = scaler.fit_transform(features)
        
        # Train Isolation Forest
        model = IsolationForest(
            contamination=0.01,  # 1% anomaly rate
            random_state=42,
            n_estimators=100
        )
        model.fit(scaled_features)
        
        # Store model and scaler
        self.models[server_id] = model
        self.scalers[server_id] = scaler
        
        # Save model to disk
        joblib.dump(model, f'models/power_anomaly_{server_id}.pkl')
        joblib.dump(scaler, f'models/power_scaler_{server_id}.pkl')
        
    def _extract_features(self, data: pd.DataFrame) -> np.ndarray:
        """Extract features for anomaly detection"""
        features = []
        
        # Power consumption features
        features.append(data['current_watts'].values)
        features.append(data['current_watts'].rolling(window=5).mean().values)
        features.append(data['current_watts'].rolling(window=5).std().values)
        
        # Temperature correlation
        features.append(data['inlet_temp'].values)
        power_temp_ratio = data['current_watts'] / (data['inlet_temp'] + 273.15)
        features.append(power_temp_ratio.values)
        
        # Time-based features
        hour_of_day = pd.to_datetime(data['timestamp']).dt.hour
        day_of_week = pd.to_datetime(data['timestamp']).dt.dayofweek
        features.append(hour_of_day.values)
        features.append(day_of_week.values)
        
        # Efficiency features
        if 'efficiency_percent' in data.columns:
            features.append(data['efficiency_percent'].values)
            
        # Rate of change
        power_change = data['current_watts'].diff()
        features.append(power_change.values)
        
        # Stack features
        feature_matrix = np.column_stack(features)
        
        # Handle NaN values
        feature_matrix = np.nan_to_num(feature_matrix, nan=0.0)
        
        return feature_matrix
        
    def detect_anomalies(self, server_id: str, current_data: pd.DataFrame) -> List[Dict]:
        """Detect anomalies in current power data"""
        if server_id not in self.models:
            return []
            
        # Extract features
        features = self._extract_features(current_data)
        scaled_features = self.scalers[server_id].transform(features)
        
        # Predict anomalies
        predictions = self.models[server_id].predict(scaled_features)
        anomaly_scores = self.models[server_id].score_samples(scaled_features)
        
        # Identify anomalies
        anomalies = []
        for idx, (pred, score) in enumerate(zip(predictions, anomaly_scores)):
            if pred == -1:  # Anomaly detected
                anomaly = {
                    'timestamp': current_data.iloc[idx]['timestamp'],
                    'server_id': server_id,
                    'power_watts': current_data.iloc[idx]['current_watts'],
                    'temperature': current_data.iloc[idx]['inlet_temp'],
                    'anomaly_score': abs(score),
                    'type': self._classify_anomaly(current_data.iloc[idx], score)
                }
                anomalies.append(anomaly)
                
        return anomalies
        
    def _classify_anomaly(self, data_point: pd.Series, score: float) -> str:
        """Classify type of power anomaly"""
        if data_point['current_watts'] > data_point['peak_watts'] * 0.95:
            return 'peak_power_exceeded'
        elif data_point['efficiency_percent'] < 80:
            return 'low_efficiency'
        elif abs(score) > 0.5:
            return 'unusual_pattern'
        else:
            return 'general_anomaly'
            
    def handle_anomalies(self, anomalies: List[Dict]):
        """Handle detected anomalies"""
        for anomaly in anomalies:
            # Log anomaly
            self.logger.warning(f"Power anomaly detected: {anomaly}")
            
            # Send alerts based on severity
            if anomaly['anomaly_score'] > 0.7:
                self.alert_handler.send_critical_alert(anomaly)
            elif anomaly['anomaly_score'] > 0.5:
                self.alert_handler.send_warning_alert(anomaly)
                
            # Take automated actions if configured
            if anomaly['type'] == 'peak_power_exceeded':
                self.apply_emergency_power_cap(anomaly['server_id'])
```

## Enterprise Power Capping Strategies

### Dynamic Power Cap Management

Implement intelligent power capping based on workload and environmental conditions:

```python
#!/usr/bin/env python3
"""
Dynamic Power Cap Management System
Automatically adjusts power caps based on workload and conditions
"""

import asyncio
import asyncssh
from typing import Dict, List, Optional
import yaml
import logging
from datetime import datetime
import statistics

class DynamicPowerCapManager:
    """Manage power caps dynamically across server fleet"""
    
    def __init__(self, config_file: str):
        with open(config_file, 'r') as f:
            self.config = yaml.safe_load(f)
            
        self.logger = logging.getLogger(__name__)
        self.cap_policies = self._load_policies()
        
    def _load_policies(self) -> Dict:
        """Load power capping policies"""
        return {
            'business_hours': {
                'start': 8,
                'end': 18,
                'cap_percentage': 90  # 90% of max during business hours
            },
            'off_hours': {
                'cap_percentage': 70  # 70% of max during off hours
            },
            'emergency': {
                'trigger_temp': 30,  # Celsius ambient
                'cap_percentage': 60  # Aggressive capping
            },
            'workload_based': {
                'high_cpu': 100,     # No cap for high CPU workloads
                'medium_cpu': 85,
                'low_cpu': 70
            }
        }
        
    async def apply_dynamic_caps(self):
        """Apply dynamic power caps based on conditions"""
        while True:
            try:
                # Get current conditions
                current_hour = datetime.now().hour
                ambient_temp = await self._get_datacenter_temperature()
                
                # Determine appropriate policy
                if ambient_temp > self.cap_policies['emergency']['trigger_temp']:
                    policy = 'emergency'
                elif (self.cap_policies['business_hours']['start'] <= 
                      current_hour < 
                      self.cap_policies['business_hours']['end']):
                    policy = 'business_hours'
                else:
                    policy = 'off_hours'
                    
                self.logger.info(f"Applying {policy} power cap policy")
                
                # Apply caps to all servers
                tasks = []
                for server in self.config['servers']:
                    task = self._apply_server_cap(server, policy)
                    tasks.append(task)
                    
                await asyncio.gather(*tasks)
                
                # Wait before next adjustment
                await asyncio.sleep(300)  # 5 minutes
                
            except Exception as e:
                self.logger.error(f"Error in dynamic cap management: {e}")
                await asyncio.sleep(60)
                
    async def _apply_server_cap(self, server: Dict, policy: str):
        """Apply power cap to individual server"""
        try:
            # Get server's maximum power rating
            max_power = await self._get_max_power(server)
            
            # Calculate cap based on policy
            if policy == 'workload_based':
                cpu_usage = await self._get_cpu_usage(server)
                if cpu_usage > 80:
                    cap_percentage = self.cap_policies['workload_based']['high_cpu']
                elif cpu_usage > 50:
                    cap_percentage = self.cap_policies['workload_based']['medium_cpu']
                else:
                    cap_percentage = self.cap_policies['workload_based']['low_cpu']
            else:
                cap_percentage = self.cap_policies[policy]['cap_percentage']
                
            cap_watts = int(max_power * cap_percentage / 100)
            
            # Apply the cap
            async with asyncssh.connect(
                server['idrac_ip'],
                username=server['username'],
                password=server['password'],
                known_hosts=None
            ) as conn:
                # Enable power capping
                await conn.run('racadm set System.Power.PowerCap.Enabled 1')
                
                # Set power cap value
                await conn.run(f'racadm set System.Power.PowerCap.Value {cap_watts}')
                
                self.logger.info(
                    f"Set power cap for {server['id']} to {cap_watts}W "
                    f"({cap_percentage}% of {max_power}W max)"
                )
                
        except Exception as e:
            self.logger.error(f"Failed to apply cap to {server['id']}: {e}")
            
    async def _get_max_power(self, server: Dict) -> int:
        """Get maximum power rating for server"""
        try:
            async with asyncssh.connect(
                server['idrac_ip'],
                username=server['username'],
                password=server['password'],
                known_hosts=None
            ) as conn:
                result = await conn.run('racadm get System.Power.PowerCapabilities')
                
                for line in result.stdout.splitlines():
                    if 'MaxPowerCapacity' in line:
                        return int(line.split('=')[1].strip().split()[0])
                        
        except Exception:
            # Return default if unable to get actual value
            return server.get('default_max_power', 750)
            
    async def _get_cpu_usage(self, server: Dict) -> float:
        """Get current CPU usage from server"""
        # Implementation depends on your monitoring system
        # This is a placeholder
        return 50.0
        
    async def _get_datacenter_temperature(self) -> float:
        """Get current datacenter ambient temperature"""
        # Implementation depends on your environmental monitoring
        # This is a placeholder
        return 22.0

class PowerCapOrchestrator:
    """Orchestrate power caps across multiple datacenters"""
    
    def __init__(self, datacenters: List[str]):
        self.datacenters = datacenters
        self.total_power_budget = self._get_total_budget()
        self.logger = logging.getLogger(__name__)
        
    def _get_total_budget(self) -> float:
        """Get total power budget across all datacenters"""
        # In reality, this would come from facility management
        return 1000000  # 1MW total
        
    async def balance_power_budget(self):
        """Balance power budget across datacenters"""
        while True:
            try:
                # Get current usage per datacenter
                dc_usage = await self._get_datacenter_usage()
                
                # Calculate remaining budget
                total_usage = sum(dc_usage.values())
                remaining_budget = self.total_power_budget - total_usage
                
                # Redistribute if needed
                if remaining_budget < self.total_power_budget * 0.1:  # Less than 10% headroom
                    await self._redistribute_power_budget(dc_usage)
                    
                await asyncio.sleep(60)  # Check every minute
                
            except Exception as e:
                self.logger.error(f"Error in budget balancing: {e}")
                await asyncio.sleep(60)
                
    async def _get_datacenter_usage(self) -> Dict[str, float]:
        """Get current power usage per datacenter"""
        usage = {}
        
        for dc in self.datacenters:
            # Query monitoring system for DC power usage
            # This is a placeholder
            usage[dc] = 250000  # 250kW
            
        return usage
        
    async def _redistribute_power_budget(self, current_usage: Dict[str, float]):
        """Redistribute power budget based on demand"""
        self.logger.info("Redistributing power budget due to high utilization")
        
        # Calculate new caps per datacenter
        for dc in self.datacenters:
            utilization = current_usage[dc] / (self.total_power_budget / len(self.datacenters))
            
            if utilization > 0.9:
                # This DC needs more power
                await self._increase_dc_budget(dc)
            elif utilization < 0.6:
                # This DC can give up some power
                await self._decrease_dc_budget(dc)
```

### Workload-Aware Power Management

Implement power management that adapts to workload characteristics:

```bash
#!/bin/bash
# Workload-aware power management script

IDRAC_IP="$1"
USERNAME="$2"
PASSWORD="$3"

# Function to get current workload metrics
get_workload_metrics() {
    local cpu_usage=$(racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
        get System.ServerOS.CPUUsage | grep "CurrentReading" | \
        awk '{print $3}')
    
    local memory_usage=$(racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
        get System.ServerOS.MemoryUsage | grep "CurrentReading" | \
        awk '{print $3}')
    
    local io_usage=$(racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
        get System.ServerOS.IOUsage | grep "CurrentReading" | \
        awk '{print $3}')
    
    echo "$cpu_usage $memory_usage $io_usage"
}

# Function to determine workload profile
determine_workload_profile() {
    local cpu=$1
    local mem=$2
    local io=$3
    
    if [[ $cpu -gt 80 ]]; then
        echo "compute-intensive"
    elif [[ $mem -gt 80 ]]; then
        echo "memory-intensive"
    elif [[ $io -gt 80 ]]; then
        echo "io-intensive"
    elif [[ $cpu -lt 20 && $mem -lt 20 && $io -lt 20 ]]; then
        echo "idle"
    else
        echo "balanced"
    fi
}

# Function to apply power profile
apply_power_profile() {
    local profile=$1
    
    case $profile in
        "compute-intensive")
            # Maximum performance for compute workloads
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set BIOS.SysProfileSettings.SysProfile PerfOptimized
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Enabled 0
            echo "Applied performance-optimized profile"
            ;;
        
        "memory-intensive")
            # Balanced performance with memory optimization
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set BIOS.SysProfileSettings.SysProfile PerfPerWattOptimized
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Enabled 1
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Value 600
            echo "Applied memory-optimized profile"
            ;;
        
        "io-intensive")
            # IO optimized with moderate power savings
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set BIOS.SysProfileSettings.SysProfile PerfPerWattOptimized
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Enabled 1
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Value 550
            echo "Applied IO-optimized profile"
            ;;
        
        "idle")
            # Aggressive power saving for idle systems
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set BIOS.SysProfileSettings.SysProfile DenseConfig
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Enabled 1
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Value 300
            echo "Applied power-saving profile"
            ;;
        
        "balanced")
            # Default balanced profile
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set BIOS.SysProfileSettings.SysProfile PerfPerWattOptimized
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Enabled 1
            racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
                set System.Power.PowerCap.Value 450
            echo "Applied balanced profile"
            ;;
    esac
}

# Main monitoring loop
while true; do
    echo "=== Workload-Aware Power Management Check ==="
    
    # Get current metrics
    metrics=($(get_workload_metrics))
    cpu=${metrics[0]}
    mem=${metrics[1]}
    io=${metrics[2]}
    
    echo "CPU: ${cpu}%, Memory: ${mem}%, IO: ${io}%"
    
    # Determine appropriate profile
    profile=$(determine_workload_profile $cpu $mem $io)
    echo "Detected workload profile: $profile"
    
    # Apply profile if changed
    current_profile=$(racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD \
        get BIOS.SysProfileSettings.SysProfile | grep "SysProfile=" | \
        cut -d'=' -f2)
    
    if [[ "$profile" != "$current_profile" ]]; then
        apply_power_profile $profile
    fi
    
    # Wait before next check
    sleep 300  # 5 minutes
done
```

## Automated Power Management System

### Complete Power Automation Framework

Build a comprehensive power management automation system:

```python
#!/usr/bin/env python3
"""
Enterprise Power Management Automation System
Complete framework for automated power optimization
"""

import asyncio
import asyncssh
from typing import Dict, List, Optional, Tuple
import yaml
import logging
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
import aioredis
import json

class PowerAutomationSystem:
    """Complete power management automation system"""
    
    def __init__(self, config_file: str):
        with open(config_file, 'r') as f:
            self.config = yaml.safe_load(f)
            
        self.logger = logging.getLogger(__name__)
        self.scheduler = AsyncIOScheduler()
        self.redis = None
        self.initialize_components()
        
    def initialize_components(self):
        """Initialize all system components"""
        # Setup scheduled tasks
        self.setup_scheduled_tasks()
        
        # Initialize subsystems
        self.power_monitor = PowerMonitor(self.config)
        self.cap_manager = DynamicPowerCapManager(self.config)
        self.anomaly_detector = PowerAnomalyDetector()
        self.cost_analyzer = PowerCostAnalyzer(self.config)
        self.alert_handler = AlertHandler(self.config)
        
    def setup_scheduled_tasks(self):
        """Setup automated scheduled tasks"""
        # Daily power report
        self.scheduler.add_job(
            self.generate_daily_report,
            CronTrigger(hour=7, minute=0),
            id='daily_power_report'
        )
        
        # Weekly optimization
        self.scheduler.add_job(
            self.optimize_power_settings,
            CronTrigger(day_of_week='sun', hour=2, minute=0),
            id='weekly_optimization'
        )
        
        # Monthly capacity planning
        self.scheduler.add_job(
            self.capacity_planning_report,
            CronTrigger(day=1, hour=9, minute=0),
            id='monthly_capacity'
        )
        
        # Real-time monitoring
        self.scheduler.add_job(
            self.real_time_monitoring,
            'interval',
            seconds=30,
            id='real_time_monitoring'
        )
        
    async def start(self):
        """Start the automation system"""
        self.logger.info("Starting Power Automation System")
        
        # Connect to Redis for state management
        self.redis = await aioredis.create_redis_pool(
            'redis://localhost',
            encoding='utf-8'
        )
        
        # Start scheduler
        self.scheduler.start()
        
        # Start main automation loops
        await asyncio.gather(
            self.power_optimization_loop(),
            self.anomaly_detection_loop(),
            self.cost_optimization_loop(),
            self.emergency_response_loop()
        )
        
    async def power_optimization_loop(self):
        """Main power optimization control loop"""
        while True:
            try:
                # Collect current metrics
                metrics = await self.power_monitor.collect_fleet_metrics()
                
                # Analyze and optimize
                optimizations = await self.analyze_optimization_opportunities(metrics)
                
                # Apply optimizations
                for optimization in optimizations:
                    await self.apply_optimization(optimization)
                    
                # Store state
                await self.redis.set(
                    'last_optimization',
                    json.dumps({
                        'timestamp': datetime.utcnow().isoformat(),
                        'optimizations_applied': len(optimizations)
                    })
                )
                
                await asyncio.sleep(300)  # 5 minutes
                
            except Exception as e:
                self.logger.error(f"Error in optimization loop: {e}")
                await asyncio.sleep(60)
                
    async def analyze_optimization_opportunities(self, metrics: Dict) -> List[Dict]:
        """Analyze metrics and identify optimization opportunities"""
        opportunities = []
        
        for server_id, server_metrics in metrics.items():
            # Check for over-provisioned servers
            if server_metrics['avg_utilization'] < 30:
                opportunities.append({
                    'server_id': server_id,
                    'type': 'reduce_power_cap',
                    'reason': 'low_utilization',
                    'current_cap': server_metrics['power_cap'],
                    'recommended_cap': server_metrics['avg_power'] * 1.2
                })
                
            # Check for thermal issues
            if server_metrics['inlet_temp'] > 27:
                opportunities.append({
                    'server_id': server_id,
                    'type': 'thermal_throttle',
                    'reason': 'high_temperature',
                    'current_temp': server_metrics['inlet_temp'],
                    'recommended_cap': server_metrics['power_cap'] * 0.8
                })
                
            # Check for inefficient operation
            if server_metrics['efficiency'] < 85:
                opportunities.append({
                    'server_id': server_id,
                    'type': 'efficiency_optimization',
                    'reason': 'low_efficiency',
                    'current_efficiency': server_metrics['efficiency'],
                    'action': 'consolidate_workload'
                })
                
        return opportunities
        
    async def apply_optimization(self, optimization: Dict):
        """Apply specific optimization"""
        server_id = optimization['server_id']
        
        try:
            if optimization['type'] == 'reduce_power_cap':
                await self.cap_manager.set_power_cap(
                    server_id,
                    int(optimization['recommended_cap'])
                )
                
            elif optimization['type'] == 'thermal_throttle':
                await self.cap_manager.apply_thermal_throttle(
                    server_id,
                    optimization['recommended_cap']
                )
                
            elif optimization['type'] == 'efficiency_optimization':
                await self.workload_manager.consolidate_workload(server_id)
                
            # Log optimization
            self.logger.info(
                f"Applied optimization: {optimization['type']} "
                f"to {server_id} - Reason: {optimization['reason']}"
            )
            
            # Record optimization
            await self.record_optimization(optimization)
            
        except Exception as e:
            self.logger.error(f"Failed to apply optimization: {e}")
            
    async def emergency_response_loop(self):
        """Handle emergency power situations"""
        while True:
            try:
                # Check for emergency conditions
                if await self.check_emergency_conditions():
                    await self.activate_emergency_response()
                    
                await asyncio.sleep(10)  # Check every 10 seconds
                
            except Exception as e:
                self.logger.error(f"Error in emergency response: {e}")
                await asyncio.sleep(10)
                
    async def check_emergency_conditions(self) -> bool:
        """Check for emergency power conditions"""
        # Check total power consumption vs capacity
        total_power = await self.get_total_power_consumption()
        capacity = await self.get_power_capacity()
        
        if total_power > capacity * 0.95:
            self.logger.critical(f"Power consumption critical: {total_power}W / {capacity}W")
            return True
            
        # Check for cascading failures
        failed_psus = await self.check_psu_failures()
        if failed_psus > 2:
            self.logger.critical(f"Multiple PSU failures detected: {failed_psus}")
            return True
            
        # Check datacenter temperature
        dc_temp = await self.get_datacenter_temperature()
        if dc_temp > 32:
            self.logger.critical(f"Datacenter temperature critical: {dc_temp}°C")
            return True
            
        return False
        
    async def activate_emergency_response(self):
        """Activate emergency power response"""
        self.logger.critical("ACTIVATING EMERGENCY POWER RESPONSE")
        
        # Send emergency alerts
        await self.alert_handler.send_emergency_alert({
            'type': 'power_emergency',
            'timestamp': datetime.utcnow(),
            'action': 'emergency_power_reduction'
        })
        
        # Apply emergency power caps
        emergency_cap = 300  # Watts
        
        servers = await self.get_all_servers()
        tasks = []
        
        for server in servers:
            # Skip critical servers
            if server['criticality'] != 'critical':
                task = self.cap_manager.set_power_cap(
                    server['id'],
                    emergency_cap
                )
                tasks.append(task)
                
        await asyncio.gather(*tasks)
        
        # Shutdown non-essential servers
        await self.shutdown_non_essential_servers()
        
        # Log emergency action
        await self.log_emergency_action()

class PowerCostAnalyzer:
    """Analyze and optimize power costs"""
    
    def __init__(self, config: Dict):
        self.config = config
        self.electricity_rates = self._load_electricity_rates()
        
    def _load_electricity_rates(self) -> Dict:
        """Load time-of-use electricity rates"""
        return {
            'peak': {
                'hours': [(9, 21)],  # 9 AM to 9 PM
                'rate': 0.15,  # $/kWh
                'days': ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
            },
            'off_peak': {
                'hours': [(21, 9)],  # 9 PM to 9 AM
                'rate': 0.08,  # $/kWh
                'days': ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
            },
            'weekend': {
                'rate': 0.10,  # $/kWh
                'days': ['saturday', 'sunday']
            }
        }
        
    async def calculate_current_cost(self, power_watts: float) -> float:
        """Calculate current electricity cost"""
        current_time = datetime.now()
        current_day = current_time.strftime('%A').lower()
        current_hour = current_time.hour
        
        # Determine rate
        if current_day in self.electricity_rates['weekend']['days']:
            rate = self.electricity_rates['weekend']['rate']
        else:
            # Check peak hours
            for start, end in self.electricity_rates['peak']['hours']:
                if start <= current_hour < end:
                    rate = self.electricity_rates['peak']['rate']
                    break
            else:
                rate = self.electricity_rates['off_peak']['rate']
                
        # Calculate cost (convert W to kW)
        cost_per_hour = (power_watts / 1000) * rate
        
        return cost_per_hour
        
    async def optimize_for_cost(self, servers: List[Dict]) -> List[Dict]:
        """Generate cost optimization recommendations"""
        recommendations = []
        current_time = datetime.now()
        
        # Check if we're approaching peak hours
        if current_time.hour == 8 and current_time.minute > 30:
            # Prepare for peak hours
            for server in servers:
                if server['workload_flexibility'] == 'high':
                    recommendations.append({
                        'server_id': server['id'],
                        'action': 'reduce_workload',
                        'reason': 'entering_peak_hours',
                        'estimated_savings': await self.estimate_savings(server)
                    })
                    
        # Check if we're in peak hours
        elif 9 <= current_time.hour < 21:
            for server in servers:
                if server['utilization'] < 50:
                    recommendations.append({
                        'server_id': server['id'],
                        'action': 'consolidate_or_shutdown',
                        'reason': 'low_utilization_peak_hours',
                        'estimated_savings': await self.estimate_savings(server)
                    })
                    
        return recommendations
```

## Real-Time Power Analytics Dashboard

### Web-Based Power Monitoring Dashboard

Create a real-time dashboard for power analytics:

```python
#!/usr/bin/env python3
"""
Real-Time Power Analytics Dashboard
Web-based monitoring interface for power management
"""

from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO, emit
import asyncio
import aiohttp
from datetime import datetime, timedelta
import pandas as pd
import json
import threading

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key'
socketio = SocketIO(app, cors_allowed_origins="*")

class PowerDashboard:
    """Real-time power monitoring dashboard"""
    
    def __init__(self):
        self.current_metrics = {}
        self.historical_data = []
        self.alerts = []
        self.start_background_tasks()
        
    def start_background_tasks(self):
        """Start background monitoring tasks"""
        thread = threading.Thread(target=self._run_async_tasks)
        thread.daemon = True
        thread.start()
        
    def _run_async_tasks(self):
        """Run async tasks in thread"""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self.monitor_power_metrics())
        
    async def monitor_power_metrics(self):
        """Continuously monitor power metrics"""
        while True:
            try:
                # Fetch latest metrics
                metrics = await self.fetch_power_metrics()
                self.current_metrics = metrics
                
                # Emit to connected clients
                socketio.emit('power_update', metrics)
                
                # Check for alerts
                alerts = await self.check_alerts(metrics)
                if alerts:
                    self.alerts.extend(alerts)
                    socketio.emit('new_alerts', alerts)
                    
                await asyncio.sleep(5)  # Update every 5 seconds
                
            except Exception as e:
                print(f"Error monitoring metrics: {e}")
                await asyncio.sleep(5)
                
    async def fetch_power_metrics(self) -> Dict:
        """Fetch current power metrics from all servers"""
        # This would connect to your actual monitoring system
        # Placeholder implementation
        return {
            'timestamp': datetime.utcnow().isoformat(),
            'total_power': 125000,  # Watts
            'server_count': 250,
            'average_power': 500,
            'peak_power': 175000,
            'efficiency': 87.5,
            'pue': 1.4,
            'cost_per_hour': 18.75,
            'carbon_footprint': 62.5  # kg CO2/hour
        }
        
    async def check_alerts(self, metrics: Dict) -> List[Dict]:
        """Check for alert conditions"""
        alerts = []
        
        if metrics['total_power'] > 150000:
            alerts.append({
                'severity': 'critical',
                'message': 'Total power consumption exceeds threshold',
                'value': metrics['total_power'],
                'threshold': 150000,
                'timestamp': datetime.utcnow().isoformat()
            })
            
        if metrics['efficiency'] < 85:
            alerts.append({
                'severity': 'warning',
                'message': 'Power efficiency below target',
                'value': metrics['efficiency'],
                'threshold': 85,
                'timestamp': datetime.utcnow().isoformat()
            })
            
        return alerts

# Initialize dashboard
dashboard = PowerDashboard()

@app.route('/')
def index():
    """Main dashboard page"""
    return render_template('power_dashboard.html')

@app.route('/api/metrics/current')
def get_current_metrics():
    """Get current power metrics"""
    return jsonify(dashboard.current_metrics)

@app.route('/api/metrics/historical')
def get_historical_metrics():
    """Get historical power data"""
    hours = request.args.get('hours', 24, type=int)
    # Fetch from database
    return jsonify({'data': dashboard.historical_data[-hours*12:]})

@app.route('/api/servers')
def get_servers():
    """Get server power details"""
    # Fetch server-specific metrics
    servers = [
        {
            'id': 'DC1-R1-SRV001',
            'power': 450,
            'temperature': 22,
            'efficiency': 88,
            'status': 'normal'
        }
        # More servers...
    ]
    return jsonify(servers)

@app.route('/api/alerts')
def get_alerts():
    """Get recent alerts"""
    return jsonify(dashboard.alerts[-50:])

@socketio.on('connect')
def handle_connect():
    """Handle client connection"""
    emit('connected', {'data': 'Connected to power dashboard'})
    
@socketio.on('request_update')
def handle_update_request():
    """Handle manual update request"""
    emit('power_update', dashboard.current_metrics)

# HTML Template (power_dashboard.html)
dashboard_html = """
<!DOCTYPE html>
<html>
<head>
    <title>Power Management Dashboard</title>
    <script src="https://cdn.socket.io/4.5.0/socket.io.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gray-900 text-white">
    <div class="container mx-auto p-4">
        <h1 class="text-4xl font-bold mb-8">Power Management Dashboard</h1>
        
        <!-- Summary Cards -->
        <div class="grid grid-cols-4 gap-4 mb-8">
            <div class="bg-gray-800 p-6 rounded-lg">
                <h3 class="text-gray-400 text-sm">Total Power</h3>
                <p class="text-3xl font-bold" id="total-power">0 kW</p>
                <p class="text-green-500 text-sm">↓ 5% from yesterday</p>
            </div>
            <div class="bg-gray-800 p-6 rounded-lg">
                <h3 class="text-gray-400 text-sm">Efficiency</h3>
                <p class="text-3xl font-bold" id="efficiency">0%</p>
                <p class="text-yellow-500 text-sm">Target: 90%</p>
            </div>
            <div class="bg-gray-800 p-6 rounded-lg">
                <h3 class="text-gray-400 text-sm">Cost/Hour</h3>
                <p class="text-3xl font-bold" id="cost-hour">$0</p>
                <p class="text-red-500 text-sm">Peak hours</p>
            </div>
            <div class="bg-gray-800 p-6 rounded-lg">
                <h3 class="text-gray-400 text-sm">PUE</h3>
                <p class="text-3xl font-bold" id="pue">0.0</p>
                <p class="text-green-500 text-sm">Excellent</p>
            </div>
        </div>
        
        <!-- Charts -->
        <div class="grid grid-cols-2 gap-4 mb-8">
            <div class="bg-gray-800 p-6 rounded-lg">
                <h3 class="text-xl mb-4">Power Consumption Trend</h3>
                <canvas id="power-chart"></canvas>
            </div>
            <div class="bg-gray-800 p-6 rounded-lg">
                <h3 class="text-xl mb-4">Server Distribution</h3>
                <canvas id="distribution-chart"></canvas>
            </div>
        </div>
        
        <!-- Alerts -->
        <div class="bg-gray-800 p-6 rounded-lg">
            <h3 class="text-xl mb-4">Active Alerts</h3>
            <div id="alerts-container" class="space-y-2">
                <!-- Alerts will be inserted here -->
            </div>
        </div>
    </div>
    
    <script>
        const socket = io();
        
        // Initialize charts
        const powerChart = new Chart(document.getElementById('power-chart'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Power (kW)',
                    data: [],
                    borderColor: 'rgb(75, 192, 192)',
                    tension: 0.1
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
        
        // Update metrics
        socket.on('power_update', (data) => {
            document.getElementById('total-power').textContent = 
                (data.total_power / 1000).toFixed(1) + ' kW';
            document.getElementById('efficiency').textContent = 
                data.efficiency.toFixed(1) + '%';
            document.getElementById('cost-hour').textContent = 
                '$' + data.cost_per_hour.toFixed(2);
            document.getElementById('pue').textContent = 
                data.pue.toFixed(2);
                
            // Update chart
            const time = new Date().toLocaleTimeString();
            powerChart.data.labels.push(time);
            powerChart.data.datasets[0].data.push(data.total_power / 1000);
            
            // Keep last 20 points
            if (powerChart.data.labels.length > 20) {
                powerChart.data.labels.shift();
                powerChart.data.datasets[0].data.shift();
            }
            
            powerChart.update();
        });
        
        // Handle alerts
        socket.on('new_alerts', (alerts) => {
            const container = document.getElementById('alerts-container');
            alerts.forEach(alert => {
                const alertDiv = document.createElement('div');
                alertDiv.className = `p-4 rounded ${
                    alert.severity === 'critical' ? 'bg-red-900' : 'bg-yellow-900'
                }`;
                alertDiv.innerHTML = `
                    <p class="font-bold">${alert.message}</p>
                    <p class="text-sm">Value: ${alert.value} (Threshold: ${alert.threshold})</p>
                    <p class="text-xs text-gray-400">${alert.timestamp}</p>
                `;
                container.prepend(alertDiv);
            });
        });
    </script>
</body>
</html>
"""

if __name__ == '__main__':
    socketio.run(app, debug=True, port=5000)
```

## Dynamic Power Optimization

### AI-Driven Power Optimization

Implement machine learning for predictive power management:

```python
#!/usr/bin/env python3
"""
AI-Driven Power Optimization System
Uses machine learning for predictive power management
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
import tensorflow as tf
from tensorflow import keras
import joblib
from datetime import datetime, timedelta
import asyncio

class PowerOptimizationAI:
    """AI-driven power optimization system"""
    
    def __init__(self):
        self.power_predictor = None
        self.workload_classifier = None
        self.optimization_model = None
        self.load_or_train_models()
        
    def load_or_train_models(self):
        """Load existing models or train new ones"""
        try:
            # Load existing models
            self.power_predictor = joblib.load('models/power_predictor.pkl')
            self.workload_classifier = keras.models.load_model('models/workload_classifier.h5')
            self.optimization_model = joblib.load('models/optimization_model.pkl')
        except:
            # Train new models
            self.train_models()
            
    def train_models(self):
        """Train AI models for power optimization"""
        # Load historical data
        data = self.load_historical_data()
        
        # Train power prediction model
        self.train_power_predictor(data)
        
        # Train workload classifier
        self.train_workload_classifier(data)
        
        # Train optimization model
        self.train_optimization_model(data)
        
    def train_power_predictor(self, data: pd.DataFrame):
        """Train model to predict power consumption"""
        # Feature engineering
        features = ['cpu_usage', 'memory_usage', 'io_rate', 'network_traffic',
                   'inlet_temp', 'hour_of_day', 'day_of_week']
        
        X = data[features]
        y = data['power_consumption']
        
        # Split data
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42
        )
        
        # Train Random Forest
        self.power_predictor = RandomForestRegressor(
            n_estimators=100,
            max_depth=10,
            random_state=42
        )
        self.power_predictor.fit(X_train, y_train)
        
        # Evaluate
        score = self.power_predictor.score(X_test, y_test)
        print(f"Power predictor R² score: {score:.3f}")
        
        # Save model
        joblib.dump(self.power_predictor, 'models/power_predictor.pkl')
        
    def train_workload_classifier(self, data: pd.DataFrame):
        """Train neural network to classify workload patterns"""
        # Prepare sequences
        sequence_length = 24  # 24 hours of data
        features = ['cpu_usage', 'memory_usage', 'io_rate', 'power_consumption']
        
        sequences = []
        labels = []
        
        for i in range(len(data) - sequence_length):
            seq = data[features].iloc[i:i+sequence_length].values
            sequences.append(seq)
            labels.append(data['workload_type'].iloc[i+sequence_length])
            
        X = np.array(sequences)
        y = pd.get_dummies(labels).values
        
        # Build LSTM model
        model = keras.Sequential([
            keras.layers.LSTM(64, return_sequences=True, input_shape=(24, 4)),
            keras.layers.LSTM(32),
            keras.layers.Dense(16, activation='relu'),
            keras.layers.Dropout(0.2),
            keras.layers.Dense(y.shape[1], activation='softmax')
        ])
        
        model.compile(
            optimizer='adam',
            loss='categorical_crossentropy',
            metrics=['accuracy']
        )
        
        # Train
        model.fit(X, y, epochs=50, batch_size=32, validation_split=0.2)
        
        # Save
        model.save('models/workload_classifier.h5')
        self.workload_classifier = model
        
    async def predict_power_demand(self, server_metrics: Dict) -> float:
        """Predict future power demand"""
        # Prepare features
        features = pd.DataFrame([{
            'cpu_usage': server_metrics['cpu'],
            'memory_usage': server_metrics['memory'],
            'io_rate': server_metrics['io'],
            'network_traffic': server_metrics['network'],
            'inlet_temp': server_metrics['temperature'],
            'hour_of_day': datetime.now().hour,
            'day_of_week': datetime.now().weekday()
        }])
        
        # Predict
        predicted_power = self.power_predictor.predict(features)[0]
        
        return predicted_power
        
    async def optimize_power_allocation(self, servers: List[Dict]) -> Dict:
        """Optimize power allocation across servers"""
        # Collect predictions
        predictions = []
        
        for server in servers:
            pred = await self.predict_power_demand(server['metrics'])
            predictions.append({
                'server_id': server['id'],
                'predicted_power': pred,
                'priority': server['priority'],
                'current_power': server['current_power']
            })
            
        # Sort by priority and efficiency
        predictions.sort(key=lambda x: (x['priority'], -x['predicted_power']))
        
        # Allocate power budget
        total_budget = 100000  # 100kW total
        allocations = {}
        remaining_budget = total_budget
        
        for pred in predictions:
            allocated = min(pred['predicted_power'] * 1.1, remaining_budget)
            allocations[pred['server_id']] = allocated
            remaining_budget -= allocated
            
        return allocations

class PredictiveMaintenanceSystem:
    """Predict power-related failures before they occur"""
    
    def __init__(self):
        self.failure_predictor = self.build_failure_model()
        
    def build_failure_model(self):
        """Build model to predict power component failures"""
        model = keras.Sequential([
            keras.layers.Dense(128, activation='relu', input_shape=(20,)),
            keras.layers.Dropout(0.3),
            keras.layers.Dense(64, activation='relu'),
            keras.layers.Dropout(0.3),
            keras.layers.Dense(32, activation='relu'),
            keras.layers.Dense(3, activation='softmax')  # normal, warning, failure
        ])
        
        model.compile(
            optimizer='adam',
            loss='categorical_crossentropy',
            metrics=['accuracy']
        )
        
        return model
        
    async def predict_failures(self, server_data: Dict) -> Dict:
        """Predict potential power-related failures"""
        # Extract features
        features = self.extract_failure_features(server_data)
        
        # Predict
        prediction = self.failure_predictor.predict(features.reshape(1, -1))
        
        # Interpret results
        classes = ['normal', 'warning', 'failure']
        probabilities = dict(zip(classes, prediction[0]))
        
        # Generate recommendations
        if probabilities['failure'] > 0.7:
            recommendation = 'URGENT: Schedule immediate PSU replacement'
        elif probabilities['warning'] > 0.5:
            recommendation = 'Monitor closely, consider preventive maintenance'
        else:
            recommendation = 'System operating normally'
            
        return {
            'server_id': server_data['id'],
            'failure_probability': probabilities['failure'],
            'status': max(probabilities, key=probabilities.get),
            'recommendation': recommendation,
            'details': probabilities
        }
        
    def extract_failure_features(self, server_data: Dict) -> np.ndarray:
        """Extract features for failure prediction"""
        features = []
        
        # Power supply metrics
        features.extend([
            server_data['psu_efficiency'],
            server_data['psu_temperature'],
            server_data['psu_fan_speed'],
            server_data['psu_voltage_variance'],
            server_data['psu_current_ripple']
        ])
        
        # Historical patterns
        features.extend([
            server_data['power_cycles_24h'],
            server_data['max_power_spike_24h'],
            server_data['avg_power_variance'],
            server_data['thermal_events_count']
        ])
        
        # Component age and usage
        features.extend([
            server_data['psu_age_days'],
            server_data['total_power_on_hours'],
            server_data['load_cycles_count']
        ])
        
        # Environmental factors
        features.extend([
            server_data['avg_inlet_temp'],
            server_data['max_inlet_temp'],
            server_data['humidity_level'],
            server_data['altitude_correction']
        ])
        
        # Redundancy status
        features.extend([
            server_data['redundant_psu_count'],
            server_data['redundancy_status'],
            server_data['load_balancing_efficiency']
        ])
        
        return np.array(features)
```

## Cost Analysis and Reporting

### Comprehensive Cost Analytics

Build detailed cost analysis and reporting capabilities:

```python
#!/usr/bin/env python3
"""
Power Cost Analysis and Reporting System
Comprehensive cost tracking and optimization
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import matplotlib.pyplot as plt
import seaborn as sns
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, A4
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

class PowerCostAnalytics:
    """Comprehensive power cost analysis system"""
    
    def __init__(self, config: Dict):
        self.config = config
        self.rates = self.load_utility_rates()
        self.carbon_factors = self.load_carbon_factors()
        
    def load_utility_rates(self) -> Dict:
        """Load complex utility rate structures"""
        return {
            'time_of_use': {
                'summer': {
                    'peak': {'hours': [(12, 18)], 'rate': 0.25},
                    'partial_peak': {'hours': [(8, 12), (18, 23)], 'rate': 0.18},
                    'off_peak': {'hours': [(23, 8)], 'rate': 0.12}
                },
                'winter': {
                    'peak': {'hours': [(17, 20)], 'rate': 0.22},
                    'partial_peak': {'hours': [(8, 17), (20, 22)], 'rate': 0.16},
                    'off_peak': {'hours': [(22, 8)], 'rate': 0.11}
                }
            },
            'demand_charges': {
                'rate': 15.00,  # $/kW
                'measurement_period': 15  # minutes
            },
            'power_factor_penalty': {
                'threshold': 0.90,
                'penalty_rate': 0.02  # per 0.01 below threshold
            }
        }
        
    def calculate_comprehensive_cost(self, power_data: pd.DataFrame) -> Dict:
        """Calculate comprehensive power costs including all factors"""
        # Energy charges
        energy_cost = self.calculate_energy_charges(power_data)
        
        # Demand charges
        demand_cost = self.calculate_demand_charges(power_data)
        
        # Power factor penalties
        pf_penalty = self.calculate_power_factor_penalty(power_data)
        
        # Carbon cost (if applicable)
        carbon_cost = self.calculate_carbon_cost(power_data)
        
        # Total cost breakdown
        total_cost = energy_cost + demand_cost + pf_penalty + carbon_cost
        
        return {
            'total_cost': total_cost,
            'energy_charges': energy_cost,
            'demand_charges': demand_cost,
            'power_factor_penalty': pf_penalty,
            'carbon_cost': carbon_cost,
            'cost_per_server': total_cost / len(power_data['server_id'].unique()),
            'cost_per_kwh': total_cost / (power_data['power_kwh'].sum()),
            'breakdown': self.generate_cost_breakdown(power_data)
        }
        
    def calculate_energy_charges(self, data: pd.DataFrame) -> float:
        """Calculate time-of-use energy charges"""
        total_cost = 0.0
        
        # Determine season
        current_month = datetime.now().month
        season = 'summer' if 5 <= current_month <= 10 else 'winter'
        
        # Group by hour
        for index, row in data.iterrows():
            hour = row['timestamp'].hour
            power_kwh = row['power_kwh']
            
            # Find applicable rate
            rate = 0.0
            for period, details in self.rates['time_of_use'][season].items():
                for start, end in details['hours']:
                    if start <= hour < end:
                        rate = details['rate']
                        break
                        
            total_cost += power_kwh * rate
            
        return total_cost
        
    def calculate_demand_charges(self, data: pd.DataFrame) -> float:
        """Calculate demand charges based on peak usage"""
        # Find peak demand in measurement periods
        data['timestamp'] = pd.to_datetime(data['timestamp'])
        data.set_index('timestamp', inplace=True)
        
        # Resample to measurement periods
        period = f"{self.rates['demand_charges']['measurement_period']}T"
        demand_data = data['power_kw'].resample(period).max()
        
        # Find monthly peak
        monthly_peak = demand_data.max()
        
        # Calculate demand charge
        demand_charge = monthly_peak * self.rates['demand_charges']['rate']
        
        return demand_charge
        
    def generate_cost_optimization_report(self) -> str:
        """Generate comprehensive cost optimization report"""
        report = f"""
# Power Cost Optimization Report
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}

## Executive Summary

### Current Month Costs
- Total Cost: ${self.current_month_cost:,.2f}
- Projected Annual: ${self.current_month_cost * 12:,.2f}
- Cost per Server: ${self.cost_per_server:,.2f}
- Average PUE: {self.average_pue:.2f}

### Cost Breakdown
- Energy Charges: ${self.energy_charges:,.2f} ({self.energy_percent:.1f}%)
- Demand Charges: ${self.demand_charges:,.2f} ({self.demand_percent:.1f}%)
- Power Factor Penalties: ${self.pf_penalties:,.2f}
- Carbon Costs: ${self.carbon_costs:,.2f}

## Optimization Opportunities

### 1. Demand Charge Reduction
- Current Peak Demand: {self.peak_demand:.0f} kW
- Potential Reduction: {self.demand_reduction:.0f} kW
- Annual Savings: ${self.demand_savings:,.2f}

**Recommendations:**
- Implement load shifting during peak periods
- Deploy battery storage for peak shaving
- Optimize workload scheduling

### 2. Time-of-Use Optimization
- Peak Hour Usage: {self.peak_usage_percent:.1f}%
- Shiftable Load: {self.shiftable_load:.0f} kW

**Recommendations:**
- Move {self.shiftable_jobs} batch jobs to off-peak hours
- Implement automated workload scheduling
- Reduce cooling during off-peak periods

### 3. Power Factor Improvement
- Current Power Factor: {self.power_factor:.3f}
- Target Power Factor: 0.95
- Potential Savings: ${self.pf_savings:,.2f}/month

**Recommendations:**
- Install power factor correction capacitors
- Replace inefficient power supplies
- Balance loads across phases

### 4. Efficiency Improvements
- Current Efficiency: {self.current_efficiency:.1f}%
- Industry Best Practice: 90%
- Potential Savings: ${self.efficiency_savings:,.2f}/year

**Recommendations:**
- Consolidate underutilized servers
- Upgrade to high-efficiency PSUs
- Implement aggressive power capping

## Implementation Roadmap

### Phase 1 (0-3 months) - Quick Wins
1. Implement workload scheduling (${self.phase1_savings:,.2f} savings)
2. Adjust power caps based on utilization
3. Fix power factor issues

### Phase 2 (3-6 months) - Infrastructure
1. Deploy battery storage system
2. Upgrade inefficient equipment
3. Implement advanced monitoring

### Phase 3 (6-12 months) - Optimization
1. AI-driven workload placement
2. Dynamic cooling optimization
3. Renewable energy integration

## ROI Analysis

| Initiative | Investment | Annual Savings | Payback Period |
|------------|------------|----------------|----------------|
| Workload Scheduling | $5,000 | ${self.scheduling_savings:,.0f} | 2 months |
| Power Factor Correction | $25,000 | ${self.pf_annual_savings:,.0f} | 8 months |
| Battery Storage | $150,000 | ${self.battery_savings:,.0f} | 2.5 years |
| Efficiency Upgrades | $75,000 | ${self.upgrade_savings:,.0f} | 1.5 years |

## Environmental Impact

### Current State
- Annual CO₂ Emissions: {self.co2_tons:.1f} tons
- Carbon Cost: ${self.carbon_cost_annual:,.2f}
- Renewable Energy: {self.renewable_percent:.1f}%

### With Optimizations
- Reduced Emissions: {self.co2_reduction:.1f} tons/year
- Carbon Savings: ${self.carbon_savings:,.2f}/year
- Sustainability Score Improvement: +{self.sustainability_improvement:.0f}%

## Conclusion

Implementing the recommended optimizations can achieve:
- **{self.total_savings_percent:.0f}% reduction** in power costs
- **${self.total_annual_savings:,.0f}** annual savings
- **{self.co2_reduction_percent:.0f}% reduction** in carbon footprint

Next steps:
1. Approve Phase 1 initiatives
2. Conduct detailed battery storage feasibility study
3. Begin RFP process for efficiency upgrades
"""
        return report
        
    def generate_executive_dashboard(self):
        """Generate executive dashboard visualizations"""
        fig, axes = plt.subplots(2, 2, figsize=(15, 10))
        fig.suptitle('Power Cost Executive Dashboard', fontsize=16)
        
        # Cost trend
        ax1 = axes[0, 0]
        self.plot_cost_trend(ax1)
        
        # Cost breakdown pie chart
        ax2 = axes[0, 1]
        self.plot_cost_breakdown(ax2)
        
        # Demand vs time
        ax3 = axes[1, 0]
        self.plot_demand_profile(ax3)
        
        # Efficiency metrics
        ax4 = axes[1, 1]
        self.plot_efficiency_metrics(ax4)
        
        plt.tight_layout()
        plt.savefig('reports/executive_dashboard.png', dpi=300)
        
    async def send_cost_report(self, recipients: List[str]):
        """Send automated cost reports"""
        # Generate report
        report_content = self.generate_cost_optimization_report()
        
        # Create PDF
        pdf_path = self.create_pdf_report(report_content)
        
        # Generate dashboard
        self.generate_executive_dashboard()
        
        # Send email
        msg = MIMEMultipart()
        msg['Subject'] = f"Power Cost Report - {datetime.now().strftime('%B %Y')}"
        msg['From'] = self.config['email']['from']
        msg['To'] = ', '.join(recipients)
        
        # Email body
        body = """
        Please find attached the monthly power cost optimization report.
        
        Key Highlights:
        - Total monthly cost: ${:,.2f}
        - Identified savings: ${:,.2f}
        - Quick win opportunities: {}
        
        The full report includes detailed analysis and recommendations.
        """.format(
            self.current_month_cost,
            self.total_potential_savings,
            self.quick_wins_count
        )
        
        msg.attach(MIMEText(body, 'plain'))
        
        # Attach PDF report
        with open(pdf_path, 'rb') as f:
            attach = MIMEApplication(f.read(), _subtype="pdf")
            attach.add_header('Content-Disposition', 'attachment', 
                            filename='power_cost_report.pdf')
            msg.attach(attach)
            
        # Attach dashboard image
        with open('reports/executive_dashboard.png', 'rb') as f:
            attach = MIMEApplication(f.read(), _subtype="png")
            attach.add_header('Content-Disposition', 'attachment',
                            filename='executive_dashboard.png')
            msg.attach(attach)
            
        # Send
        smtp = smtplib.SMTP(self.config['email']['smtp_server'])
        smtp.send_message(msg)
        smtp.quit()
```

## Multi-Site Power Orchestration

### Global Power Management

Orchestrate power management across multiple data centers:

```python
#!/usr/bin/env python3
"""
Multi-Site Power Orchestration System
Coordinate power management across global data centers
"""

import asyncio
from typing import Dict, List, Optional
import aiohttp
import yaml
from datetime import datetime
import pytz
from geopy.distance import distance

class GlobalPowerOrchestrator:
    """Orchestrate power across multiple data centers globally"""
    
    def __init__(self, config_file: str):
        with open(config_file, 'r') as f:
            self.config = yaml.safe_load(f)
            
        self.datacenters = self.config['datacenters']
        self.initialize_connections()
        
    def initialize_connections(self):
        """Initialize connections to all data centers"""
        self.dc_clients = {}
        
        for dc in self.datacenters:
            self.dc_clients[dc['id']] = DatacenterClient(
                dc['api_endpoint'],
                dc['api_key']
            )
            
    async def coordinate_global_power(self):
        """Coordinate power usage across all sites"""
        while True:
            try:
                # Collect global state
                global_state = await self.collect_global_state()
                
                # Analyze and optimize
                optimization_plan = await self.generate_optimization_plan(global_state)
                
                # Execute plan
                await self.execute_optimization_plan(optimization_plan)
                
                # Wait before next cycle
                await asyncio.sleep(300)  # 5 minutes
                
            except Exception as e:
                self.logger.error(f"Error in global coordination: {e}")
                await asyncio.sleep(60)
                
    async def collect_global_state(self) -> Dict:
        """Collect power state from all datacenters"""
        tasks = []
        
        for dc_id, client in self.dc_clients.items():
            task = client.get_power_state()
            tasks.append(task)
            
        states = await asyncio.gather(*tasks)
        
        return {
            'timestamp': datetime.utcnow(),
            'datacenters': dict(zip(self.dc_clients.keys(), states)),
            'total_power': sum(s['current_power'] for s in states),
            'total_capacity': sum(s['capacity'] for s in states)
        }
        
    async def generate_optimization_plan(self, global_state: Dict) -> Dict:
        """Generate global optimization plan"""
        plan = {
            'workload_migrations': [],
            'power_adjustments': [],
            'cooling_optimizations': []
        }
        
        # Analyze each datacenter
        for dc_id, dc_state in global_state['datacenters'].items():
            dc_info = next(d for d in self.datacenters if d['id'] == dc_id)
            
            # Check time-of-use rates
            local_time = self.get_local_time(dc_info['timezone'])
            is_peak = self.is_peak_hours(local_time, dc_info['peak_hours'])
            
            if is_peak and dc_state['utilization'] < 70:
                # Consider workload migration
                target_dc = self.find_migration_target(dc_id, global_state)
                if target_dc:
                    plan['workload_migrations'].append({
                        'source': dc_id,
                        'target': target_dc,
                        'workload_percent': 30,
                        'reason': 'peak_hour_optimization'
                    })
                    
            # Check renewable energy availability
            if dc_state.get('renewable_available', 0) > 0:
                if dc_state['utilization'] < 80:
                    # Increase workload to use renewable energy
                    plan['power_adjustments'].append({
                        'datacenter': dc_id,
                        'action': 'increase_workload',
                        'target_utilization': 85,
                        'reason': 'renewable_energy_available'
                    })
                    
            # Cooling optimization based on weather
            if dc_state['outside_temp'] < 10:  # Cold weather
                plan['cooling_optimizations'].append({
                    'datacenter': dc_id,
                    'action': 'increase_free_cooling',
                    'expected_savings': dc_state['cooling_power'] * 0.3
                })
                
        return plan
        
    async def execute_optimization_plan(self, plan: Dict):
        """Execute the optimization plan"""
        # Execute workload migrations
        for migration in plan['workload_migrations']:
            await self.migrate_workload(
                migration['source'],
                migration['target'],
                migration['workload_percent']
            )
            
        # Execute power adjustments
        for adjustment in plan['power_adjustments']:
            await self.adjust_datacenter_power(
                adjustment['datacenter'],
                adjustment['action'],
                adjustment.get('target_utilization')
            )
            
        # Execute cooling optimizations
        for cooling in plan['cooling_optimizations']:
            await self.optimize_cooling(
                cooling['datacenter'],
                cooling['action']
            )
            
    async def migrate_workload(self, source_dc: str, target_dc: str, percent: float):
        """Migrate workload between datacenters"""
        self.logger.info(f"Migrating {percent}% workload from {source_dc} to {target_dc}")
        
        # Get workload details from source
        workloads = await self.dc_clients[source_dc].get_migratable_workloads()
        
        # Select workloads to migrate
        to_migrate = self.select_workloads_for_migration(workloads, percent)
        
        # Initiate migrations
        for workload in to_migrate:
            await self.dc_clients[source_dc].initiate_migration(
                workload['id'],
                target_dc
            )
            
    def find_migration_target(self, source_dc: str, global_state: Dict) -> Optional[str]:
        """Find optimal migration target datacenter"""
        source_info = next(d for d in self.datacenters if d['id'] == source_dc)
        candidates = []
        
        for dc_id, dc_state in global_state['datacenters'].items():
            if dc_id == source_dc:
                continue
                
            dc_info = next(d for d in self.datacenters if d['id'] == dc_id)
            
            # Check if target has capacity
            if dc_state['utilization'] > 80:
                continue
                
            # Check if in off-peak hours
            local_time = self.get_local_time(dc_info['timezone'])
            if self.is_peak_hours(local_time, dc_info['peak_hours']):
                continue
                
            # Calculate migration cost (network latency, bandwidth)
            migration_cost = self.calculate_migration_cost(source_info, dc_info)
            
            candidates.append({
                'dc_id': dc_id,
                'score': (100 - dc_state['utilization']) / migration_cost,
                'utilization': dc_state['utilization']
            })
            
        # Return best candidate
        if candidates:
            best = max(candidates, key=lambda x: x['score'])
            return best['dc_id']
            
        return None
        
    def calculate_migration_cost(self, source: Dict, target: Dict) -> float:
        """Calculate cost of migrating between datacenters"""
        # Geographic distance
        source_loc = (source['latitude'], source['longitude'])
        target_loc = (target['latitude'], target['longitude'])
        dist = distance(source_loc, target_loc).km
        
        # Network cost (simplified)
        bandwidth_cost = dist * 0.001  # $/GB/km
        
        # Time zone difference (affects real-time workloads)
        tz_diff = abs(pytz.timezone(source['timezone']).utcoffset(datetime.now()).hours -
                     pytz.timezone(target['timezone']).utcoffset(datetime.now()).hours)
        
        # Combined cost factor
        cost = (dist / 1000) + (tz_diff * 10) + bandwidth_cost
        
        return cost

class DatacenterClient:
    """Client for datacenter API communication"""
    
    def __init__(self, endpoint: str, api_key: str):
        self.endpoint = endpoint
        self.api_key = api_key
        self.session = aiohttp.ClientSession()
        
    async def get_power_state(self) -> Dict:
        """Get current power state of datacenter"""
        headers = {'Authorization': f'Bearer {self.api_key}'}
        
        async with self.session.get(
            f"{self.endpoint}/api/v1/power/state",
            headers=headers
        ) as response:
            return await response.json()
            
    async def get_migratable_workloads(self) -> List[Dict]:
        """Get list of workloads that can be migrated"""
        headers = {'Authorization': f'Bearer {self.api_key}'}
        
        async with self.session.get(
            f"{self.endpoint}/api/v1/workloads/migratable",
            headers=headers
        ) as response:
            return await response.json()
            
    async def initiate_migration(self, workload_id: str, target_dc: str):
        """Initiate workload migration"""
        headers = {'Authorization': f'Bearer {self.api_key}'}
        data = {
            'workload_id': workload_id,
            'target_datacenter': target_dc,
            'priority': 'power_optimization'
        }
        
        async with self.session.post(
            f"{self.endpoint}/api/v1/workloads/migrate",
            headers=headers,
            json=data
        ) as response:
            return await response.json()
```

## Integration with Enterprise Systems

### Enterprise Integration Framework

Integrate power management with existing enterprise systems:

```python
#!/usr/bin/env python3
"""
Enterprise Systems Integration
Connect power management with DCIM, ITSM, and monitoring platforms
"""

import asyncio
import aiohttp
from typing import Dict, List, Optional
import json
from datetime import datetime
import logging

class EnterpriseIntegration:
    """Integrate power management with enterprise systems"""
    
    def __init__(self, config: Dict):
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.setup_integrations()
        
    def setup_integrations(self):
        """Setup connections to enterprise systems"""
        # DCIM Integration
        self.dcim = DCIMIntegration(
            self.config['dcim']['endpoint'],
            self.config['dcim']['api_key']
        )
        
        # ServiceNow Integration
        self.servicenow = ServiceNowIntegration(
            self.config['servicenow']['instance'],
            self.config['servicenow']['username'],
            self.config['servicenow']['password']
        )
        
        # Monitoring Integration (Prometheus/Grafana)
        self.monitoring = MonitoringIntegration(
            self.config['monitoring']['prometheus_url'],
            self.config['monitoring']['grafana_url']
        )
        
        # VMware vCenter Integration
        self.vcenter = VCenterIntegration(
            self.config['vcenter']['host'],
            self.config['vcenter']['username'],
            self.config['vcenter']['password']
        )
        
    async def sync_with_dcim(self):
        """Sync power data with DCIM system"""
        # Get server inventory from DCIM
        servers = await self.dcim.get_server_inventory()
        
        # Update power configurations
        for server in servers:
            power_config = await self.get_power_configuration(server['asset_id'])
            await self.dcim.update_power_metrics(server['id'], power_config)
            
    async def create_service_tickets(self, issues: List[Dict]):
        """Create ServiceNow tickets for power issues"""
        for issue in issues:
            ticket = {
                'short_description': f"Power Issue: {issue['type']}",
                'description': issue['details'],
                'priority': self.map_priority(issue['severity']),
                'assignment_group': 'Data Center Operations',
                'category': 'Infrastructure',
                'subcategory': 'Power Management',
                'configuration_item': issue['server_id']
            }
            
            ticket_number = await self.servicenow.create_incident(ticket)
            self.logger.info(f"Created ticket {ticket_number} for {issue['type']}")
            
    async def update_monitoring_dashboards(self):
        """Update Grafana dashboards with power metrics"""
        # Create custom dashboard
        dashboard = {
            'title': 'Power Management Overview',
            'panels': [
                self.create_power_panel(),
                self.create_efficiency_panel(),
                self.create_cost_panel(),
                self.create_alert_panel()
            ]
        }
        
        await self.monitoring.create_dashboard(dashboard)
        
    async def optimize_vm_placement(self):
        """Optimize VM placement based on power efficiency"""
        # Get current VM distribution
        vms = await self.vcenter.get_all_vms()
        hosts = await self.vcenter.get_all_hosts()
        
        # Get power metrics for each host
        host_power = {}
        for host in hosts:
            power_data = await self.get_host_power_metrics(host['name'])
            host_power[host['id']] = power_data
            
        # Calculate optimal placement
        placement_plan = self.calculate_optimal_placement(vms, hosts, host_power)
        
        # Execute migrations
        for migration in placement_plan:
            await self.vcenter.migrate_vm(
                migration['vm_id'],
                migration['target_host'],
                'power_optimization'
            )

class DCIMIntegration:
    """Integration with Data Center Infrastructure Management"""
    
    def __init__(self, endpoint: str, api_key: str):
        self.endpoint = endpoint
        self.api_key = api_key
        
    async def get_server_inventory(self) -> List[Dict]:
        """Get complete server inventory from DCIM"""
        async with aiohttp.ClientSession() as session:
            headers = {'X-API-Key': self.api_key}
            
            async with session.get(
                f"{self.endpoint}/api/assets/servers",
                headers=headers
            ) as response:
                return await response.json()
                
    async def update_power_metrics(self, asset_id: str, metrics: Dict):
        """Update power metrics in DCIM"""
        async with aiohttp.ClientSession() as session:
            headers = {
                'X-API-Key': self.api_key,
                'Content-Type': 'application/json'
            }
            
            data = {
                'power_consumption': metrics['current_watts'],
                'power_capacity': metrics['max_watts'],
                'efficiency': metrics['efficiency'],
                'inlet_temperature': metrics['inlet_temp'],
                'power_state': metrics['state']
            }
            
            async with session.patch(
                f"{self.endpoint}/api/assets/{asset_id}/power",
                headers=headers,
                json=data
            ) as response:
                return await response.json()

class ServiceNowIntegration:
    """Integration with ServiceNow ITSM"""
    
    def __init__(self, instance: str, username: str, password: str):
        self.instance = instance
        self.auth = aiohttp.BasicAuth(username, password)
        
    async def create_incident(self, incident_data: Dict) -> str:
        """Create incident in ServiceNow"""
        async with aiohttp.ClientSession(auth=self.auth) as session:
            url = f"https://{self.instance}.service-now.com/api/now/table/incident"
            
            async with session.post(url, json=incident_data) as response:
                result = await response.json()
                return result['result']['number']
                
    async def update_cmdb(self, ci_data: Dict):
        """Update Configuration Management Database"""
        async with aiohttp.ClientSession(auth=self.auth) as session:
            url = f"https://{self.instance}.service-now.com/api/now/table/cmdb_ci_server"
            
            # Find CI by name
            params = {'sysparm_query': f"name={ci_data['name']}"}
            async with session.get(url, params=params) as response:
                result = await response.json()
                
            if result['result']:
                # Update existing CI
                ci_sys_id = result['result'][0]['sys_id']
                update_url = f"{url}/{ci_sys_id}"
                
                update_data = {
                    'u_power_consumption': ci_data['power_consumption'],
                    'u_power_efficiency': ci_data['efficiency'],
                    'u_power_cap_enabled': ci_data['cap_enabled'],
                    'u_power_cap_value': ci_data['cap_value']
                }
                
                async with session.patch(update_url, json=update_data) as response:
                    return await response.json()

class MonitoringIntegration:
    """Integration with Prometheus/Grafana monitoring stack"""
    
    def __init__(self, prometheus_url: str, grafana_url: str):
        self.prometheus_url = prometheus_url
        self.grafana_url = grafana_url
        
    async def push_metrics(self, metrics: List[Dict]):
        """Push metrics to Prometheus Pushgateway"""
        from prometheus_client import CollectorRegistry, Gauge, push_to_gateway
        
        registry = CollectorRegistry()
        
        # Create gauges for each metric
        power_gauge = Gauge('dell_server_power_watts', 
                           'Power consumption in watts',
                           ['server_id', 'datacenter'],
                           registry=registry)
        
        temp_gauge = Gauge('dell_server_inlet_temp_celsius',
                          'Inlet temperature in Celsius',
                          ['server_id', 'datacenter'],
                          registry=registry)
        
        efficiency_gauge = Gauge('dell_server_power_efficiency_percent',
                                'Power efficiency percentage',
                                ['server_id', 'datacenter'],
                                registry=registry)
        
        # Set metric values
        for metric in metrics:
            labels = {
                'server_id': metric['server_id'],
                'datacenter': metric['datacenter']
            }
            
            power_gauge.labels(**labels).set(metric['power_watts'])
            temp_gauge.labels(**labels).set(metric['inlet_temp'])
            efficiency_gauge.labels(**labels).set(metric['efficiency'])
            
        # Push to gateway
        push_to_gateway(f"{self.prometheus_url}/metrics/job/power_management",
                       registry=registry)
        
    async def create_dashboard(self, dashboard_config: Dict):
        """Create or update Grafana dashboard"""
        async with aiohttp.ClientSession() as session:
            headers = {
                'Authorization': f"Bearer {self.config['grafana_api_key']}",
                'Content-Type': 'application/json'
            }
            
            dashboard_json = {
                'dashboard': dashboard_config,
                'overwrite': True
            }
            
            async with session.post(
                f"{self.grafana_url}/api/dashboards/db",
                headers=headers,
                json=dashboard_json
            ) as response:
                return await response.json()

class VCenterIntegration:
    """Integration with VMware vCenter"""
    
    def __init__(self, host: str, username: str, password: str):
        from pyVim import connect
        from pyVmomi import vim
        
        self.si = connect.SmartConnectNoSSL(
            host=host,
            user=username,
            pwd=password
        )
        self.content = self.si.RetrieveContent()
        
    async def get_all_vms(self) -> List[Dict]:
        """Get all VMs with power metrics"""
        container = self.content.rootFolder
        view_type = [vim.VirtualMachine]
        recursive = True
        
        container_view = self.content.viewManager.CreateContainerView(
            container, view_type, recursive
        )
        
        vms = []
        for vm in container_view.view:
            if vm.runtime.powerState == "poweredOn":
                vms.append({
                    'id': vm._moId,
                    'name': vm.name,
                    'host': vm.runtime.host.name,
                    'cpu_usage': vm.summary.quickStats.overallCpuUsage,
                    'memory_usage': vm.summary.quickStats.guestMemoryUsage,
                    'power_state': vm.runtime.powerState
                })
                
        return vms
        
    async def migrate_vm(self, vm_id: str, target_host: str, reason: str):
        """Migrate VM to different host"""
        # Find VM and target host objects
        vm = self._get_obj([vim.VirtualMachine], vm_id)
        host = self._get_obj([vim.HostSystem], target_host)
        
        # Create migration spec
        relocate_spec = vim.vm.RelocateSpec()
        relocate_spec.host = host
        
        # Initiate migration
        task = vm.Relocate(relocate_spec)
        
        # Wait for completion
        while task.info.state not in [vim.TaskInfo.State.success,
                                      vim.TaskInfo.State.error]:
            await asyncio.sleep(1)
            
        if task.info.state == vim.TaskInfo.State.success:
            self.logger.info(f"Successfully migrated VM {vm_id} to {target_host}")
        else:
            self.logger.error(f"Failed to migrate VM: {task.info.error}")
```

## Advanced Troubleshooting

### Comprehensive Troubleshooting Tools

Build advanced troubleshooting capabilities:

```bash
#!/bin/bash
# Advanced RACADM Power Troubleshooting Script

IDRAC_IP="$1"
USERNAME="$2"
PASSWORD="$3"
OUTPUT_DIR="power_diagnostics_$(date +%Y%m%d_%H%M%S)"

mkdir -p "$OUTPUT_DIR"

echo "=== Dell Power Management Diagnostics ==="
echo "Collecting comprehensive power data..."

# Function to run RACADM command and save output
run_racadm() {
    local command="$1"
    local output_file="$2"
    echo "Running: $command"
    racadm -r $IDRAC_IP -u $USERNAME -p $PASSWORD $command > "$OUTPUT_DIR/$output_file" 2>&1
}

# Collect all power-related data
echo "1. Collecting power inventory..."
run_racadm "get System.Power" "power_inventory.txt"

# PSU detailed information
echo "2. Collecting PSU details..."
for i in {1..8}; do
    run_racadm "get System.Power.Supply.$i" "psu_${i}_details.txt"
done

# Power consumption history
echo "3. Collecting power consumption data..."
run_racadm "get System.Power.PowerConsumption" "power_consumption.txt"
run_racadm "get System.Power.PowerStatistics" "power_statistics.txt"

# Power cap configuration
echo "4. Collecting power cap settings..."
run_racadm "get System.Power.PowerCap" "power_cap_config.txt"

# Thermal data (affects power)
echo "5. Collecting thermal data..."
run_racadm "get System.Thermal" "thermal_summary.txt"
run_racadm "get System.Thermal.InletTemp" "inlet_temperature.txt"

# System profile settings
echo "6. Collecting system profile..."
run_racadm "get BIOS.SysProfileSettings" "system_profile.txt"

# Event log for power events
echo "7. Collecting power-related events..."
run_racadm "getraclog -s 500" | grep -i "power\|psu\|supply" > "$OUTPUT_DIR/power_events.txt"

# Advanced diagnostics
echo "8. Running advanced diagnostics..."

# Check for power redundancy issues
cat > "$OUTPUT_DIR/check_redundancy.sh" << 'EOF'
#!/bin/bash
echo "=== Power Redundancy Check ==="

# Parse PSU status
total_psus=0
active_psus=0
failed_psus=0

for file in psu_*_details.txt; do
    if [ -f "$file" ]; then
        total_psus=$((total_psus + 1))
        if grep -q "State=Present" "$file" && grep -q "PrimaryStatus=Ok" "$file"; then
            active_psus=$((active_psus + 1))
        elif grep -q "State=Present" "$file"; then
            failed_psus=$((failed_psus + 1))
        fi
    fi
done

echo "Total PSUs: $total_psus"
echo "Active PSUs: $active_psus"
echo "Failed PSUs: $failed_psus"

if [ $active_psus -lt 2 ]; then
    echo "WARNING: No power redundancy!"
elif [ $failed_psus -gt 0 ]; then
    echo "WARNING: Failed PSU detected - redundancy compromised"
else
    echo "Power redundancy: OK"
fi
EOF

chmod +x "$OUTPUT_DIR/check_redundancy.sh"
cd "$OUTPUT_DIR" && ./check_redundancy.sh > redundancy_check.txt

# Generate comprehensive report
cat > "$OUTPUT_DIR/power_diagnostic_report.txt" << EOF
Dell Server Power Diagnostics Report
Generated: $(date)
Server: $IDRAC_IP

=== SUMMARY ===
$(cat redundancy_check.txt)

=== CURRENT POWER CONSUMPTION ===
$(grep -A5 "CurrentReading" power_consumption.txt || echo "Unable to read power consumption")

=== POWER STATISTICS ===
$(grep -E "Peak|Min|Average" power_statistics.txt || echo "No statistics available")

=== POWER CAP STATUS ===
$(grep -E "Enabled|Value" power_cap_config.txt || echo "Power cap not configured")

=== THERMAL STATUS ===
$(grep "InletTemp" inlet_temperature.txt || echo "Temperature data unavailable")

=== RECENT POWER EVENTS ===
$(tail -20 power_events.txt || echo "No recent power events")

=== RECOMMENDATIONS ===
EOF

# Add recommendations based on findings
if grep -q "WARNING: No power redundancy" redundancy_check.txt; then
    echo "1. CRITICAL: Restore power redundancy immediately" >> power_diagnostic_report.txt
fi

if grep -q "Enabled=0" power_cap_config.txt; then
    echo "2. Consider enabling power capping for better control" >> power_diagnostic_report.txt
fi

inlet_temp=$(grep "InletTemp" inlet_temperature.txt | awk -F'=' '{print $2}' | awk '{print $1}')
if [ ! -z "$inlet_temp" ] && [ "$inlet_temp" -gt "27" ]; then
    echo "3. WARNING: High inlet temperature detected ($inlet_temp°C)" >> power_diagnostic_report.txt
fi

echo "
Diagnostic collection complete. Results saved in: $OUTPUT_DIR
Review power_diagnostic_report.txt for summary and recommendations.
"

# Create archive
tar -czf "${OUTPUT_DIR}.tar.gz" "$OUTPUT_DIR"
echo "Archive created: ${OUTPUT_DIR}.tar.gz"
```

## Best Practices and Guidelines

### Enterprise Power Management Best Practices

1. **Implement Tiered Power Management**
   - Critical servers: No power capping
   - Production servers: Conservative capping (90% of max)
   - Development/Test: Aggressive capping (70% of max)
   - Idle servers: Maximum power savings

2. **Establish Power Budget Governance**
   - Define power allocation per business unit
   - Implement chargeback based on consumption
   - Regular review of power allocations
   - Capacity planning integration

3. **Deploy Redundancy Monitoring**
   - Real-time PSU redundancy checks
   - Automated failover testing
   - Predictive failure analysis
   - Spare PSU inventory management

4. **Optimize for Efficiency**
   - Target PUE < 1.5
   - Regular efficiency audits
   - Workload consolidation
   - Temperature optimization

5. **Implement Progressive Power Policies**
   ```yaml
   power_policies:
     normal_operations:
       business_hours:
         cap_percentage: 100
         efficiency_target: 85
       after_hours:
         cap_percentage: 80
         efficiency_target: 90
     
     high_demand:
       trigger: "total_demand > 90%"
       actions:
         - reduce_dev_test_power: 50%
         - enable_demand_response: true
         - notify_operations: immediate
     
     emergency:
       trigger: "cooling_failure OR power_loss"
       actions:
         - shutdown_non_critical: true
         - maximum_power_cap: 60%
         - engage_backup_cooling: true
   ```

6. **Establish Monitoring and Alerting**
   - Sub-second power monitoring
   - Predictive analytics
   - Multi-channel alerting
   - Executive dashboards
   - Automated reporting

7. **Document Everything**
   - Power architecture diagrams
   - Runbooks for common issues
   - Change management procedures
   - Disaster recovery plans

This comprehensive guide transforms basic RACADM power management into a sophisticated enterprise energy optimization platform, enabling organizations to significantly reduce costs, improve efficiency, and maintain reliability across their Dell server infrastructure.