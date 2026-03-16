---
title: "Advanced ETL/ELT Pipeline Development with Airflow and Prefect"
date: 2026-03-31T00:00:00-05:00
draft: false
tags: ["Apache Airflow", "Prefect", "ETL", "ELT", "Data Pipeline", "Workflow Orchestration", "Data Engineering", "Python", "Data Integration"]
categories:
- Data Engineering
- Workflow Orchestration
- Data Pipeline
author: "Matthew Mattox - mmattox@support.tools"
description: "Build advanced ETL/ELT pipelines using Apache Airflow and Prefect for robust data orchestration. Learn workflow design patterns, error handling, monitoring, and production deployment strategies for enterprise data platforms."
more_link: "yes"
url: "/advanced-etl-elt-pipeline-airflow-prefect/"
---

Modern data engineering requires sophisticated orchestration tools to manage complex ETL/ELT pipelines. Apache Airflow and Prefect represent the current generation of workflow orchestration platforms that enable building scalable, maintainable, and observable data pipelines with advanced features like dynamic task generation, robust error handling, and comprehensive monitoring.

<!--more-->

# Advanced ETL/ELT Pipeline Development with Airflow and Prefect

## Apache Airflow Advanced Patterns

### Dynamic DAG Generation

```python
# dynamic_dag_factory.py
from datetime import datetime, timedelta
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.bash import BashOperator
from airflow.providers.postgres.operators.postgres import PostgresOperator
from airflow.providers.amazon.aws.operators.s3 import S3FileTransformOperator
from airflow.providers.amazon.aws.sensors.s3 import S3KeySensor
from airflow.models import Variable
from airflow.utils.task_group import TaskGroup
import yaml
import os

class DynamicDAGFactory:
    """Factory for generating DAGs dynamically from configuration"""
    
    def __init__(self, config_path: str):
        self.config_path = config_path
        self.config = self._load_config()
    
    def _load_config(self) -> dict:
        """Load pipeline configuration from YAML file"""
        with open(self.config_path, 'r') as file:
            return yaml.safe_load(file)
    
    def create_dag(self, pipeline_name: str) -> DAG:
        """Create a DAG based on configuration"""
        pipeline_config = self.config['pipelines'][pipeline_name]
        
        default_args = {
            'owner': pipeline_config.get('owner', 'data-team'),
            'depends_on_past': False,
            'start_date': datetime.strptime(
                pipeline_config.get('start_date', '2025-12-01'), 
                '%Y-%m-%d'
            ),
            'email_on_failure': True,
            'email_on_retry': False,
            'retries': pipeline_config.get('retries', 3),
            'retry_delay': timedelta(minutes=pipeline_config.get('retry_delay', 5)),
            'max_active_runs': pipeline_config.get('max_active_runs', 1),
        }
        
        dag = DAG(
            dag_id=f"{pipeline_name}_pipeline",
            default_args=default_args,
            description=pipeline_config.get('description', ''),
            schedule_interval=pipeline_config.get('schedule', '@daily'),
            catchup=pipeline_config.get('catchup', False),
            tags=pipeline_config.get('tags', []),
        )
        
        with dag:
            self._create_tasks(pipeline_config, dag)
        
        return dag
    
    def _create_tasks(self, config: dict, dag: DAG):
        """Create tasks based on configuration"""
        tasks = {}
        
        # Create extraction tasks
        if 'extract' in config:
            extraction_group = self._create_extraction_group(config['extract'])
            tasks['extract'] = extraction_group
        
        # Create transformation tasks
        if 'transform' in config:
            transformation_group = self._create_transformation_group(config['transform'])
            tasks['transform'] = transformation_group
        
        # Create loading tasks
        if 'load' in config:
            loading_group = self._create_loading_group(config['load'])
            tasks['load'] = loading_group
        
        # Create data quality tasks
        if 'quality' in config:
            quality_group = self._create_quality_group(config['quality'])
            tasks['quality'] = quality_group
        
        # Set dependencies
        self._set_dependencies(tasks, config.get('dependencies', {}))
    
    def _create_extraction_group(self, extract_config: dict) -> TaskGroup:
        """Create extraction task group"""
        with TaskGroup(group_id='extract', tooltip='Data Extraction Tasks') as group:
            
            for source_name, source_config in extract_config.items():
                if source_config['type'] == 'database':
                    task = self._create_database_extract_task(source_name, source_config)
                elif source_config['type'] == 'api':
                    task = self._create_api_extract_task(source_name, source_config)
                elif source_config['type'] == 'file':
                    task = self._create_file_extract_task(source_name, source_config)
                elif source_config['type'] == 's3':
                    task = self._create_s3_extract_task(source_name, source_config)
        
        return group
    
    def _create_database_extract_task(self, source_name: str, config: dict) -> PythonOperator:
        """Create database extraction task"""
        def extract_from_database(**context):
            from airflow.providers.postgres.hooks.postgres import PostgresHook
            import pandas as pd
            
            hook = PostgresHook(postgres_conn_id=config['connection_id'])
            
            # Execute extraction query
            sql = config['query']
            if config.get('incremental', False):
                # Add incremental logic
                last_run = context.get('prev_execution_date')
                if last_run:
                    sql = sql.replace('{{last_run}}', last_run.strftime('%Y-%m-%d %H:%M:%S'))
            
            df = hook.get_pandas_df(sql)
            
            # Save to staging area
            output_path = f"s3://data-lake/staging/{source_name}/{context['ds']}/data.parquet"
            df.to_parquet(output_path, index=False)
            
            return output_path
        
        return PythonOperator(
            task_id=f'extract_{source_name}',
            python_callable=extract_from_database,
            pool=config.get('pool', 'default_pool'),
            pool_slots=config.get('pool_slots', 1),
        )
    
    def _create_api_extract_task(self, source_name: str, config: dict) -> PythonOperator:
        """Create API extraction task"""
        def extract_from_api(**context):
            import requests
            import pandas as pd
            from requests.adapters import HTTPAdapter
            from urllib3.util.retry import Retry
            
            # Setup retry strategy
            retry_strategy = Retry(
                total=3,
                backoff_factor=1,
                status_forcelist=[429, 500, 502, 503, 504],
            )
            adapter = HTTPAdapter(max_retries=retry_strategy)
            
            session = requests.Session()
            session.mount("http://", adapter)
            session.mount("https://", adapter)
            
            # Make API call
            url = config['url']
            headers = config.get('headers', {})
            params = config.get('params', {})
            
            # Add authentication if configured
            if 'auth' in config:
                auth_config = config['auth']
                if auth_config['type'] == 'bearer':
                    token = Variable.get(auth_config['token_variable'])
                    headers['Authorization'] = f"Bearer {token}"
            
            response = session.get(url, headers=headers, params=params, timeout=30)
            response.raise_for_status()
            
            # Process response
            data = response.json()
            if config.get('data_path'):
                # Extract specific path from JSON
                for key in config['data_path'].split('.'):
                    data = data[key]
            
            df = pd.json_normalize(data)
            
            # Save to staging area
            output_path = f"s3://data-lake/staging/{source_name}/{context['ds']}/data.parquet"
            df.to_parquet(output_path, index=False)
            
            return output_path
        
        return PythonOperator(
            task_id=f'extract_{source_name}',
            python_callable=extract_from_api,
            retries=5,
            retry_delay=timedelta(minutes=2),
        )

def create_etl_pipeline_dag(pipeline_name: str) -> DAG:
    """Create ETL pipeline DAG dynamically"""
    config_path = f"/opt/airflow/config/pipelines/{pipeline_name}.yaml"
    factory = DynamicDAGFactory(config_path)
    return factory.create_dag(pipeline_name)

# Generate DAGs for all configured pipelines
import glob

for config_file in glob.glob("/opt/airflow/config/pipelines/*.yaml"):
    pipeline_name = os.path.basename(config_file).replace('.yaml', '')
    dag_id = f"{pipeline_name}_pipeline"
    globals()[dag_id] = create_etl_pipeline_dag(pipeline_name)
```

