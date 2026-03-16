---
title: "Data Quality Management and Observability in Production: Comprehensive Monitoring, Validation, and Incident Response"
date: 2026-06-06T00:00:00-05:00
draft: false
description: "Complete guide to implementing enterprise-grade data quality management and observability systems, covering automated validation, real-time monitoring, incident response, and data reliability engineering practices."
keywords: ["data quality", "data observability", "data monitoring", "data validation", "data reliability", "data engineering", "data governance", "data testing", "SLA monitoring", "incident response"]
tags: ["data-quality", "observability", "monitoring", "validation", "reliability", "governance", "testing", "production"]
categories: ["Data Engineering", "Data Quality", "Observability"]
author: "Support Tools Team"
canonical: "https://support.tools/blog/data-quality-management-observability-production/"
---

# Data Quality Management and Observability in Production: Comprehensive Monitoring, Validation, and Incident Response

Data quality and observability have become critical components of modern data infrastructure, directly impacting business decisions, regulatory compliance, and operational efficiency. As data systems grow in complexity and scale, implementing comprehensive data quality management and observability frameworks becomes essential for maintaining trust and reliability in data-driven organizations.

This comprehensive guide explores advanced techniques for implementing enterprise-grade data quality management, real-time observability, automated validation frameworks, and incident response procedures that ensure data reliability at scale.

## Understanding Data Quality Fundamentals

### Data Quality Dimensions and Metrics

Data quality encompasses multiple dimensions that must be continuously monitored and maintained in production environments. Understanding these dimensions enables organizations to build comprehensive quality frameworks.