### Advanced Airflow Operators

```python
# custom_operators.py
from airflow.models import BaseOperator
from airflow.utils.decorators import apply_defaults
from airflow.providers.postgres.hooks.postgres import PostgresHook
from airflow.providers.amazon.aws.hooks.s3 import S3Hook
from typing import Dict, List, Optional, Any
import pandas as pd
import boto3
import logging

class DataQualityOperator(BaseOperator):
    """Custom operator for data quality checks"""
    
    template_fields = ['sql', 'table_name']
    
    @apply_defaults
    def __init__(
        self,
        postgres_conn_id: str,
        table_name: str,
        quality_checks: List[Dict],
        fail_on_quality_issues: bool = True,
        *args,
        **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.postgres_conn_id = postgres_conn_id
        self.table_name = table_name
        self.quality_checks = quality_checks
        self.fail_on_quality_issues = fail_on_quality_issues
    
    def execute(self, context):
        hook = PostgresHook(postgres_conn_id=self.postgres_conn_id)
        quality_results = []
        
        for check in self.quality_checks:
            check_name = check['name']
            check_sql = check['sql'].format(table_name=self.table_name)
            expected_result = check.get('expected_result', 0)
            
            logging.info(f"Running quality check: {check_name}")
            logging.info(f"SQL: {check_sql}")
            
            result = hook.get_first(check_sql)[0]
            
            check_result = {
                'check_name': check_name,
                'result': result,
                'expected': expected_result,
                'passed': result == expected_result,
                'description': check.get('description', '')
            }
            
            quality_results.append(check_result)
            
            if not check_result['passed']:
                error_msg = f"Quality check '{check_name}' failed. Expected: {expected_result}, Got: {result}"
                logging.error(error_msg)
                
                if self.fail_on_quality_issues:
                    raise ValueError(error_msg)
        
        # Log quality results summary
        passed_checks = sum(1 for r in quality_results if r['passed'])
        total_checks = len(quality_results)
        
        logging.info(f"Data quality summary: {passed_checks}/{total_checks} checks passed")
        
        # Store results for downstream tasks
        context['task_instance'].xcom_push(key='quality_results', value=quality_results)
        
        return quality_results

class SmartDataTransferOperator(BaseOperator):
    """Smart data transfer operator with optimization and monitoring"""
    
    template_fields = ['source_path', 'destination_path', 'sql']
    
    @apply_defaults
    def __init__(
        self,
        source_conn_id: str,
        destination_conn_id: str,
        source_path: Optional[str] = None,
        destination_path: Optional[str] = None,
        sql: Optional[str] = None,
        chunk_size: int = 10000,
        compression: str = 'gzip',
        data_type_optimization: bool = True,
        *args,
        **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.source_conn_id = source_conn_id
        self.destination_conn_id = destination_conn_id
        self.source_path = source_path
        self.destination_path = destination_path
        self.sql = sql
        self.chunk_size = chunk_size
        self.compression = compression
        self.data_type_optimization = data_type_optimization
    
    def execute(self, context):
        if self.sql:
            return self._transfer_from_database(context)
        elif self.source_path:
            return self._transfer_from_file(context)
        else:
            raise ValueError("Either sql or source_path must be provided")
    
    def _transfer_from_database(self, context):
        """Transfer data from database with chunking and optimization"""
        source_hook = PostgresHook(postgres_conn_id=self.source_conn_id)
        dest_hook = PostgresHook(postgres_conn_id=self.destination_conn_id)
        
        # Get total row count for progress tracking
        count_sql = f"SELECT COUNT(*) FROM ({self.sql}) as subquery"
        total_rows = source_hook.get_first(count_sql)[0]
        
        logging.info(f"Transferring {total_rows} rows in chunks of {self.chunk_size}")
        
        transferred_rows = 0
        offset = 0
        
        while offset < total_rows:
            # Fetch chunk
            chunk_sql = f"{self.sql} LIMIT {self.chunk_size} OFFSET {offset}"
            df = source_hook.get_pandas_df(chunk_sql)
            
            if df.empty:
                break
            
            # Optimize data types
            if self.data_type_optimization:
                df = self._optimize_dtypes(df)
            
            # Insert chunk
            df.to_sql(
                name=self.destination_path,
                con=dest_hook.get_sqlalchemy_engine(),
                if_exists='append' if offset > 0 else 'replace',
                index=False,
                method='multi',
                chunksize=1000
            )
            
            transferred_rows += len(df)
            offset += self.chunk_size
            
            # Log progress
            progress = (transferred_rows / total_rows) * 100
            logging.info(f"Transfer progress: {progress:.1f}% ({transferred_rows}/{total_rows} rows)")
        
        logging.info(f"Transfer completed. Total rows transferred: {transferred_rows}")
        return transferred_rows
    
    def _optimize_dtypes(self, df: pd.DataFrame) -> pd.DataFrame:
        """Optimize pandas DataFrame data types for memory efficiency"""
        for col in df.columns:
            col_type = df[col].dtype
            
            if col_type == 'object':
                # Try to convert to category if beneficial
                if df[col].nunique() / len(df) < 0.5:
                    df[col] = df[col].astype('category')
            elif col_type == 'int64':
                # Downcast integers
                if df[col].min() >= 0:
                    if df[col].max() < 255:
                        df[col] = df[col].astype('uint8')
                    elif df[col].max() < 65535:
                        df[col] = df[col].astype('uint16')
                    elif df[col].max() < 4294967295:
                        df[col] = df[col].astype('uint32')
                else:
                    if df[col].min() > -128 and df[col].max() < 127:
                        df[col] = df[col].astype('int8')
                    elif df[col].min() > -32768 and df[col].max() < 32767:
                        df[col] = df[col].astype('int16')
                    elif df[col].min() > -2147483648 and df[col].max() < 2147483647:
                        df[col] = df[col].astype('int32')
            elif col_type == 'float64':
                # Downcast floats
                df[col] = pd.to_numeric(df[col], downcast='float')
        
        return df

class ParallelProcessingOperator(BaseOperator):
    """Operator for parallel processing of large datasets"""
    
    @apply_defaults
    def __init__(
        self,
        processing_function: str,
        input_path: str,
        output_path: str,
        num_workers: int = 4,
        chunk_size: int = 10000,
        *args,
        **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.processing_function = processing_function
        self.input_path = input_path
        self.output_path = output_path
        self.num_workers = num_workers
        self.chunk_size = chunk_size
    
    def execute(self, context):
        from concurrent.futures import ProcessPoolExecutor, as_completed
        import importlib
        
        # Import processing function
        module_name, function_name = self.processing_function.rsplit('.', 1)
        module = importlib.import_module(module_name)
        process_func = getattr(module, function_name)
        
        # Read input data
        df = pd.read_parquet(self.input_path)
        total_rows = len(df)
        
        logging.info(f"Processing {total_rows} rows with {self.num_workers} workers")
        
        # Split data into chunks
        chunks = [df[i:i + self.chunk_size] for i in range(0, total_rows, self.chunk_size)]
        
        processed_chunks = []
        
        # Process chunks in parallel
        with ProcessPoolExecutor(max_workers=self.num_workers) as executor:
            future_to_chunk = {
                executor.submit(process_func, chunk): i 
                for i, chunk in enumerate(chunks)
            }
            
            for future in as_completed(future_to_chunk):
                chunk_index = future_to_chunk[future]
                try:
                    result = future.result()
                    processed_chunks.append((chunk_index, result))
                    logging.info(f"Completed processing chunk {chunk_index + 1}/{len(chunks)}")
                except Exception as exc:
                    logging.error(f"Chunk {chunk_index} generated an exception: {exc}")
                    raise
        
        # Combine results
        processed_chunks.sort(key=lambda x: x[0])  # Sort by chunk index
        final_df = pd.concat([chunk[1] for chunk in processed_chunks], ignore_index=True)
        
        # Save results
        final_df.to_parquet(self.output_path, index=False, compression='snappy')
        
        logging.info(f"Processing completed. Output saved to {self.output_path}")
        return self.output_path
```