```python
# Comprehensive data quality framework implementation
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import logging
import json
import asyncio
from abc import ABC, abstractmethod

@dataclass
class DataQualityRule:
    """Define data quality rules with metadata"""
    rule_id: str
    rule_name: str
    dimension: str  # completeness, accuracy, consistency, validity, uniqueness, timeliness
    severity: str  # critical, high, medium, low
    description: str
    threshold: float
    metric_type: str  # percentage, count, ratio
    enabled: bool = True
    tags: List[str] = field(default_factory=list)
    
@dataclass
class DataQualityResult:
    """Store data quality assessment results"""
    rule_id: str
    table_name: str
    column_name: Optional[str]
    metric_value: float
    threshold: float
    passed: bool
    execution_time: datetime
    row_count: int
    affected_rows: Optional[int] = None
    sample_failures: Optional[List[Dict]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

class DataQualityEngine:
    """Advanced data quality assessment engine"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.rules: Dict[str, DataQualityRule] = {}
        self.results_history: List[DataQualityResult] = []
        self.alert_handlers: List[callable] = []
        
    def register_rule(self, rule: DataQualityRule):
        """Register a data quality rule"""
        self.rules[rule.rule_id] = rule
        logging.info(f"Registered data quality rule: {rule.rule_name}")
    
    def assess_completeness(self, df: pd.DataFrame, column: str, 
                          rule: DataQualityRule) -> DataQualityResult:
        """Assess data completeness for specified column"""
        
        total_rows = len(df)
        null_count = df[column].isnull().sum()
        completeness_rate = (total_rows - null_count) / total_rows * 100
        
        passed = completeness_rate >= rule.threshold
        
        # Collect sample failures if needed
        sample_failures = None
        if not passed:
            null_rows = df[df[column].isnull()].head(10)
            sample_failures = null_rows.to_dict('records')
        
        return DataQualityResult(
            rule_id=rule.rule_id,
            table_name=getattr(df, 'name', 'unknown'),
            column_name=column,
            metric_value=completeness_rate,
            threshold=rule.threshold,
            passed=passed,
            execution_time=datetime.now(),
            row_count=total_rows,
            affected_rows=null_count,
            sample_failures=sample_failures
        )
    
    def assess_uniqueness(self, df: pd.DataFrame, columns: List[str],
                         rule: DataQualityRule) -> DataQualityResult:
        """Assess data uniqueness for specified columns"""
        
        total_rows = len(df)
        if len(columns) == 1:
            unique_count = df[columns[0]].nunique()
        else:
            unique_count = df[columns].drop_duplicates().shape[0]
        
        uniqueness_rate = unique_count / total_rows * 100
        passed = uniqueness_rate >= rule.threshold
        
        # Collect duplicate samples
        sample_failures = None
        if not passed:
            if len(columns) == 1:
                duplicates = df[df.duplicated(subset=columns, keep=False)]
            else:
                duplicates = df[df.duplicated(subset=columns, keep=False)]
            sample_failures = duplicates.head(10).to_dict('records')
        
        return DataQualityResult(
            rule_id=rule.rule_id,
            table_name=getattr(df, 'name', 'unknown'),
            column_name=', '.join(columns),
            metric_value=uniqueness_rate,
            threshold=rule.threshold,
            passed=passed,
            execution_time=datetime.now(),
            row_count=total_rows,
            affected_rows=total_rows - unique_count,
            sample_failures=sample_failures
        )
    
    def assess_validity(self, df: pd.DataFrame, column: str,
                       validation_function: callable, 
                       rule: DataQualityRule) -> DataQualityResult:
        """Assess data validity using custom validation function"""
        
        total_rows = len(df)
        valid_mask = df[column].apply(validation_function)
        valid_count = valid_mask.sum()
        validity_rate = valid_count / total_rows * 100
        
        passed = validity_rate >= rule.threshold
        
        # Collect invalid samples
        sample_failures = None
        if not passed:
            invalid_rows = df[~valid_mask].head(10)
            sample_failures = invalid_rows.to_dict('records')
        
        return DataQualityResult(
            rule_id=rule.rule_id,
            table_name=getattr(df, 'name', 'unknown'),
            column_name=column,
            metric_value=validity_rate,
            threshold=rule.threshold,
            passed=passed,
            execution_time=datetime.now(),
            row_count=total_rows,
            affected_rows=total_rows - valid_count,
            sample_failures=sample_failures
        )
    
    def assess_consistency(self, df: pd.DataFrame, 
                          consistency_rules: List[Dict],
                          rule: DataQualityRule) -> DataQualityResult:
        """Assess data consistency across columns or business rules"""
        
        total_rows = len(df)
        consistent_rows = 0
        inconsistent_samples = []
        
        for cr in consistency_rules:
            if cr['type'] == 'column_relationship':
                # Example: end_date >= start_date
                condition = cr['condition']
                mask = df.eval(condition)
                consistent_rows += mask.sum()
                
                if not mask.all():
                    inconsistent = df[~mask].head(5)
                    inconsistent_samples.extend(inconsistent.to_dict('records'))
            
            elif cr['type'] == 'business_rule':
                # Custom business logic
                rule_function = cr['function']
                mask = df.apply(rule_function, axis=1)
                consistent_rows += mask.sum()
                
                if not mask.all():
                    inconsistent = df[~mask].head(5)
                    inconsistent_samples.extend(inconsistent.to_dict('records'))
        
        consistency_rate = consistent_rows / (total_rows * len(consistency_rules)) * 100
        passed = consistency_rate >= rule.threshold
        
        return DataQualityResult(
            rule_id=rule.rule_id,
            table_name=getattr(df, 'name', 'unknown'),
            column_name='multiple',
            metric_value=consistency_rate,
            threshold=rule.threshold,
            passed=passed,
            execution_time=datetime.now(),
            row_count=total_rows,
            affected_rows=total_rows - (consistent_rows // len(consistency_rules)),
            sample_failures=inconsistent_samples[:10]
        )
    
    def run_assessment(self, df: pd.DataFrame, 
                      rules_to_run: Optional[List[str]] = None) -> List[DataQualityResult]:
        """Run comprehensive data quality assessment"""
        
        results = []
        rules_to_execute = rules_to_run or list(self.rules.keys())
        
        for rule_id in rules_to_execute:
            if rule_id not in self.rules:
                logging.warning(f"Rule {rule_id} not found")
                continue
                
            rule = self.rules[rule_id]
            if not rule.enabled:
                continue
            
            try:
                if rule.dimension == 'completeness':
                    result = self.assess_completeness(df, rule.metadata['column'], rule)
                elif rule.dimension == 'uniqueness':
                    result = self.assess_uniqueness(df, rule.metadata['columns'], rule)
                elif rule.dimension == 'validity':
                    result = self.assess_validity(
                        df, rule.metadata['column'], 
                        rule.metadata['validation_function'], rule
                    )
                elif rule.dimension == 'consistency':
                    result = self.assess_consistency(
                        df, rule.metadata['consistency_rules'], rule
                    )
                
                results.append(result)
                self.results_history.append(result)
                
                # Trigger alerts for failed rules
                if not result.passed and rule.severity in ['critical', 'high']:
                    self._trigger_alerts(result, rule)
                    
            except Exception as e:
                logging.error(f"Error executing rule {rule_id}: {e}")
        
        return results
    
    def _trigger_alerts(self, result: DataQualityResult, rule: DataQualityRule):
        """Trigger alerts for failed data quality rules"""
        for handler in self.alert_handlers:
            try:
                handler(result, rule)
            except Exception as e:
                logging.error(f"Alert handler failed: {e}")

# Advanced data profiling and statistical analysis
class DataProfiler:
    """Comprehensive data profiling for quality assessment"""
    
    def __init__(self):
        self.profile_cache = {}
    
    def generate_comprehensive_profile(self, df: pd.DataFrame, 
                                     table_name: str) -> Dict[str, Any]:
        """Generate comprehensive data profile"""
        
        profile = {
            'table_name': table_name,
            'profiling_timestamp': datetime.now().isoformat(),
            'row_count': len(df),
            'column_count': len(df.columns),
            'memory_usage_mb': df.memory_usage(deep=True).sum() / 1024 / 1024,
            'columns': {}
        }
        
        for column in df.columns:
            profile['columns'][column] = self._profile_column(df[column], column)
        
        # Cross-column analysis
        profile['relationships'] = self._analyze_relationships(df)
        profile['anomalies'] = self._detect_anomalies(df)
        
        return profile
    
    def _profile_column(self, series: pd.Series, column_name: str) -> Dict[str, Any]:
        """Profile individual column"""
        
        column_profile = {
            'name': column_name,
            'data_type': str(series.dtype),
            'null_count': series.isnull().sum(),
            'null_percentage': series.isnull().sum() / len(series) * 100,
            'unique_count': series.nunique(),
            'uniqueness_percentage': series.nunique() / len(series) * 100,
        }
        
        # Numeric column analysis
        if pd.api.types.is_numeric_dtype(series):
            column_profile.update({
                'min': series.min(),
                'max': series.max(),
                'mean': series.mean(),
                'median': series.median(),
                'std': series.std(),
                'q25': series.quantile(0.25),
                'q75': series.quantile(0.75),
                'outlier_count': self._count_outliers(series),
                'zero_count': (series == 0).sum(),
                'negative_count': (series < 0).sum()
            })
        
        # String column analysis
        elif pd.api.types.is_string_dtype(series) or series.dtype == 'object':
            non_null_series = series.dropna()
            if len(non_null_series) > 0:
                column_profile.update({
                    'avg_length': non_null_series.astype(str).str.len().mean(),
                    'min_length': non_null_series.astype(str).str.len().min(),
                    'max_length': non_null_series.astype(str).str.len().max(),
                    'empty_string_count': (non_null_series == '').sum(),
                    'whitespace_only_count': non_null_series.astype(str).str.strip().eq('').sum(),
                    'common_patterns': self._identify_patterns(non_null_series)
                })
        
        # Datetime column analysis
        elif pd.api.types.is_datetime64_any_dtype(series):
            non_null_series = series.dropna()
            if len(non_null_series) > 0:
                column_profile.update({
                    'min_date': non_null_series.min(),
                    'max_date': non_null_series.max(),
                    'date_range_days': (non_null_series.max() - non_null_series.min()).days,
                    'future_dates_count': (non_null_series > datetime.now()).sum()
                })
        
        # Frequency analysis for all types
        if series.nunique() <= 50:  # Only for low cardinality
            value_counts = series.value_counts().head(10)
            column_profile['top_values'] = value_counts.to_dict()
        
        return column_profile
    
    def _count_outliers(self, series: pd.Series) -> int:
        """Count statistical outliers using IQR method"""
        if not pd.api.types.is_numeric_dtype(series):
            return 0
        
        q1 = series.quantile(0.25)
        q3 = series.quantile(0.75)
        iqr = q3 - q1
        lower_bound = q1 - 1.5 * iqr
        upper_bound = q3 + 1.5 * iqr
        
        return ((series < lower_bound) | (series > upper_bound)).sum()
    
    def _identify_patterns(self, series: pd.Series) -> Dict[str, int]:
        """Identify common patterns in string data"""
        import re
        
        patterns = {
            'email': r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$',
            'phone': r'^\+?1?[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}$',
            'url': r'^https?://[^\s/$.?#].[^\s]*$',
            'numeric_string': r'^\d+$',
            'alphanumeric': r'^[a-zA-Z0-9]+$',
            'uuid': r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        }
        
        pattern_counts = {}
        for pattern_name, pattern in patterns.items():
            matches = series.astype(str).str.match(pattern).sum()
            if matches > 0:
                pattern_counts[pattern_name] = matches
        
        return pattern_counts
    
    def _analyze_relationships(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Analyze relationships between columns"""
        
        relationships = {
            'correlations': {},
            'dependencies': {},
            'foreign_key_candidates': []
        }
        
        # Correlation analysis for numeric columns
        numeric_columns = df.select_dtypes(include=[np.number]).columns
        if len(numeric_columns) > 1:
            correlation_matrix = df[numeric_columns].corr()
            high_correlations = []
            
            for i, col1 in enumerate(numeric_columns):
                for j, col2 in enumerate(numeric_columns[i+1:], i+1):
                    corr_value = correlation_matrix.loc[col1, col2]
                    if abs(corr_value) > 0.7:  # High correlation threshold
                        high_correlations.append({
                            'column1': col1,
                            'column2': col2,
                            'correlation': corr_value
                        })
            
            relationships['correlations'] = high_correlations
        
        # Functional dependency detection
        for col in df.columns:
            if df[col].nunique() < len(df) * 0.8:  # Low cardinality column
                for other_col in df.columns:
                    if col != other_col:
                        # Check if other_col functionally depends on col
                        grouped = df.groupby(col)[other_col].nunique()
                        if (grouped == 1).all():
                            relationships['dependencies'][f"{col} -> {other_col}"] = True
        
        return relationships
    
    def _detect_anomalies(self, df: pd.DataFrame) -> List[Dict[str, Any]]:
        """Detect data anomalies and quality issues"""
        
        anomalies = []
        
        # Check for suspicious patterns
        for column in df.columns:
            series = df[column]
            
            # High null percentage
            null_pct = series.isnull().sum() / len(series) * 100
            if null_pct > 50:
                anomalies.append({
                    'type': 'high_null_percentage',
                    'column': column,
                    'value': null_pct,
                    'description': f"Column has {null_pct:.1f}% null values"
                })
            
            # Low cardinality in large dataset
            if len(df) > 10000 and series.nunique() < 10:
                anomalies.append({
                    'type': 'low_cardinality',
                    'column': column,
                    'value': series.nunique(),
                    'description': f"Column has only {series.nunique()} unique values in {len(df)} rows"
                })
            
            # Numeric anomalies
            if pd.api.types.is_numeric_dtype(series):
                # All same value
                if series.nunique() == 1:
                    anomalies.append({
                        'type': 'constant_value',
                        'column': column,
                        'value': series.iloc[0],
                        'description': f"Column has constant value: {series.iloc[0]}"
                    })
                
                # Extreme outliers
                outlier_count = self._count_outliers(series)
                outlier_pct = outlier_count / len(series) * 100
                if outlier_pct > 10:
                    anomalies.append({
                        'type': 'excessive_outliers',
                        'column': column,
                        'value': outlier_pct,
                        'description': f"Column has {outlier_pct:.1f}% outliers"
                    })
        
        return anomalies
```