## Prefect Advanced Patterns

### Flow Design Patterns

```python
# prefect_flows.py
from prefect import Flow, Task, task, Parameter
from prefect.tasks.database import PostgresExecute, PostgresFetch
from prefect.tasks.aws import S3Download, S3Upload
from prefect.tasks.notifications import SlackTask
from prefect.engine.results import LocalResult, S3Result
from prefect.engine.serializers import JSONSerializer
from prefect.schedules import IntervalSchedule
from prefect.run_configs import KubernetesRun
from prefect.storage import S3

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Any
import logging

# Configure Prefect
from prefect.config import config
config.logging.level = "INFO"

@task(max_retries=3, retry_delay=timedelta(minutes=2))
def extract_data_from_source(
    source_config: Dict[str, Any], 
    execution_date: str
) -> pd.DataFrame:
    """Extract data from various sources with retry logic"""
    
    source_type = source_config['type']
    
    if source_type == 'database':
        return extract_from_database(source_config, execution_date)
    elif source_type == 'api':
        return extract_from_api(source_config, execution_date)
    elif source_type == 's3':
        return extract_from_s3(source_config, execution_date)
    else:
        raise ValueError(f"Unsupported source type: {source_type}")

def extract_from_database(config: Dict, execution_date: str) -> pd.DataFrame:
    """Extract data from database"""
    from sqlalchemy import create_engine
    
    connection_string = config['connection_string']
    query = config['query']
    
    # Replace template variables
    query = query.replace('{{execution_date}}', execution_date)
    
    engine = create_engine(connection_string)
    df = pd.read_sql(query, engine)
    
    logging.info(f"Extracted {len(df)} rows from database")
    return df

def extract_from_api(config: Dict, execution_date: str) -> pd.DataFrame:
    """Extract data from API with pagination"""
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    
    base_url = config['url']
    headers = config.get('headers', {})
    params = config.get('params', {})
    
    # Setup retry strategy
    retry_strategy = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    
    session = requests.Session()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    
    all_data = []
    page = 1
    max_pages = config.get('max_pages', 100)
    
    while page <= max_pages:
        params['page'] = page
        response = session.get(base_url, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        
        data = response.json()
        
        # Extract data from response
        if config.get('data_path'):
            for key in config['data_path'].split('.'):
                data = data[key]
        
        if not data:
            break
        
        all_data.extend(data)
        page += 1
        
        logging.info(f"Extracted page {page-1}, total records: {len(all_data)}")
    
    df = pd.json_normalize(all_data)
    logging.info(f"Extracted {len(df)} rows from API")
    return df

@task(max_retries=2, retry_delay=timedelta(minutes=1))
def validate_data_quality(
    df: pd.DataFrame, 
    quality_rules: List[Dict[str, Any]]
) -> pd.DataFrame:
    """Validate data quality with configurable rules"""
    
    quality_results = []
    
    for rule in quality_rules:
        rule_name = rule['name']
        rule_type = rule['type']
        
        if rule_type == 'not_null':
            columns = rule['columns']
            for col in columns:
                null_count = df[col].isnull().sum()
                total_count = len(df)
                null_percentage = (null_count / total_count) * 100
                
                max_null_percentage = rule.get('max_null_percentage', 0)
                passed = null_percentage <= max_null_percentage
                
                quality_results.append({
                    'rule_name': f"{rule_name}_{col}",
                    'rule_type': rule_type,
                    'column': col,
                    'null_count': null_count,
                    'null_percentage': null_percentage,
                    'max_allowed': max_null_percentage,
                    'passed': passed
                })
        
        elif rule_type == 'unique':
            columns = rule['columns']
            for col in columns:
                total_count = len(df)
                unique_count = df[col].nunique()
                duplicate_count = total_count - unique_count
                
                max_duplicates = rule.get('max_duplicates', 0)
                passed = duplicate_count <= max_duplicates
                
                quality_results.append({
                    'rule_name': f"{rule_name}_{col}",
                    'rule_type': rule_type,
                    'column': col,
                    'duplicate_count': duplicate_count,
                    'max_allowed': max_duplicates,
                    'passed': passed
                })
        
        elif rule_type == 'range':
            column = rule['column']
            min_val = rule.get('min_value')
            max_val = rule.get('max_value')
            
            if min_val is not None:
                below_min = (df[column] < min_val).sum()
            else:
                below_min = 0
            
            if max_val is not None:
                above_max = (df[column] > max_val).sum()
            else:
                above_max = 0
            
            out_of_range = below_min + above_max
            passed = out_of_range == 0
            
            quality_results.append({
                'rule_name': rule_name,
                'rule_type': rule_type,
                'column': column,
                'out_of_range_count': out_of_range,
                'below_min': below_min,
                'above_max': above_max,
                'passed': passed
            })
    
    # Check if any rules failed
    failed_rules = [r for r in quality_results if not r['passed']]
    
    if failed_rules:
        error_msg = f"Data quality validation failed. {len(failed_rules)} rules failed."
        logging.error(error_msg)
        
        for failed_rule in failed_rules:
            logging.error(f"Failed rule: {failed_rule}")
        
        # You can choose to raise an exception or just log warnings
        fail_on_quality_issues = True  # Make this configurable
        if fail_on_quality_issues:
            raise ValueError(error_msg)
    
    logging.info(f"Data quality validation completed. {len(quality_results)} rules checked.")
    return df

@task(max_retries=2, retry_delay=timedelta(minutes=1))
def transform_data(
    df: pd.DataFrame, 
    transformations: List[Dict[str, Any]]
) -> pd.DataFrame:
    """Apply configured transformations to the data"""
    
    for transformation in transformations:
        transform_type = transformation['type']
        
        if transform_type == 'add_column':
            column_name = transformation['column_name']
            expression = transformation['expression']
            
            # Simple expression evaluation (can be extended)
            if expression == 'current_timestamp':
                df[column_name] = pd.Timestamp.now()
            elif expression.startswith('concat'):
                # Example: concat(col1, col2, separator='-')
                # Parse and apply concatenation
                pass
            else:
                # Use eval for simple expressions (be careful in production)
                df[column_name] = df.eval(expression)
        
        elif transform_type == 'rename_column':
            old_name = transformation['old_name']
            new_name = transformation['new_name']
            df = df.rename(columns={old_name: new_name})
        
        elif transform_type == 'drop_column':
            columns_to_drop = transformation['columns']
            df = df.drop(columns=columns_to_drop, errors='ignore')
        
        elif transform_type == 'type_conversion':
            column = transformation['column']
            target_type = transformation['target_type']
            
            if target_type == 'datetime':
                df[column] = pd.to_datetime(df[column], errors='coerce')
            elif target_type == 'numeric':
                df[column] = pd.to_numeric(df[column], errors='coerce')
            elif target_type == 'string':
                df[column] = df[column].astype(str)
        
        elif transform_type == 'filter_rows':
            condition = transformation['condition']
            # Apply row filtering based on condition
            df = df.query(condition)
        
        elif transform_type == 'aggregate':
            group_by = transformation['group_by']
            aggregations = transformation['aggregations']
            df = df.groupby(group_by).agg(aggregations).reset_index()
        
        elif transform_type == 'join':
            # This would require another dataframe - implement as needed
            pass
    
    logging.info(f"Applied {len(transformations)} transformations. Result shape: {df.shape}")
    return df

@task(max_retries=3, retry_delay=timedelta(minutes=2))
def load_data_to_destination(
    df: pd.DataFrame,
    destination_config: Dict[str, Any]
) -> str:
    """Load data to various destinations"""
    
    destination_type = destination_config['type']
    
    if destination_type == 'database':
        return load_to_database(df, destination_config)
    elif destination_type == 's3':
        return load_to_s3(df, destination_config)
    elif destination_type == 'data_warehouse':
        return load_to_data_warehouse(df, destination_config)
    else:
        raise ValueError(f"Unsupported destination type: {destination_type}")

def load_to_database(df: pd.DataFrame, config: Dict) -> str:
    """Load data to database"""
    from sqlalchemy import create_engine
    
    connection_string = config['connection_string']
    table_name = config['table_name']
    if_exists = config.get('if_exists', 'replace')
    
    engine = create_engine(connection_string)
    
    df.to_sql(
        name=table_name,
        con=engine,
        if_exists=if_exists,
        index=False,
        method='multi',
        chunksize=1000
    )
    
    logging.info(f"Loaded {len(df)} rows to {table_name}")
    return f"Database table: {table_name}"

def load_to_s3(df: pd.DataFrame, config: Dict) -> str:
    """Load data to S3"""
    import boto3
    from io import BytesIO
    
    bucket = config['bucket']
    key = config['key']
    file_format = config.get('format', 'parquet')
    
    # Prepare data
    if file_format == 'parquet':
        buffer = BytesIO()
        df.to_parquet(buffer, index=False, compression='snappy')
        data = buffer.getvalue()
    elif file_format == 'csv':
        data = df.to_csv(index=False).encode('utf-8')
    else:
        raise ValueError(f"Unsupported file format: {file_format}")
    
    # Upload to S3
    s3_client = boto3.client('s3')
    s3_client.put_object(Bucket=bucket, Key=key, Body=data)
    
    s3_path = f"s3://{bucket}/{key}"
    logging.info(f"Loaded {len(df)} rows to {s3_path}")
    return s3_path

@task
def send_completion_notification(
    pipeline_name: str,
    execution_date: str,
    records_processed: int,
    execution_time: float
) -> None:
    """Send pipeline completion notification"""
    
    message = f"""
    Pipeline Execution Completed Successfully
    
    Pipeline: {pipeline_name}
    Execution Date: {execution_date}
    Records Processed: {records_processed:,}
    Execution Time: {execution_time:.2f} seconds
    """
    
    # Send to Slack (configure webhook URL)
    slack_task = SlackTask(
        message=message,
        webhook_secret="SLACK_WEBHOOK_URL"
    )
    
    # You can also send email notifications here
    logging.info("Completion notification sent")

# Flow Definition
def create_etl_flow(pipeline_config: Dict[str, Any]) -> Flow:
    """Create ETL flow from configuration"""
    
    pipeline_name = pipeline_config['name']
    
    with Flow(
        name=f"{pipeline_name}_etl_flow",
        schedule=IntervalSchedule(interval=timedelta(hours=pipeline_config.get('interval_hours', 24))),
        result=S3Result(bucket="prefect-results"),
        run_config=KubernetesRun(
            image="my-etl-image:latest",
            cpu_request="1",
            memory_request="2Gi",
            cpu_limit="2",
            memory_limit="4Gi"
        ),
        storage=S3(bucket="prefect-flows", key=f"flows/{pipeline_name}.flow")
    ) as flow:
        
        # Parameters
        execution_date = Parameter("execution_date", default=datetime.now().strftime("%Y-%m-%d"))
        
        # Extract data from multiple sources
        extracted_datasets = []
        for source_name, source_config in pipeline_config['sources'].items():
            dataset = extract_data_from_source(source_config, execution_date)
            extracted_datasets.append(dataset)
        
        # Combine datasets if multiple sources
        if len(extracted_datasets) > 1:
            # Implement dataset combination logic
            combined_data = extracted_datasets[0]  # Simplified
        else:
            combined_data = extracted_datasets[0]
        
        # Validate data quality
        validated_data = validate_data_quality(
            combined_data, 
            pipeline_config.get('quality_rules', [])
        )
        
        # Transform data
        transformed_data = transform_data(
            validated_data,
            pipeline_config.get('transformations', [])
        )
        
        # Load to destinations
        load_results = []
        for dest_name, dest_config in pipeline_config['destinations'].items():
            result = load_data_to_destination(transformed_data, dest_config)
            load_results.append(result)
        
        # Send completion notification
        send_completion_notification(
            pipeline_name,
            execution_date,
            transformed_data.map(len),  # This would need to be handled properly
            flow.run_config.estimated_duration if hasattr(flow.run_config, 'estimated_duration') else 0
        )
    
    return flow

# Example usage
if __name__ == "__main__":
    sample_config = {
        "name": "user_analytics",
        "interval_hours": 6,
        "sources": {
            "user_events": {
                "type": "database",
                "connection_string": "postgresql://user:pass@host:5432/db",
                "query": "SELECT * FROM user_events WHERE created_at >= '{{execution_date}}'"
            },
            "user_profiles": {
                "type": "api",
                "url": "https://api.example.com/users",
                "headers": {"Authorization": "Bearer token"},
                "data_path": "data.users"
            }
        },
        "quality_rules": [
            {
                "name": "user_id_not_null",
                "type": "not_null",
                "columns": ["user_id"],
                "max_null_percentage": 0
            },
            {
                "name": "email_unique",
                "type": "unique",
                "columns": ["email"],
                "max_duplicates": 0
            }
        ],
        "transformations": [
            {
                "type": "add_column",
                "column_name": "processed_at",
                "expression": "current_timestamp"
            },
            {
                "type": "type_conversion",
                "column": "created_at",
                "target_type": "datetime"
            }
        ],
        "destinations": {
            "data_warehouse": {
                "type": "database",
                "connection_string": "postgresql://user:pass@dw-host:5432/dwh",
                "table_name": "user_analytics",
                "if_exists": "append"
            },
            "data_lake": {
                "type": "s3",
                "bucket": "data-lake",
                "key": "analytics/user_analytics/{{execution_date}}/data.parquet",
                "format": "parquet"
            }
        }
    }
    
    flow = create_etl_flow(sample_config)
    
    # Register flow with Prefect Cloud/Server
    flow.register(project_name="etl-pipelines")
```