## Real-Time Data Observability

### Streaming Data Quality Monitoring

```python
# Real-time data quality monitoring for streaming systems
import asyncio
import aiohttp
from kafka import KafkaConsumer, KafkaProducer
import json
from datetime import datetime, timedelta
from collections import defaultdict, deque
import threading
import time

class StreamingDataQualityMonitor:
    """Real-time data quality monitoring for streaming data"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.quality_metrics = defaultdict(lambda: {
            'total_records': 0,
            'failed_records': 0,
            'error_types': defaultdict(int),
            'last_update': datetime.now()
        })
        self.sliding_windows = defaultdict(lambda: deque(maxlen=1000))
        self.alert_thresholds = config.get('alert_thresholds', {})
        self.running = False
        
    async def start_monitoring(self):
        """Start real-time monitoring of streaming data"""
        self.running = True
        
        # Start multiple monitoring tasks
        tasks = [
            asyncio.create_task(self._monitor_kafka_stream()),
            asyncio.create_task(self._monitor_api_endpoints()),
            asyncio.create_task(self._calculate_sliding_metrics()),
            asyncio.create_task(self._check_data_freshness()),
            asyncio.create_task(self._generate_alerts())
        ]
        
        await asyncio.gather(*tasks)
    
    async def _monitor_kafka_stream(self):
        """Monitor Kafka streams for data quality issues"""
        
        consumer = KafkaConsumer(
            *self.config['kafka']['topics'],
            bootstrap_servers=self.config['kafka']['bootstrap_servers'],
            value_deserializer=lambda x: json.loads(x.decode('utf-8')),
            group_id=self.config['kafka']['group_id']
        )
        
        for message in consumer:
            if not self.running:
                break
                
            try:
                data = message.value
                topic = message.topic
                
                # Validate message structure
                validation_result = await self._validate_streaming_record(data, topic)
                
                # Update metrics
                self.quality_metrics[topic]['total_records'] += 1
                if not validation_result['valid']:
                    self.quality_metrics[topic]['failed_records'] += 1
                    for error in validation_result['errors']:
                        self.quality_metrics[topic]['error_types'][error['type']] += 1
                
                # Add to sliding window
                self.sliding_windows[topic].append({
                    'timestamp': datetime.now(),
                    'valid': validation_result['valid'],
                    'errors': validation_result['errors']
                })
                
                self.quality_metrics[topic]['last_update'] = datetime.now()
                
            except Exception as e:
                logging.error(f"Error processing Kafka message: {e}")
    
    async def _validate_streaming_record(self, record: Dict, topic: str) -> Dict[str, Any]:
        """Validate individual streaming record"""
        
        validation_result = {
            'valid': True,
            'errors': []
        }
        
        # Get validation rules for topic
        rules = self.config.get('stream_validation_rules', {}).get(topic, [])
        
        for rule in rules:
            try:
                if rule['type'] == 'required_fields':
                    missing_fields = [field for field in rule['fields'] 
                                    if field not in record or record[field] is None]
                    if missing_fields:
                        validation_result['valid'] = False
                        validation_result['errors'].append({
                            'type': 'missing_required_fields',
                            'details': missing_fields
                        })
                
                elif rule['type'] == 'data_types':
                    for field, expected_type in rule['types'].items():
                        if field in record and record[field] is not None:
                            if not self._check_data_type(record[field], expected_type):
                                validation_result['valid'] = False
                                validation_result['errors'].append({
                                    'type': 'invalid_data_type',
                                    'field': field,
                                    'expected': expected_type,
                                    'actual': type(record[field]).__name__
                                })
                
                elif rule['type'] == 'range_validation':
                    for field, constraints in rule['ranges'].items():
                        if field in record and record[field] is not None:
                            value = record[field]
                            if ('min' in constraints and value < constraints['min']) or \
                               ('max' in constraints and value > constraints['max']):
                                validation_result['valid'] = False
                                validation_result['errors'].append({
                                    'type': 'value_out_of_range',
                                    'field': field,
                                    'value': value,
                                    'constraints': constraints
                                })
                
                elif rule['type'] == 'pattern_validation':
                    import re
                    for field, pattern in rule['patterns'].items():
                        if field in record and record[field] is not None:
                            if not re.match(pattern, str(record[field])):
                                validation_result['valid'] = False
                                validation_result['errors'].append({
                                    'type': 'pattern_mismatch',
                                    'field': field,
                                    'value': record[field],
                                    'pattern': pattern
                                })
                
            except Exception as e:
                validation_result['valid'] = False
                validation_result['errors'].append({
                    'type': 'validation_error',
                    'message': str(e)
                })
        
        return validation_result
    
    def _check_data_type(self, value: Any, expected_type: str) -> bool:
        """Check if value matches expected data type"""
        
        type_checkers = {
            'string': lambda x: isinstance(x, str),
            'integer': lambda x: isinstance(x, int),
            'float': lambda x: isinstance(x, (int, float)),
            'boolean': lambda x: isinstance(x, bool),
            'datetime': lambda x: self._is_valid_datetime(x),
            'email': lambda x: self._is_valid_email(x),
            'url': lambda x: self._is_valid_url(x)
        }
        
        checker = type_checkers.get(expected_type)
        return checker(value) if checker else True
    
    def _is_valid_datetime(self, value: Any) -> bool:
        """Check if value is valid datetime"""
        if isinstance(value, datetime):
            return True
        
        if isinstance(value, str):
            try:
                datetime.fromisoformat(value.replace('Z', '+00:00'))
                return True
            except:
                return False
        
        return False
    
    def _is_valid_email(self, value: Any) -> bool:
        """Check if value is valid email"""
        import re
        if not isinstance(value, str):
            return False
        
        pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
        return re.match(pattern, value) is not None
    
    def _is_valid_url(self, value: Any) -> bool:
        """Check if value is valid URL"""
        import re
        if not isinstance(value, str):
            return False
        
        pattern = r'^https?://[^\s/$.?#].[^\s]*$'
        return re.match(pattern, value) is not None
    
    async def _calculate_sliding_metrics(self):
        """Calculate metrics over sliding time windows"""
        
        while self.running:
            current_time = datetime.now()
            window_duration = timedelta(minutes=5)  # 5-minute sliding window
            
            for topic, window_data in self.sliding_windows.items():
                # Filter data within window
                window_records = [
                    record for record in window_data
                    if current_time - record['timestamp'] <= window_duration
                ]
                
                if window_records:
                    total_records = len(window_records)
                    failed_records = sum(1 for record in window_records if not record['valid'])
                    error_rate = (failed_records / total_records) * 100
                    
                    # Update sliding metrics
                    sliding_metrics = {
                        'timestamp': current_time,
                        'window_duration_minutes': window_duration.total_seconds() / 60,
                        'total_records': total_records,
                        'failed_records': failed_records,
                        'error_rate_percent': error_rate,
                        'throughput_per_second': total_records / (window_duration.total_seconds()),
                    }
                    
                    # Store or send metrics
                    await self._store_sliding_metrics(topic, sliding_metrics)
            
            await asyncio.sleep(30)  # Update every 30 seconds
    
    async def _check_data_freshness(self):
        """Monitor data freshness across streams"""
        
        while self.running:
            current_time = datetime.now()
            
            for topic, metrics in self.quality_metrics.items():
                last_update = metrics['last_update']
                staleness_minutes = (current_time - last_update).total_seconds() / 60
                
                # Check against freshness thresholds
                max_staleness = self.alert_thresholds.get('max_staleness_minutes', {}).get(topic, 30)
                
                if staleness_minutes > max_staleness:
                    await self._trigger_freshness_alert(topic, staleness_minutes, max_staleness)
            
            await asyncio.sleep(60)  # Check every minute
    
    async def _generate_alerts(self):
        """Generate alerts based on quality metrics"""
        
        while self.running:
            for topic, metrics in self.quality_metrics.items():
                # Check error rate threshold
                if metrics['total_records'] > 0:
                    error_rate = (metrics['failed_records'] / metrics['total_records']) * 100
                    threshold = self.alert_thresholds.get('error_rate_percent', {}).get(topic, 5.0)
                    
                    if error_rate > threshold:
                        await self._trigger_error_rate_alert(topic, error_rate, threshold)
            
            await asyncio.sleep(60)  # Check every minute
    
    async def _store_sliding_metrics(self, topic: str, metrics: Dict[str, Any]):
        """Store sliding window metrics for monitoring"""
        # Implementation depends on your metrics storage system
        # Could be InfluxDB, Prometheus, CloudWatch, etc.
        pass
    
    async def _trigger_freshness_alert(self, topic: str, staleness: float, threshold: float):
        """Trigger alert for data freshness issues"""
        alert = {
            'type': 'data_freshness',
            'topic': topic,
            'staleness_minutes': staleness,
            'threshold_minutes': threshold,
            'severity': 'high' if staleness > threshold * 2 else 'medium',
            'timestamp': datetime.now()
        }
        
        await self._send_alert(alert)
    
    async def _trigger_error_rate_alert(self, topic: str, error_rate: float, threshold: float):
        """Trigger alert for high error rates"""
        alert = {
            'type': 'high_error_rate',
            'topic': topic,
            'error_rate_percent': error_rate,
            'threshold_percent': threshold,
            'severity': 'critical' if error_rate > threshold * 2 else 'high',
            'timestamp': datetime.now()
        }
        
        await self._send_alert(alert)
    
    async def _send_alert(self, alert: Dict[str, Any]):
        """Send alert through configured channels"""
        # Implementation for various alert channels
        # Slack, PagerDuty, email, etc.
        pass

# Advanced data lineage tracking for observability
class DataLineageTracker:
    """Track data lineage for comprehensive observability"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.lineage_graph = defaultdict(dict)
        self.transformation_metadata = {}
        
    def track_transformation(self, transformation_id: str, 
                           source_datasets: List[str],
                           target_dataset: str,
                           transformation_logic: Dict[str, Any]):
        """Track data transformation for lineage"""
        
        lineage_record = {
            'transformation_id': transformation_id,
            'timestamp': datetime.now(),
            'source_datasets': source_datasets,
            'target_dataset': target_dataset,
            'transformation_type': transformation_logic.get('type'),
            'transformation_code': transformation_logic.get('code'),
            'data_owner': transformation_logic.get('owner'),
            'business_context': transformation_logic.get('business_context'),
            'quality_checks': transformation_logic.get('quality_checks', [])
        }
        
        # Update lineage graph
        for source in source_datasets:
            self.lineage_graph[source][target_dataset] = lineage_record
        
        # Store transformation metadata
        self.transformation_metadata[transformation_id] = lineage_record
        
        return lineage_record
    
    def get_upstream_lineage(self, dataset: str, depth: int = 5) -> Dict[str, Any]:
        """Get upstream data lineage for a dataset"""
        
        lineage = {
            'dataset': dataset,
            'upstream_datasets': [],
            'transformation_chain': []
        }
        
        visited = set()
        
        def traverse_upstream(current_dataset: str, current_depth: int):
            if current_depth >= depth or current_dataset in visited:
                return
            
            visited.add(current_dataset)
            
            # Find all sources that feed into current dataset
            for source_dataset, targets in self.lineage_graph.items():
                if current_dataset in targets:
                    lineage['upstream_datasets'].append(source_dataset)
                    lineage['transformation_chain'].append(targets[current_dataset])
                    
                    # Recursively traverse upstream
                    traverse_upstream(source_dataset, current_depth + 1)
        
        traverse_upstream(dataset, 0)
        return lineage
    
    def get_downstream_lineage(self, dataset: str, depth: int = 5) -> Dict[str, Any]:
        """Get downstream data lineage for a dataset"""
        
        lineage = {
            'dataset': dataset,
            'downstream_datasets': [],
            'transformation_chain': []
        }
        
        visited = set()
        
        def traverse_downstream(current_dataset: str, current_depth: int):
            if current_depth >= depth or current_dataset in visited:
                return
            
            visited.add(current_dataset)
            
            # Find all targets that current dataset feeds into
            if current_dataset in self.lineage_graph:
                for target_dataset, transformation in self.lineage_graph[current_dataset].items():
                    lineage['downstream_datasets'].append(target_dataset)
                    lineage['transformation_chain'].append(transformation)
                    
                    # Recursively traverse downstream
                    traverse_downstream(target_dataset, current_depth + 1)
        
        traverse_downstream(dataset, 0)
        return lineage
    
    def analyze_impact(self, dataset: str, change_type: str) -> Dict[str, Any]:
        """Analyze impact of changes to a dataset"""
        
        downstream_lineage = self.get_downstream_lineage(dataset)
        
        impact_analysis = {
            'source_dataset': dataset,
            'change_type': change_type,
            'impacted_datasets': downstream_lineage['downstream_datasets'],
            'impact_severity': self._calculate_impact_severity(downstream_lineage),
            'recommended_actions': self._generate_impact_recommendations(downstream_lineage),
            'notification_recipients': self._get_notification_recipients(downstream_lineage)
        }
        
        return impact_analysis
    
    def _calculate_impact_severity(self, lineage: Dict[str, Any]) -> str:
        """Calculate severity of impact based on downstream dependencies"""
        
        downstream_count = len(lineage['downstream_datasets'])
        
        if downstream_count == 0:
            return 'low'
        elif downstream_count <= 3:
            return 'medium'
        elif downstream_count <= 10:
            return 'high'
        else:
            return 'critical'
    
    def _generate_impact_recommendations(self, lineage: Dict[str, Any]) -> List[str]:
        """Generate recommendations for handling impact"""
        
        recommendations = []
        
        if len(lineage['downstream_datasets']) > 0:
            recommendations.append("Notify downstream data owners")
            recommendations.append("Run data quality checks on impacted datasets")
            recommendations.append("Consider implementing backward compatibility")
        
        if len(lineage['downstream_datasets']) > 5:
            recommendations.append("Implement gradual rollout strategy")
            recommendations.append("Set up monitoring for downstream impacts")
        
        return recommendations
    
    def _get_notification_recipients(self, lineage: Dict[str, Any]) -> List[str]:
        """Get list of people to notify about changes"""
        
        recipients = set()
        
        for transformation in lineage['transformation_chain']:
            owner = transformation.get('data_owner')
            if owner:
                recipients.add(owner)
        
        return list(recipients)
```