## Performance Optimization and Monitoring

### Airflow Performance Tuning

```python
# airflow_optimization.py
from airflow.configuration import conf
from airflow.models import DAG, Variable
from airflow.operators.python import PythonOperator
from airflow.operators.dummy import DummyOperator
from airflow.sensors.base import BaseSensorOperator
from airflow.utils.task_group import TaskGroup
from airflow.utils.dates import days_ago
from airflow.utils.trigger_rule import TriggerRule

import os
import psutil
import time
from datetime import datetime, timedelta
from typing import Dict, List, Any

class OptimizedDAGConfig:
    """Configuration class for optimized DAG settings"""
    
    @staticmethod
    def get_optimized_default_args() -> Dict[str, Any]:
        """Get optimized default arguments for DAGs"""
        return {
            'owner': 'data-team',
            'depends_on_past': False,
            'start_date': days_ago(1),
            'email_on_failure': True,
            'email_on_retry': False,
            'retries': 3,
            'retry_delay': timedelta(minutes=5),
            'max_active_runs': 1,
            'catchup': False,
            
            # Performance optimizations
            'pool': 'default_pool',
            'priority_weight': 1,
            'weight_rule': 'absolute',
            'queue': 'default',
            
            # Resource limits
            'task_concurrency': 4,
            'max_active_tasks': 16,
        }
    
    @staticmethod
    def configure_pools():
        """Configure Airflow pools for resource management"""
        from airflow.models import Pool
        from airflow import settings
        
        session = settings.Session()
        
        # Define pools
        pools = [
            {'pool': 'cpu_intensive_pool', 'slots': 4, 'description': 'For CPU intensive tasks'},
            {'pool': 'memory_intensive_pool', 'slots': 2, 'description': 'For memory intensive tasks'},
            {'pool': 'database_pool', 'slots': 8, 'description': 'For database operations'},
            {'pool': 'api_pool', 'slots': 10, 'description': 'For API calls'},
            {'pool': 'file_io_pool', 'slots': 6, 'description': 'For file I/O operations'},
        ]
        
        for pool_config in pools:
            pool = session.query(Pool).filter(Pool.pool == pool_config['pool']).first()
            if not pool:
                pool = Pool(
                    pool=pool_config['pool'],
                    slots=pool_config['slots'],
                    description=pool_config['description']
                )
                session.add(pool)
        
        session.commit()
        session.close()

class PerformanceMonitoringOperator(BaseOperator):
    """Operator to monitor DAG and task performance"""
    
    template_fields = ['dag_id', 'task_id']
    
    @apply_defaults
    def __init__(
        self,
        monitored_dag_id: str,
        performance_thresholds: Dict[str, Any],
        *args,
        **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.monitored_dag_id = monitored_dag_id
        self.performance_thresholds = performance_thresholds
    
    def execute(self, context):
        from airflow.models import DagRun, TaskInstance
        from airflow import settings
        
        session = settings.Session()
        
        # Get recent DAG runs
        recent_runs = session.query(DagRun).filter(
            DagRun.dag_id == self.monitored_dag_id,
            DagRun.end_date.isnot(None)
        ).order_by(DagRun.end_date.desc()).limit(10).all()
        
        performance_metrics = []
        
        for dag_run in recent_runs:
            # Calculate DAG run duration
            duration = (dag_run.end_date - dag_run.start_date).total_seconds()
            
            # Get task instances for this DAG run
            task_instances = session.query(TaskInstance).filter(
                TaskInstance.dag_id == self.monitored_dag_id,
                TaskInstance.execution_date == dag_run.execution_date
            ).all()
            
            # Calculate task-level metrics
            task_metrics = {}
            for task_instance in task_instances:
                if task_instance.end_date and task_instance.start_date:
                    task_duration = (task_instance.end_date - task_instance.start_date).total_seconds()
                    task_metrics[task_instance.task_id] = {
                        'duration': task_duration,
                        'state': task_instance.state,
                        'try_number': task_instance.try_number,
                        'queue': task_instance.queue,
                        'pool': task_instance.pool,
                    }
            
            run_metrics = {
                'execution_date': dag_run.execution_date,
                'duration': duration,
                'state': dag_run.state,
                'task_count': len(task_instances),
                'task_metrics': task_metrics
            }
            
            performance_metrics.append(run_metrics)
        
        session.close()
        
        # Analyze performance and generate alerts
        self._analyze_performance(performance_metrics)
        
        return performance_metrics
    
    def _analyze_performance(self, metrics: List[Dict]):
        """Analyze performance metrics and generate alerts"""
        
        if not metrics:
            return
        
        # Calculate average duration
        avg_duration = sum(m['duration'] for m in metrics) / len(metrics)
        max_duration = max(m['duration'] for m in metrics)
        
        # Check against thresholds
        duration_threshold = self.performance_thresholds.get('max_duration_seconds', 3600)
        
        if avg_duration > duration_threshold:
            self.log.warning(
                f"DAG {self.monitored_dag_id} average duration ({avg_duration:.2f}s) "
                f"exceeds threshold ({duration_threshold}s)"
            )
        
        if max_duration > duration_threshold * 1.5:
            self.log.error(
                f"DAG {self.monitored_dag_id} max duration ({max_duration:.2f}s) "
                f"significantly exceeds threshold"
            )
        
        # Analyze task-level performance
        task_durations = {}
        for run_metric in metrics:
            for task_id, task_metric in run_metric['task_metrics'].items():
                if task_id not in task_durations:
                    task_durations[task_id] = []
                task_durations[task_id].append(task_metric['duration'])
        
        # Identify slow tasks
        for task_id, durations in task_durations.items():
            avg_task_duration = sum(durations) / len(durations)
            task_threshold = self.performance_thresholds.get('max_task_duration_seconds', 1800)
            
            if avg_task_duration > task_threshold:
                self.log.warning(
                    f"Task {task_id} average duration ({avg_task_duration:.2f}s) "
                    f"exceeds threshold ({task_threshold}s)"
                )

def create_resource_monitoring_task():
    """Create task to monitor system resources"""
    
    def monitor_resources(**context):
        # Get system resource usage
        cpu_percent = psutil.cpu_percent(interval=1)
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage('/')
        
        # Get Airflow-specific metrics
        from airflow.models import TaskInstance
        from airflow import settings
        
        session = settings.Session()
        
        # Count running tasks
        running_tasks = session.query(TaskInstance).filter(
            TaskInstance.state == 'running'
        ).count()
        
        # Count queued tasks
        queued_tasks = session.query(TaskInstance).filter(
            TaskInstance.state == 'queued'
        ).count()
        
        session.close()
        
        metrics = {
            'timestamp': datetime.now().isoformat(),
            'cpu_percent': cpu_percent,
            'memory_percent': memory.percent,
            'memory_available_gb': memory.available / (1024**3),
            'disk_percent': disk.percent,
            'disk_free_gb': disk.free / (1024**3),
            'running_tasks': running_tasks,
            'queued_tasks': queued_tasks,
        }
        
        # Log metrics
        logging.info(f"Resource metrics: {metrics}")
        
        # Check thresholds and alert if necessary
        if cpu_percent > 80:
            logging.warning(f"High CPU usage: {cpu_percent}%")
        
        if memory.percent > 85:
            logging.warning(f"High memory usage: {memory.percent}%")
        
        if running_tasks > 20:
            logging.warning(f"High number of running tasks: {running_tasks}")
        
        # Store metrics (you could send to monitoring system)
        Variable.set("last_resource_metrics", metrics, serialize_json=True)
        
        return metrics
    
    return PythonOperator(
        task_id='monitor_resources',
        python_callable=monitor_resources,
        pool='default_pool',
        pool_slots=1,
    )

# Optimized DAG example
def create_optimized_etl_dag():
    """Create an optimized ETL DAG with performance considerations"""
    
    default_args = OptimizedDAGConfig.get_optimized_default_args()
    
    dag = DAG(
        'optimized_etl_pipeline',
        default_args=default_args,
        description='High-performance ETL pipeline',
        schedule_interval='@hourly',
        max_active_runs=1,
        max_active_tasks=16,
        tags=['etl', 'optimized', 'production'],
    )
    
    with dag:
        start = DummyOperator(task_id='start')
        
        # Resource monitoring
        monitor_task = create_resource_monitoring_task()
        
        # Extraction tasks (parallel)
        with TaskGroup(group_id='extract_data') as extract_group:
            extract_db = PythonOperator(
                task_id='extract_from_database',
                python_callable=lambda: None,  # Your extraction function
                pool='database_pool',
                pool_slots=2,
            )
            
            extract_api = PythonOperator(
                task_id='extract_from_api',
                python_callable=lambda: None,  # Your API extraction function
                pool='api_pool',
                pool_slots=1,
            )
            
            extract_files = PythonOperator(
                task_id='extract_from_files',
                python_callable=lambda: None,  # Your file extraction function
                pool='file_io_pool',
                pool_slots=1,
            )
        
        # Data quality checks
        quality_check = DataQualityOperator(
            task_id='data_quality_check',
            postgres_conn_id='warehouse_db',
            table_name='staging_table',
            quality_checks=[
                {'name': 'row_count', 'sql': 'SELECT COUNT(*) FROM {table_name}', 'expected_result': 0, 'operator': '>'},
                {'name': 'null_check', 'sql': 'SELECT COUNT(*) FROM {table_name} WHERE id IS NULL', 'expected_result': 0},
            ],
            pool='database_pool',
            pool_slots=1,
        )
        
        # Transformation tasks
        with TaskGroup(group_id='transform_data') as transform_group:
            transform_users = PythonOperator(
                task_id='transform_user_data',
                python_callable=lambda: None,  # Your transformation function
                pool='cpu_intensive_pool',
                pool_slots=1,
            )
            
            transform_events = PythonOperator(
                task_id='transform_event_data',
                python_callable=lambda: None,  # Your transformation function
                pool='cpu_intensive_pool',
                pool_slots=1,
            )
        
        # Loading task
        load_data = SmartDataTransferOperator(
            task_id='load_to_warehouse',
            source_conn_id='staging_db',
            destination_conn_id='warehouse_db',
            sql='SELECT * FROM staging_table',
            destination_path='fact_table',
            chunk_size=10000,
            pool='database_pool',
            pool_slots=2,
        )
        
        # Performance monitoring
        perf_monitor = PerformanceMonitoringOperator(
            task_id='monitor_performance',
            monitored_dag_id='optimized_etl_pipeline',
            performance_thresholds={
                'max_duration_seconds': 3600,
                'max_task_duration_seconds': 1800,
            },
        )
        
        end = DummyOperator(
            task_id='end',
            trigger_rule=TriggerRule.NONE_FAILED_OR_SKIPPED
        )
        
        # Set dependencies
        start >> monitor_task
        start >> extract_group >> quality_check >> transform_group >> load_data
        [load_data, monitor_task] >> perf_monitor >> end
    
    return dag

# Create the DAG
optimized_dag = create_optimized_etl_dag()
```