## Automated Testing and Validation

### Data Quality Testing Framework

```python
# Comprehensive data quality testing framework
import pytest
import pandas as pd
from typing import List, Dict, Any, Callable
from dataclasses import dataclass
import great_expectations as ge
from unittest.mock import Mock
import logging

@dataclass
class DataQualityTest:
    """Define individual data quality test case"""
    test_id: str
    test_name: str
    test_category: str  # schema, data, business
    severity: str  # critical, high, medium, low
    test_function: Callable
    parameters: Dict[str, Any]
    expected_result: Any
    description: str
    tags: List[str] = None

class DataQualityTestSuite:
    """Comprehensive data quality testing framework"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.tests: Dict[str, DataQualityTest] = {}
        self.test_results: List[Dict[str, Any]] = []
        
    def register_test(self, test: DataQualityTest):
        """Register a data quality test"""
        self.tests[test.test_id] = test
        logging.info(f"Registered test: {test.test_name}")
    
    def create_schema_tests(self, expected_schema: Dict[str, Any]) -> List[DataQualityTest]:
        """Create schema validation tests"""
        
        tests = []
        
        # Column presence test
        tests.append(DataQualityTest(
            test_id="schema_columns_present",
            test_name="Required Columns Present",
            test_category="schema",
            severity="critical",
            test_function=self._test_columns_present,
            parameters={"expected_columns": expected_schema["columns"]},
            expected_result=True,
            description="Verify all required columns are present"
        ))
        
        # Data type validation test
        tests.append(DataQualityTest(
            test_id="schema_data_types",
            test_name="Data Types Validation",
            test_category="schema",
            severity="high",
            test_function=self._test_data_types,
            parameters={"expected_types": expected_schema["data_types"]},
            expected_result=True,
            description="Verify column data types match expectations"
        ))
        
        # Column order test
        if expected_schema.get("enforce_column_order"):
            tests.append(DataQualityTest(
                test_id="schema_column_order",
                test_name="Column Order Validation",
                test_category="schema",
                severity="medium",
                test_function=self._test_column_order,
                parameters={"expected_order": expected_schema["column_order"]},
                expected_result=True,
                description="Verify column order matches expectations"
            ))
        
        return tests
    
    def create_data_quality_tests(self, quality_rules: Dict[str, Any]) -> List[DataQualityTest]:
        """Create data quality validation tests"""
        
        tests = []
        
        # Completeness tests
        for column, threshold in quality_rules.get("completeness", {}).items():
            tests.append(DataQualityTest(
                test_id=f"completeness_{column}",
                test_name=f"Completeness Check - {column}",
                test_category="data",
                severity="high",
                test_function=self._test_completeness,
                parameters={"column": column, "threshold": threshold},
                expected_result=True,
                description=f"Verify {column} completeness >= {threshold}%"
            ))
        
        # Uniqueness tests
        for columns in quality_rules.get("uniqueness", []):
            columns_str = "_".join(columns) if isinstance(columns, list) else columns
            tests.append(DataQualityTest(
                test_id=f"uniqueness_{columns_str}",
                test_name=f"Uniqueness Check - {columns_str}",
                test_category="data",
                severity="high",
                test_function=self._test_uniqueness,
                parameters={"columns": columns},
                expected_result=True,
                description=f"Verify uniqueness of {columns}"
            ))
        
        # Range validation tests
        for column, ranges in quality_rules.get("ranges", {}).items():
            tests.append(DataQualityTest(
                test_id=f"range_{column}",
                test_name=f"Range Validation - {column}",
                test_category="data",
                severity="medium",
                test_function=self._test_range_validation,
                parameters={"column": column, "min_val": ranges.get("min"), "max_val": ranges.get("max")},
                expected_result=True,
                description=f"Verify {column} values within expected range"
            ))
        
        # Pattern validation tests
        for column, pattern in quality_rules.get("patterns", {}).items():
            tests.append(DataQualityTest(
                test_id=f"pattern_{column}",
                test_name=f"Pattern Validation - {column}",
                test_category="data",
                severity="medium",
                test_function=self._test_pattern_validation,
                parameters={"column": column, "pattern": pattern},
                expected_result=True,
                description=f"Verify {column} matches expected pattern"
            ))
        
        return tests
    
    def create_business_rule_tests(self, business_rules: List[Dict[str, Any]]) -> List[DataQualityTest]:
        """Create business rule validation tests"""
        
        tests = []
        
        for rule in business_rules:
            tests.append(DataQualityTest(
                test_id=f"business_rule_{rule['id']}",
                test_name=rule['name'],
                test_category="business",
                severity=rule.get('severity', 'medium'),
                test_function=self._test_business_rule,
                parameters={"rule_logic": rule['logic'], "threshold": rule.get('threshold', 100)},
                expected_result=True,
                description=rule['description']
            ))
        
        return tests
    
    def run_test_suite(self, df: pd.DataFrame, test_categories: List[str] = None) -> Dict[str, Any]:
        """Run comprehensive test suite"""
        
        if test_categories is None:
            test_categories = ["schema", "data", "business"]
        
        results = {
            'total_tests': 0,
            'passed_tests': 0,
            'failed_tests': 0,
            'test_results': [],
            'summary_by_category': {},
            'critical_failures': [],
            'execution_time': None
        }
        
        start_time = datetime.now()
        
        for test_id, test in self.tests.items():
            if test.test_category not in test_categories:
                continue
            
            results['total_tests'] += 1
            
            try:
                test_result = test.test_function(df, **test.parameters)
                
                test_record = {
                    'test_id': test_id,
                    'test_name': test.test_name,
                    'category': test.test_category,
                    'severity': test.severity,
                    'passed': test_result == test.expected_result,
                    'actual_result': test_result,
                    'expected_result': test.expected_result,
                    'execution_time': datetime.now(),
                    'description': test.description
                }
                
                if test_record['passed']:
                    results['passed_tests'] += 1
                else:
                    results['failed_tests'] += 1
                    if test.severity == 'critical':
                        results['critical_failures'].append(test_record)
                
                results['test_results'].append(test_record)
                
                # Update category summary
                category = test.test_category
                if category not in results['summary_by_category']:
                    results['summary_by_category'][category] = {'total': 0, 'passed': 0, 'failed': 0}
                
                results['summary_by_category'][category]['total'] += 1
                if test_record['passed']:
                    results['summary_by_category'][category]['passed'] += 1
                else:
                    results['summary_by_category'][category]['failed'] += 1
                
            except Exception as e:
                logging.error(f"Test {test_id} failed with exception: {e}")
                results['failed_tests'] += 1
                
                error_record = {
                    'test_id': test_id,
                    'test_name': test.test_name,
                    'category': test.test_category,
                    'severity': test.severity,
                    'passed': False,
                    'error': str(e),
                    'execution_time': datetime.now(),
                    'description': test.description
                }
                
                results['test_results'].append(error_record)
        
        results['execution_time'] = (datetime.now() - start_time).total_seconds()
        return results
    
    # Test implementation methods
    def _test_columns_present(self, df: pd.DataFrame, expected_columns: List[str]) -> bool:
        """Test if all expected columns are present"""
        return all(col in df.columns for col in expected_columns)
    
    def _test_data_types(self, df: pd.DataFrame, expected_types: Dict[str, str]) -> bool:
        """Test if column data types match expectations"""
        for column, expected_type in expected_types.items():
            if column not in df.columns:
                return False
            
            actual_type = str(df[column].dtype)
            if not self._types_compatible(actual_type, expected_type):
                return False
        
        return True
    
    def _test_column_order(self, df: pd.DataFrame, expected_order: List[str]) -> bool:
        """Test if column order matches expectations"""
        return list(df.columns) == expected_order
    
    def _test_completeness(self, df: pd.DataFrame, column: str, threshold: float) -> bool:
        """Test column completeness against threshold"""
        if column not in df.columns:
            return False
        
        completeness = (1 - df[column].isnull().sum() / len(df)) * 100
        return completeness >= threshold
    
    def _test_uniqueness(self, df: pd.DataFrame, columns: List[str]) -> bool:
        """Test uniqueness of specified columns"""
        if isinstance(columns, str):
            columns = [columns]
        
        for col in columns:
            if col not in df.columns:
                return False
        
        if len(columns) == 1:
            return df[columns[0]].nunique() == len(df)
        else:
            return df[columns].drop_duplicates().shape[0] == len(df)
    
    def _test_range_validation(self, df: pd.DataFrame, column: str, 
                              min_val: float = None, max_val: float = None) -> bool:
        """Test if values fall within expected range"""
        if column not in df.columns:
            return False
        
        series = df[column].dropna()
        
        if min_val is not None and (series < min_val).any():
            return False
        
        if max_val is not None and (series > max_val).any():
            return False
        
        return True
    
    def _test_pattern_validation(self, df: pd.DataFrame, column: str, pattern: str) -> bool:
        """Test if values match expected pattern"""
        import re
        
        if column not in df.columns:
            return False
        
        series = df[column].dropna().astype(str)
        return series.str.match(pattern).all()
    
    def _test_business_rule(self, df: pd.DataFrame, rule_logic: str, threshold: float = 100) -> bool:
        """Test business rule compliance"""
        try:
            # Evaluate business rule expression
            result = df.eval(rule_logic)
            compliance_rate = result.sum() / len(df) * 100
            return compliance_rate >= threshold
        except Exception:
            return False
    
    def _types_compatible(self, actual_type: str, expected_type: str) -> bool:
        """Check if data types are compatible"""
        
        type_mappings = {
            'int64': ['integer', 'int', 'number'],
            'float64': ['float', 'number', 'decimal'],
            'object': ['string', 'text', 'varchar'],
            'bool': ['boolean', 'bool'],
            'datetime64[ns]': ['datetime', 'timestamp', 'date']
        }
        
        compatible_types = type_mappings.get(actual_type, [actual_type])
        return expected_type.lower() in [t.lower() for t in compatible_types]

# Integration with Great Expectations
class GreatExpectationsIntegration:
    """Integration with Great Expectations for advanced data validation"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.context = None
        
    def setup_great_expectations(self, project_root: str):
        """Set up Great Expectations context"""
        import great_expectations as ge
        from great_expectations.data_context import DataContext
        
        self.context = DataContext(project_root)
        return self.context
    
    def create_expectation_suite(self, suite_name: str, df: pd.DataFrame) -> ge.dataset.PandasDataset:
        """Create comprehensive expectation suite"""
        
        # Convert DataFrame to Great Expectations dataset
        ge_df = ge.from_pandas(df)
        
        # Create expectation suite
        expectation_suite = self.context.create_expectation_suite(suite_name)
        
        # Auto-generate basic expectations
        ge_df.expect_table_row_count_to_be_between(min_value=1)
        
        for column in df.columns:
            # Basic column expectations
            ge_df.expect_column_to_exist(column)
            
            # Type-specific expectations
            if pd.api.types.is_numeric_dtype(df[column]):
                ge_df.expect_column_values_to_be_of_type(column, "float64")
                if df[column].min() >= 0:
                    ge_df.expect_column_values_to_be_between(column, min_value=0)
            
            elif pd.api.types.is_string_dtype(df[column]):
                ge_df.expect_column_values_to_be_of_type(column, "str")
                avg_length = df[column].str.len().mean()
                ge_df.expect_column_value_lengths_to_be_between(
                    column, min_value=1, max_value=int(avg_length * 3)
                )
            
            # Completeness expectations
            null_percentage = df[column].isnull().sum() / len(df) * 100
            if null_percentage < 5:  # If less than 5% nulls, expect no nulls
                ge_df.expect_column_values_to_not_be_null(column)
        
        # Save expectation suite
        self.context.save_expectation_suite(ge_df.get_expectation_suite(), suite_name)
        
        return ge_df
    
    def validate_data(self, df: pd.DataFrame, suite_name: str) -> Dict[str, Any]:
        """Validate data against expectation suite"""
        
        # Get expectation suite
        expectation_suite = self.context.get_expectation_suite(suite_name)
        
        # Create validator
        validator = self.context.get_validator(
            batch_request={"dataset": df},
            expectation_suite=expectation_suite
        )
        
        # Run validation
        validation_result = validator.validate()
        
        return {
            'success': validation_result.success,
            'results': validation_result.results,
            'statistics': validation_result.statistics,
            'meta': validation_result.meta
        }
```