## Production Deployment

### Kubernetes Deployment Configuration

```yaml
# airflow-deployment.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: airflow-config
  namespace: data-platform
data:
  airflow.cfg: |
    [core]
    dags_folder = /opt/airflow/dags
    base_log_folder = /opt/airflow/logs
    remote_logging = True
    remote_log_conn_id = aws_s3_logs
    encrypt_s3_logs = True
    
    executor = KubernetesExecutor
    sql_alchemy_conn = postgresql://airflow:password@postgres:5432/airflow
    parallelism = 32
    dag_concurrency = 16
    max_active_runs_per_dag = 1
    load_examples = False
    
    [kubernetes]
    namespace = data-platform
    airflow_configmap = airflow-config
    worker_container_repository = apache/airflow
    worker_container_tag = 2.7.0-python3.9
    delete_worker_pods = True
    delete_worker_pods_on_failure = False
    
    [webserver]
    base_url = https://airflow.data-platform.com
    web_server_port = 8080
    workers = 4
    
    [scheduler]
    catchup_by_default = False
    dag_dir_list_interval = 300
    child_process_timeout = 600
    max_threads = 2
    
    [celery]
    worker_concurrency = 4
    
    [email]
    email_backend = airflow.providers.sendgrid.utils.emailer.send_email
    
    [logging]
    logging_level = INFO
    fab_logging_level = WARN
    
  webserver_config.py: |
    from airflow import configuration as conf
    from flask_appbuilder.security.manager import AUTH_OAUTH
    
    AUTH_TYPE = AUTH_OAUTH
    AUTH_USER_REGISTRATION = True
    AUTH_USER_REGISTRATION_ROLE = "Viewer"
    
    OAUTH_PROVIDERS = [
        {
            'name': 'google',
            'token_key': 'access_token',
            'icon': 'fa-google',
            'remote_app': {
                'client_id': 'GOOGLE_CLIENT_ID',
                'client_secret': 'GOOGLE_CLIENT_SECRET',
                'api_base_url': 'https://www.googleapis.com/oauth2/v2/',
                'client_kwargs': {
                    'scope': 'email profile'
                },
                'server_metadata_url': 'https://accounts.google.com/.well-known/openid_configuration'
            }
        }
    ]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: airflow-webserver
  namespace: data-platform
spec:
  replicas: 2
  selector:
    matchLabels:
      app: airflow-webserver
  template:
    metadata:
      labels:
        app: airflow-webserver
    spec:
      containers:
      - name: webserver
        image: apache/airflow:2.7.0-python3.9
        command: ["airflow", "webserver"]
        ports:
        - containerPort: 8080
        env:
        - name: AIRFLOW__CORE__SQL_ALCHEMY_CONN
          valueFrom:
            secretKeyRef:
              name: airflow-secrets
              key: sql_alchemy_conn
        - name: AIRFLOW__CORE__FERNET_KEY
          valueFrom:
            secretKeyRef:
              name: airflow-secrets
              key: fernet_key
        resources:
          requests:
            memory: "1Gi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
        volumeMounts:
        - name: config
          mountPath: /opt/airflow/airflow.cfg
          subPath: airflow.cfg
        - name: dags
          mountPath: /opt/airflow/dags
        - name: logs
          mountPath: /opt/airflow/logs
      volumes:
      - name: config
        configMap:
          name: airflow-config
      - name: dags
        persistentVolumeClaim:
          claimName: airflow-dags-pvc
      - name: logs
        persistentVolumeClaim:
          claimName: airflow-logs-pvc
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: airflow-scheduler
  namespace: data-platform
spec:
  replicas: 1
  selector:
    matchLabels:
      app: airflow-scheduler
  template:
    metadata:
      labels:
        app: airflow-scheduler
    spec:
      containers:
      - name: scheduler
        image: apache/airflow:2.7.0-python3.9
        command: ["airflow", "scheduler"]
        env:
        - name: AIRFLOW__CORE__SQL_ALCHEMY_CONN
          valueFrom:
            secretKeyRef:
              name: airflow-secrets
              key: sql_alchemy_conn
        - name: AIRFLOW__CORE__FERNET_KEY
          valueFrom:
            secretKeyRef:
              name: airflow-secrets
              key: fernet_key
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "2000m"
        volumeMounts:
        - name: config
          mountPath: /opt/airflow/airflow.cfg
          subPath: airflow.cfg
        - name: dags
          mountPath: /opt/airflow/dags
        - name: logs
          mountPath: /opt/airflow/logs
      volumes:
      - name: config
        configMap:
          name: airflow-config
      - name: dags
        persistentVolumeClaim:
          claimName: airflow-dags-pvc
      - name: logs
        persistentVolumeClaim:
          claimName: airflow-logs-pvc
---
# Prefect Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prefect-server
  namespace: data-platform
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prefect-server
  template:
    metadata:
      labels:
        app: prefect-server
    spec:
      containers:
      - name: prefect-server
        image: prefecthq/prefect:2.0.0-python3.9
        command: ["prefect", "server", "start"]
        ports:
        - containerPort: 4200
        env:
        - name: PREFECT_API_DATABASE_CONNECTION_URL
          valueFrom:
            secretKeyRef:
              name: prefect-secrets
              key: database_url
        - name: PREFECT_SERVER_API_HOST
          value: "0.0.0.0"
        - name: PREFECT_SERVER_API_PORT
          value: "4200"
        resources:
          requests:
            memory: "1Gi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
---
apiVersion: v1
kind: Service
metadata:
  name: airflow-webserver
  namespace: data-platform
spec:
  selector:
    app: airflow-webserver
  ports:
  - port: 8080
    targetPort: 8080
  type: LoadBalancer
---
apiVersion: v1
kind: Service
metadata:
  name: prefect-server
  namespace: data-platform
spec:
  selector:
    app: prefect-server
  ports:
  - port: 4200
    targetPort: 4200
  type: LoadBalancer
```

## Conclusion

Advanced ETL/ELT pipeline development with Airflow and Prefect enables building sophisticated, scalable data orchestration solutions. Key advantages include:

**Apache Airflow Strengths:**
- Mature ecosystem with extensive operator library
- Strong community support and enterprise adoption
- Rich UI and monitoring capabilities
- Flexible scheduling and dependency management

**Prefect Advantages:**
- Modern Python-native design
- Better error handling and retry mechanisms
- Simplified deployment and scaling
- Advanced flow versioning and parameterization

**Best Practices for Production:**
1. Implement comprehensive monitoring and alerting
2. Use resource pools for efficient resource management
3. Design for fault tolerance with proper retry strategies
4. Optimize for performance with parallel processing
5. Implement proper data quality validation
6. Use infrastructure as code for consistent deployments
7. Follow security best practices for credentials and access control

Both platforms provide powerful capabilities for building enterprise-grade data pipelines that can handle complex data transformation requirements while maintaining reliability, observability, and scalability.