## Incident Response and Alerting

### Automated Incident Response Framework

```python
# Comprehensive incident response framework for data quality issues
from enum import Enum
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Callable
import asyncio
import json
from datetime import datetime, timedelta
import logging

class IncidentSeverity(Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

class IncidentStatus(Enum):
    OPEN = "open"
    INVESTIGATING = "investigating"
    MITIGATING = "mitigating"
    RESOLVED = "resolved"
    CLOSED = "closed"

@dataclass
class DataQualityIncident:
    """Data quality incident record"""
    incident_id: str
    title: str
    description: str
    severity: IncidentSeverity
    status: IncidentStatus
    affected_datasets: List[str]
    error_type: str
    detection_time: datetime
    assigned_to: Optional[str] = None
    resolution_time: Optional[datetime] = None
    root_cause: Optional[str] = None
    action_items: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

class IncidentResponseManager:
    """Automated incident response and management system"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.incidents: Dict[str, DataQualityIncident] = {}
        self.alert_channels: List[Callable] = []
        self.escalation_rules: Dict[str, Any] = config.get('escalation_rules', {})
        self.auto_remediation_rules: Dict[str, Callable] = {}
        
    def register_alert_channel(self, channel: Callable):
        """Register alert notification channel"""
        self.alert_channels.append(channel)
    
    def register_auto_remediation(self, error_type: str, remediation_function: Callable):
        """Register automatic remediation for specific error types"""
        self.auto_remediation_rules[error_type] = remediation_function
    
    async def create_incident(self, quality_result: DataQualityResult, 
                            rule: DataQualityRule) -> DataQualityIncident:
        """Create new data quality incident"""
        
        incident_id = self._generate_incident_id()
        
        # Determine severity based on rule and impact
        severity = self._determine_incident_severity(quality_result, rule)
        
        incident = DataQualityIncident(
            incident_id=incident_id,
            title=f"Data Quality Issue: {rule.rule_name}",
            description=self._generate_incident_description(quality_result, rule),
            severity=severity,
            status=IncidentStatus.OPEN,
            affected_datasets=[quality_result.table_name],
            error_type=rule.dimension,
            detection_time=quality_result.execution_time,
            metadata={
                'rule_id': rule.rule_id,
                'metric_value': quality_result.metric_value,
                'threshold': quality_result.threshold,
                'row_count': quality_result.row_count,
                'affected_rows': quality_result.affected_rows
            }
        )
        
        self.incidents[incident_id] = incident
        
        # Send initial alerts
        await self._send_incident_alert(incident, "created")
        
        # Try automatic remediation
        if rule.dimension in self.auto_remediation_rules:
            await self._attempt_auto_remediation(incident, quality_result, rule)
        
        # Start escalation timer if needed
        if severity in [IncidentSeverity.CRITICAL, IncidentSeverity.HIGH]:
            asyncio.create_task(self._start_escalation_timer(incident))
        
        return incident
    
    def _determine_incident_severity(self, quality_result: DataQualityResult, 
                                   rule: DataQualityRule) -> IncidentSeverity:
        """Determine incident severity based on rule and impact"""
        
        # Base severity from rule
        base_severity = IncidentSeverity(rule.severity)
        
        # Adjust based on impact
        if quality_result.affected_rows and quality_result.row_count:
            impact_percentage = (quality_result.affected_rows / quality_result.row_count) * 100
            
            if impact_percentage > 50:
                # High impact - escalate severity
                if base_severity == IncidentSeverity.MEDIUM:
                    return IncidentSeverity.HIGH
                elif base_severity == IncidentSeverity.LOW:
                    return IncidentSeverity.MEDIUM
            elif impact_percentage < 1:
                # Low impact - reduce severity
                if base_severity == IncidentSeverity.HIGH:
                    return IncidentSeverity.MEDIUM
                elif base_severity == IncidentSeverity.MEDIUM:
                    return IncidentSeverity.LOW
        
        return base_severity
    
    def _generate_incident_description(self, quality_result: DataQualityResult,
                                     rule: DataQualityRule) -> str:
        """Generate detailed incident description"""
        
        description = f"""
Data Quality Issue Detected:

Rule: {rule.rule_name}
Dimension: {rule.dimension}
Table: {quality_result.table_name}
Column: {quality_result.column_name or 'N/A'}

Metrics:
- Expected: >= {quality_result.threshold}%
- Actual: {quality_result.metric_value:.2f}%
- Total Rows: {quality_result.row_count:,}
- Affected Rows: {quality_result.affected_rows or 0:,}

Detection Time: {quality_result.execution_time}

Sample Failures:
{json.dumps(quality_result.sample_failures[:3], indent=2) if quality_result.sample_failures else 'N/A'}
        """.strip()
        
        return description
    
    async def _send_incident_alert(self, incident: DataQualityIncident, action: str):
        """Send incident alerts through configured channels"""
        
        alert_data = {
            'incident_id': incident.incident_id,
            'title': incident.title,
            'severity': incident.severity.value,
            'status': incident.status.value,
            'action': action,
            'affected_datasets': incident.affected_datasets,
            'detection_time': incident.detection_time.isoformat(),
            'description': incident.description
        }
        
        for channel in self.alert_channels:
            try:
                await channel(alert_data)
            except Exception as e:
                logging.error(f"Failed to send alert through channel: {e}")
    
    async def _attempt_auto_remediation(self, incident: DataQualityIncident,
                                      quality_result: DataQualityResult,
                                      rule: DataQualityRule):
        """Attempt automatic remediation of data quality issues"""
        
        remediation_function = self.auto_remediation_rules.get(rule.dimension)
        if not remediation_function:
            return
        
        try:
            incident.status = IncidentStatus.MITIGATING
            
            # Execute remediation
            remediation_result = await remediation_function(incident, quality_result, rule)
            
            if remediation_result.get('success'):
                incident.status = IncidentStatus.RESOLVED
                incident.resolution_time = datetime.now()
                incident.root_cause = "Automatically resolved"
                incident.action_items.append(f"Auto-remediation: {remediation_result.get('action')}")
                
                await self._send_incident_alert(incident, "auto_resolved")
            else:
                incident.status = IncidentStatus.INVESTIGATING
                incident.action_items.append(f"Auto-remediation failed: {remediation_result.get('error')}")
                
        except Exception as e:
            logging.error(f"Auto-remediation failed for incident {incident.incident_id}: {e}")
            incident.status = IncidentStatus.INVESTIGATING
            incident.action_items.append(f"Auto-remediation error: {str(e)}")
    
    async def _start_escalation_timer(self, incident: DataQualityIncident):
        """Start escalation timer for high-severity incidents"""
        
        escalation_config = self.escalation_rules.get(incident.severity.value, {})
        escalation_time = escalation_config.get('escalation_time_minutes', 30)
        
        # Wait for escalation time
        await asyncio.sleep(escalation_time * 60)
        
        # Check if incident is still open
        current_incident = self.incidents.get(incident.incident_id)
        if current_incident and current_incident.status in [IncidentStatus.OPEN, IncidentStatus.INVESTIGATING]:
            await self._escalate_incident(current_incident)
    
    async def _escalate_incident(self, incident: DataQualityIncident):
        """Escalate incident to higher level"""
        
        escalation_config = self.escalation_rules.get(incident.severity.value, {})
        escalation_contacts = escalation_config.get('escalation_contacts', [])
        
        escalation_alert = {
            'incident_id': incident.incident_id,
            'title': f"ESCALATED: {incident.title}",
            'severity': incident.severity.value,
            'status': incident.status.value,
            'action': 'escalated',
            'escalation_contacts': escalation_contacts,
            'time_since_detection': (datetime.now() - incident.detection_time).total_seconds() / 60,
            'description': incident.description
        }
        
        # Send escalation alerts
        for channel in self.alert_channels:
            try:
                await channel(escalation_alert)
            except Exception as e:
                logging.error(f"Failed to send escalation alert: {e}")
    
    def update_incident(self, incident_id: str, **updates) -> Optional[DataQualityIncident]:
        """Update incident with new information"""
        
        if incident_id not in self.incidents:
            return None
        
        incident = self.incidents[incident_id]
        
        for key, value in updates.items():
            if hasattr(incident, key):
                setattr(incident, key, value)
        
        return incident
    
    def get_incident_metrics(self, time_window: timedelta = None) -> Dict[str, Any]:
        """Get incident metrics for monitoring and reporting"""
        
        if time_window is None:
            time_window = timedelta(days=7)
        
        cutoff_time = datetime.now() - time_window
        recent_incidents = [
            incident for incident in self.incidents.values()
            if incident.detection_time >= cutoff_time
        ]
        
        metrics = {
            'total_incidents': len(recent_incidents),
            'by_severity': {},
            'by_status': {},
            'by_error_type': {},
            'resolution_times': [],
            'auto_resolved_count': 0,
            'avg_resolution_time_minutes': 0
        }
        
        for incident in recent_incidents:
            # Count by severity
            severity = incident.severity.value
            metrics['by_severity'][severity] = metrics['by_severity'].get(severity, 0) + 1
            
            # Count by status
            status = incident.status.value
            metrics['by_status'][status] = metrics['by_status'].get(status, 0) + 1
            
            # Count by error type
            error_type = incident.error_type
            metrics['by_error_type'][error_type] = metrics['by_error_type'].get(error_type, 0) + 1
            
            # Resolution time tracking
            if incident.resolution_time:
                resolution_minutes = (incident.resolution_time - incident.detection_time).total_seconds() / 60
                metrics['resolution_times'].append(resolution_minutes)
                
                # Check if auto-resolved
                if "Auto-remediation" in str(incident.action_items):
                    metrics['auto_resolved_count'] += 1
        
        # Calculate average resolution time
        if metrics['resolution_times']:
            metrics['avg_resolution_time_minutes'] = sum(metrics['resolution_times']) / len(metrics['resolution_times'])
        
        return metrics
    
    def _generate_incident_id(self) -> str:
        """Generate unique incident ID"""
        import uuid
        return f"DQ-{datetime.now().strftime('%Y%m%d')}-{str(uuid.uuid4())[:8]}"

# Specific auto-remediation functions
class AutoRemediationLibrary:
    """Library of auto-remediation functions for common data quality issues"""
    
    @staticmethod
    async def remediate_completeness_issue(incident: DataQualityIncident,
                                         quality_result: DataQualityResult,
                                         rule: DataQualityRule) -> Dict[str, Any]:
        """Auto-remediate completeness issues"""
        
        try:
            # Example: Fill null values with defaults or computed values
            column = rule.metadata.get('column')
            table_name = quality_result.table_name
            
            # This would integrate with your data processing system
            # For demonstration, we'll simulate the remediation
            
            if column and quality_result.affected_rows:
                # Simulate filling null values
                action = f"Filled {quality_result.affected_rows} null values in {column} with default values"
                
                return {
                    'success': True,
                    'action': action,
                    'rows_affected': quality_result.affected_rows
                }
            
            return {
                'success': False,
                'error': 'Unable to determine remediation strategy'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    @staticmethod
    async def remediate_uniqueness_issue(incident: DataQualityIncident,
                                       quality_result: DataQualityResult,
                                       rule: DataQualityRule) -> Dict[str, Any]:
        """Auto-remediate uniqueness issues"""
        
        try:
            # Example: Remove duplicate records based on business rules
            columns = rule.metadata.get('columns', [])
            
            if columns and quality_result.affected_rows:
                # Simulate duplicate removal
                action = f"Removed {quality_result.affected_rows} duplicate records based on {columns}"
                
                return {
                    'success': True,
                    'action': action,
                    'rows_affected': quality_result.affected_rows
                }
            
            return {
                'success': False,
                'error': 'Unable to safely remove duplicates automatically'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    @staticmethod
    async def remediate_validity_issue(incident: DataQualityIncident,
                                     quality_result: DataQualityResult,
                                     rule: DataQualityRule) -> Dict[str, Any]:
        """Auto-remediate validity issues"""
        
        try:
            # Example: Correct invalid values based on patterns
            column = rule.metadata.get('column')
            
            if column and quality_result.affected_rows:
                # Simulate value correction
                action = f"Corrected {quality_result.affected_rows} invalid values in {column}"
                
                return {
                    'success': True,
                    'action': action,
                    'rows_affected': quality_result.affected_rows
                }
            
            return {
                'success': False,
                'error': 'Unable to auto-correct invalid values safely'
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
```

## Conclusion

Implementing comprehensive data quality management and observability in production environments requires a multi-layered approach that combines automated monitoring, validation frameworks, real-time alerting, and incident response procedures. The frameworks and techniques outlined in this guide provide a foundation for building robust data reliability systems that can scale with organizational needs.

Key takeaways for successful data quality implementation include:

1. **Proactive Monitoring**: Implement real-time data quality monitoring that catches issues before they impact downstream systems
2. **Comprehensive Testing**: Create automated test suites that validate schema, data quality, and business rules
3. **Intelligent Alerting**: Design alert systems that provide actionable information and avoid alert fatigue
4. **Automated Response**: Implement auto-remediation for common issues while maintaining human oversight for complex problems
5. **Continuous Improvement**: Use incident metrics and patterns to continuously refine quality rules and processes

By following these practices and implementing the frameworks shown in this guide, organizations can build data systems that maintain high quality standards while scaling efficiently in production environments.
