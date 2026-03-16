---
title: "Elasticsearch Cluster Sizing and Optimization: Enterprise Production Guide"
date: 2026-06-22T00:00:00-05:00
draft: false
tags: ["Elasticsearch", "Cluster Sizing", "Performance Optimization", "Search Engine", "Data Indexing", "Capacity Planning", "Production", "Enterprise"]
categories: ["Database", "Storage", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Elasticsearch cluster sizing with comprehensive guidance on capacity planning, hardware selection, shard optimization, and performance tuning for enterprise search workloads."
more_link: "yes"
url: "/elasticsearch-cluster-sizing-production-guide/"
---

Elasticsearch cluster sizing is one of the most critical aspects of deploying a production-ready search infrastructure. Improper sizing leads to performance degradation, data loss, and costly over-provisioning. This comprehensive guide covers enterprise-grade cluster sizing, capacity planning, and optimization strategies based on real-world production deployments.

<!--more-->

# Elasticsearch Cluster Sizing and Optimization: Enterprise Production Guide

## Executive Summary

Elasticsearch cluster sizing requires balancing multiple factors: data volume, indexing rate, query patterns, retention requirements, and availability needs. This guide provides a systematic approach to sizing Elasticsearch clusters for enterprise workloads, covering hardware selection, shard strategy, memory management, and performance optimization. We'll explore production-tested configurations that handle billions of documents and petabytes of data.

## Understanding Elasticsearch Architecture

### Cluster Components

Before sizing a cluster, understand the roles and resource requirements:

```yaml
# Node role configurations
---
# Master-eligible node (cluster coordination)
node.roles: [ master ]
node.attr.type: master

# Data node (hot tier - recent data)
node.roles: [ data_hot, data_content ]
node.attr.type: hot

# Data node (warm tier - older data)
node.roles: [ data_warm, data_content ]
node.attr.type: warm

# Data node (cold tier - archived data)
node.roles: [ data_cold, data_content ]
node.attr.type: cold

# Data node (frozen tier - searchable snapshots)
node.roles: [ data_frozen ]
node.attr.type: frozen

# Coordinating node (query routing)
node.roles: []
node.attr.type: coordinating

# Ingest node (data preprocessing)
node.roles: [ ingest ]
node.attr.type: ingest

# Machine learning node
node.roles: [ ml, remote_cluster_client ]
node.attr.type: ml
```

### Resource Requirements by Role

```yaml
# elasticsearch-values.yaml for Kubernetes deployment
---
# Master nodes: Lightweight, focus on cluster state management
master:
  replicas: 3  # Always use odd number for quorum
  resources:
    requests:
      cpu: "2"
      memory: "4Gi"
    limits:
      cpu: "4"
      memory: "4Gi"
  persistence:
    size: "50Gi"  # Small, just cluster state
  heapSize: "2g"

# Hot nodes: High-performance, NVMe storage
hot:
  replicas: 3
  resources:
    requests:
      cpu: "8"
      memory: "32Gi"
    limits:
      cpu: "16"
      memory: "32Gi"
  persistence:
    storageClass: "fast-nvme"
    size: "1Ti"
  heapSize: "16g"  # 50% of RAM, max 31GB

# Warm nodes: Balanced performance, larger storage
warm:
  replicas: 3
  resources:
    requests:
      cpu: "4"
      memory: "16Gi"
    limits:
      cpu: "8"
      memory: "16Gi"
  persistence:
    storageClass: "standard-ssd"
    size: "4Ti"
  heapSize: "8g"

# Cold nodes: Cost-optimized, HDD storage
cold:
  replicas: 2
  resources:
    requests:
      cpu: "2"
      memory: "8Gi"
    limits:
      cpu: "4"
      memory: "8Gi"
  persistence:
    storageClass: "standard-hdd"
    size: "10Ti"
  heapSize: "4g"

# Coordinating nodes: Query routing and aggregation
coordinating:
  replicas: 2
  resources:
    requests:
      cpu: "4"
      memory: "16Gi"
    limits:
      cpu: "8"
      memory: "16Gi"
  heapSize: "8g"
```

## Capacity Planning Methodology

### Data Volume Calculation

```python
#!/usr/bin/env python3
"""
Elasticsearch capacity planning calculator
"""
import math
from dataclasses import dataclass
from typing import Dict, List

@dataclass
class DataProfile:
    """Data characteristics for capacity planning"""
    avg_doc_size_bytes: int
    docs_per_day: int
    retention_days: int
    replicas: int  # Number of replica shards
    overhead_factor: float = 1.15  # 15% overhead for segments, deleted docs

@dataclass
class IndexingProfile:
    """Indexing characteristics"""
    peak_docs_per_second: int
    bulk_size: int = 1000
    refresh_interval_seconds: int = 30

@dataclass
class QueryProfile:
    """Query characteristics"""
    queries_per_second: int
    avg_query_latency_ms: int
    aggregation_heavy: bool = False

class ElasticsearchSizingCalculator:
    """Calculate Elasticsearch cluster sizing"""

    # Hardware profiles
    HOT_NODE_PROFILE = {
        'cpu_cores': 16,
        'memory_gb': 32,
        'storage_gb': 1000,
        'iops': 10000,
        'cost_per_month': 500
    }

    WARM_NODE_PROFILE = {
        'cpu_cores': 8,
        'memory_gb': 16,
        'storage_gb': 4000,
        'iops': 3000,
        'cost_per_month': 300
    }

    COLD_NODE_PROFILE = {
        'cpu_cores': 4,
        'memory_gb': 8,
        'storage_gb': 10000,
        'iops': 500,
        'cost_per_month': 200
    }

    def __init__(self, data: DataProfile, indexing: IndexingProfile, query: QueryProfile):
        self.data = data
        self.indexing = indexing
        self.query = query

    def calculate_total_storage(self) -> Dict[str, float]:
        """Calculate total storage requirements"""
        total_docs = self.data.docs_per_day * self.data.retention_days
        raw_size_gb = (total_docs * self.data.avg_doc_size_bytes) / (1024**3)

        # Apply overhead and replication
        with_overhead = raw_size_gb * self.data.overhead_factor
        with_replication = with_overhead * (1 + self.data.replicas)

        return {
            'total_documents': total_docs,
            'raw_size_gb': raw_size_gb,
            'with_overhead_gb': with_overhead,
            'with_replication_gb': with_replication,
            'primary_shards_size_gb': with_overhead,
            'replica_shards_size_gb': with_overhead * self.data.replicas
        }

    def calculate_shard_configuration(self, target_shard_size_gb: int = 50) -> Dict[str, int]:
        """
        Calculate optimal shard configuration
        Target shard size: 20-50GB for optimal performance
        """
        storage = self.calculate_total_storage()
        primary_size = storage['primary_shards_size_gb']

        # Calculate number of primary shards
        num_primary_shards = math.ceil(primary_size / target_shard_size_gb)

        # Ensure minimum shards for parallelism
        min_shards = 3
        num_primary_shards = max(num_primary_shards, min_shards)

        # Calculate actual shard size
        actual_shard_size_gb = primary_size / num_primary_shards

        return {
            'primary_shards': num_primary_shards,
            'replica_shards': self.data.replicas,
            'total_shards': num_primary_shards * (1 + self.data.replicas),
            'shard_size_gb': actual_shard_size_gb
        }

    def calculate_indexing_resources(self) -> Dict[str, any]:
        """Calculate resources needed for indexing workload"""
        # Each indexing thread can handle ~5000-10000 docs/sec with bulk
        docs_per_thread = 7500

        # Calculate required threads
        threads_needed = math.ceil(self.indexing.peak_docs_per_second / docs_per_thread)

        # Each thread needs ~1 CPU core
        cpu_cores = threads_needed

        # Memory for indexing buffer (default 10% of heap)
        # Heap should be 50% of RAM, max 31GB
        indexing_buffer_mb = 1024  # 1GB per node
        heap_mb = indexing_buffer_mb * 10
        total_memory_gb = (heap_mb / 1024) * 2

        return {
            'indexing_threads': threads_needed,
            'cpu_cores_required': cpu_cores,
            'heap_size_gb': heap_mb / 1024,
            'total_memory_gb': total_memory_gb,
            'bulk_queue_size': threads_needed * 50
        }

    def calculate_query_resources(self) -> Dict[str, any]:
        """Calculate resources needed for query workload"""
        # Each query thread can handle ~100-500 queries/sec depending on complexity
        queries_per_thread = 200 if self.query.aggregation_heavy else 400

        threads_needed = math.ceil(self.query.queries_per_second / queries_per_thread)

        # Query cache and field data cache sizing
        heap_for_caches_gb = 8 if self.query.aggregation_heavy else 4

        return {
            'query_threads': threads_needed,
            'cpu_cores_required': threads_needed,
            'heap_for_caches_gb': heap_for_caches_gb,
            'coordinating_nodes': max(2, math.ceil(threads_needed / 4))
        }

    def recommend_hot_tier(self) -> Dict[str, any]:
        """Recommend hot tier configuration (last 7 days)"""
        hot_days = min(7, self.data.retention_days)
        hot_docs = self.data.docs_per_day * hot_days
        hot_size_gb = (hot_docs * self.data.avg_doc_size_bytes) / (1024**3)
        hot_size_gb *= self.data.overhead_factor * (1 + self.data.replicas)

        # Indexing resources
        indexing = self.calculate_indexing_resources()

        # Query resources
        query = self.calculate_query_resources()

        # Combine resource requirements
        cpu_required = max(indexing['cpu_cores_required'], query['cpu_cores_required'])
        memory_required = indexing['total_memory_gb'] + query['heap_for_caches_gb']

        # Calculate number of nodes
        nodes = math.ceil(hot_size_gb / self.HOT_NODE_PROFILE['storage_gb'])
        nodes = max(nodes, math.ceil(cpu_required / self.HOT_NODE_PROFILE['cpu_cores']))
        nodes = max(nodes, 3)  # Minimum 3 for HA

        return {
            'tier': 'hot',
            'nodes': nodes,
            'node_profile': self.HOT_NODE_PROFILE,
            'total_storage_gb': hot_size_gb,
            'cpu_cores_per_node': self.HOT_NODE_PROFILE['cpu_cores'],
            'memory_per_node_gb': self.HOT_NODE_PROFILE['memory_gb'],
            'storage_per_node_gb': self.HOT_NODE_PROFILE['storage_gb'],
            'retention_days': hot_days,
            'monthly_cost': nodes * self.HOT_NODE_PROFILE['cost_per_month']
        }

    def recommend_warm_tier(self) -> Dict[str, any]:
        """Recommend warm tier configuration (8-30 days)"""
        if self.data.retention_days <= 7:
            return None

        warm_days = min(23, self.data.retention_days - 7)
        if warm_days <= 0:
            return None

        warm_docs = self.data.docs_per_day * warm_days
        warm_size_gb = (warm_docs * self.data.avg_doc_size_bytes) / (1024**3)
        warm_size_gb *= self.data.overhead_factor * (1 + self.data.replicas)

        nodes = math.ceil(warm_size_gb / self.WARM_NODE_PROFILE['storage_gb'])
        nodes = max(nodes, 3)

        return {
            'tier': 'warm',
            'nodes': nodes,
            'node_profile': self.WARM_NODE_PROFILE,
            'total_storage_gb': warm_size_gb,
            'cpu_cores_per_node': self.WARM_NODE_PROFILE['cpu_cores'],
            'memory_per_node_gb': self.WARM_NODE_PROFILE['memory_gb'],
            'storage_per_node_gb': self.WARM_NODE_PROFILE['storage_gb'],
            'retention_days': warm_days,
            'monthly_cost': nodes * self.WARM_NODE_PROFILE['cost_per_month']
        }

    def recommend_cold_tier(self) -> Dict[str, any]:
        """Recommend cold tier configuration (31+ days)"""
        if self.data.retention_days <= 30:
            return None

        cold_days = self.data.retention_days - 30
        cold_docs = self.data.docs_per_day * cold_days
        cold_size_gb = (cold_docs * self.data.avg_doc_size_bytes) / (1024**3)
        cold_size_gb *= self.data.overhead_factor * (1 + self.data.replicas)

        nodes = math.ceil(cold_size_gb / self.COLD_NODE_PROFILE['storage_gb'])
        nodes = max(nodes, 2)

        return {
            'tier': 'cold',
            'nodes': nodes,
            'node_profile': self.COLD_NODE_PROFILE,
            'total_storage_gb': cold_size_gb,
            'cpu_cores_per_node': self.COLD_NODE_PROFILE['cpu_cores'],
            'memory_per_node_gb': self.COLD_NODE_PROFILE['memory_gb'],
            'storage_per_node_gb': self.COLD_NODE_PROFILE['storage_gb'],
            'retention_days': cold_days,
            'monthly_cost': nodes * self.COLD_NODE_PROFILE['cost_per_month']
        }

    def generate_sizing_report(self) -> Dict[str, any]:
        """Generate complete sizing recommendation"""
        storage = self.calculate_total_storage()
        shards = self.calculate_shard_configuration()

        hot = self.recommend_hot_tier()
        warm = self.recommend_warm_tier()
        cold = self.recommend_cold_tier()

        total_nodes = 3  # Master nodes
        total_cost = 300  # Master nodes cost

        data_tiers = []

        if hot:
            data_tiers.append(hot)
            total_nodes += hot['nodes']
            total_cost += hot['monthly_cost']

        if warm:
            data_tiers.append(warm)
            total_nodes += warm['nodes']
            total_cost += warm['monthly_cost']

        if cold:
            data_tiers.append(cold)
            total_nodes += cold['nodes']
            total_cost += cold['monthly_cost']

        # Add coordinating nodes
        coordinating = self.calculate_query_resources()
        total_nodes += coordinating['coordinating_nodes']
        total_cost += coordinating['coordinating_nodes'] * 250

        return {
            'storage_requirements': storage,
            'shard_configuration': shards,
            'master_nodes': 3,
            'coordinating_nodes': coordinating['coordinating_nodes'],
            'data_tiers': data_tiers,
            'total_nodes': total_nodes,
            'monthly_cost_estimate': total_cost,
            'indexing_capacity': {
                'peak_docs_per_second': self.indexing.peak_docs_per_second,
                'daily_volume': self.data.docs_per_day
            },
            'query_capacity': {
                'queries_per_second': self.query.queries_per_second,
                'coordinating_nodes': coordinating['coordinating_nodes']
            }
        }

# Example usage
def main():
    """Example capacity planning calculation"""

    # Define workload profile
    data = DataProfile(
        avg_doc_size_bytes=2048,  # 2KB average document
        docs_per_day=100_000_000,  # 100M docs/day
        retention_days=90,         # 90 days retention
        replicas=1                 # 1 replica per primary
    )

    indexing = IndexingProfile(
        peak_docs_per_second=5000,  # Peak indexing rate
        bulk_size=1000,
        refresh_interval_seconds=30
    )

    query = QueryProfile(
        queries_per_second=1000,
        avg_query_latency_ms=100,
        aggregation_heavy=True
    )

    # Calculate sizing
    calculator = ElasticsearchSizingCalculator(data, indexing, query)
    report = calculator.generate_sizing_report()

    # Print report
    print("=" * 80)
    print("ELASTICSEARCH CLUSTER SIZING REPORT")
    print("=" * 80)
    print()

    print("STORAGE REQUIREMENTS:")
    storage = report['storage_requirements']
    print(f"  Total Documents: {storage['total_documents']:,}")
    print(f"  Raw Data Size: {storage['raw_size_gb']:.2f} GB")
    print(f"  With Overhead: {storage['with_overhead_gb']:.2f} GB")
    print(f"  With Replication: {storage['with_replication_gb']:.2f} GB")
    print()

    print("SHARD CONFIGURATION:")
    shards = report['shard_configuration']
    print(f"  Primary Shards: {shards['primary_shards']}")
    print(f"  Replica Shards: {shards['replica_shards']}")
    print(f"  Total Shards: {shards['total_shards']}")
    print(f"  Shard Size: {shards['shard_size_gb']:.2f} GB")
    print()

    print("CLUSTER ARCHITECTURE:")
    print(f"  Master Nodes: {report['master_nodes']}")
    print(f"  Coordinating Nodes: {report['coordinating_nodes']}")
    print()

    for tier in report['data_tiers']:
        print(f"  {tier['tier'].upper()} TIER:")
        print(f"    Nodes: {tier['nodes']}")
        print(f"    Storage per Node: {tier['storage_per_node_gb']} GB")
        print(f"    CPU per Node: {tier['cpu_cores_per_node']} cores")
        print(f"    Memory per Node: {tier['memory_per_node_gb']} GB")
        print(f"    Retention: {tier['retention_days']} days")
        print(f"    Monthly Cost: ${tier['monthly_cost']:,}")
        print()

    print(f"TOTAL CLUSTER SIZE:")
    print(f"  Total Nodes: {report['total_nodes']}")
    print(f"  Monthly Cost Estimate: ${report['monthly_cost_estimate']:,}")
    print()

    print("CAPACITY:")
    print(f"  Indexing: {report['indexing_capacity']['peak_docs_per_second']:,} docs/sec")
    print(f"  Daily Volume: {report['indexing_capacity']['daily_volume']:,} docs/day")
    print(f"  Query Capacity: {report['query_capacity']['queries_per_second']:,} queries/sec")
    print()

if __name__ == "__main__":
    main()
```

## Index Template and Mapping Strategy

### Production Index Template

```json
PUT _index_template/logs-template
{
  "index_patterns": ["logs-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "number_of_replicas": 1,
      "refresh_interval": "30s",
      "codec": "best_compression",

      "index.lifecycle.name": "logs-policy",
      "index.lifecycle.rollover_alias": "logs",

      "index.routing.allocation.require.type": "hot",

      "index.mapping.total_fields.limit": 2000,
      "index.mapping.depth.limit": 20,
      "index.mapping.nested_fields.limit": 100,

      "index.max_result_window": 10000,
      "index.max_inner_result_window": 100,
      "index.max_rescore_window": 10000,

      "index.translog.durability": "async",
      "index.translog.sync_interval": "30s",
      "index.translog.flush_threshold_size": "1gb",

      "index.merge.scheduler.max_thread_count": 1,

      "index.query.default_field": [
        "message",
        "error.message",
        "log.logger"
      ],

      "analysis": {
        "analyzer": {
          "default": {
            "type": "standard",
            "stopwords": "_english_"
          },
          "path_analyzer": {
            "tokenizer": "path_tokenizer"
          }
        },
        "tokenizer": {
          "path_tokenizer": {
            "type": "path_hierarchy",
            "delimiter": "/"
          }
        }
      }
    },
    "mappings": {
      "dynamic_templates": [
        {
          "strings_as_keywords": {
            "match_mapping_type": "string",
            "match": "*_id",
            "mapping": {
              "type": "keyword",
              "ignore_above": 256
            }
          }
        },
        {
          "strings_as_text": {
            "match_mapping_type": "string",
            "match": "*_message",
            "mapping": {
              "type": "text",
              "fields": {
                "keyword": {
                  "type": "keyword",
                  "ignore_above": 256
                }
              }
            }
          }
        }
      ],
      "properties": {
        "@timestamp": {
          "type": "date",
          "format": "strict_date_optional_time||epoch_millis"
        },
        "log": {
          "properties": {
            "level": {
              "type": "keyword"
            },
            "logger": {
              "type": "keyword"
            },
            "origin": {
              "properties": {
                "file": {
                  "properties": {
                    "name": {
                      "type": "keyword"
                    },
                    "line": {
                      "type": "integer"
                    }
                  }
                },
                "function": {
                  "type": "keyword"
                }
              }
            }
          }
        },
        "message": {
          "type": "text",
          "fields": {
            "keyword": {
              "type": "keyword",
              "ignore_above": 256
            }
          }
        },
        "service": {
          "properties": {
            "name": {
              "type": "keyword"
            },
            "version": {
              "type": "keyword"
            },
            "environment": {
              "type": "keyword"
            }
          }
        },
        "host": {
          "properties": {
            "name": {
              "type": "keyword"
            },
            "ip": {
              "type": "ip"
            },
            "architecture": {
              "type": "keyword"
            }
          }
        },
        "container": {
          "properties": {
            "id": {
              "type": "keyword"
            },
            "name": {
              "type": "keyword"
            },
            "image": {
              "properties": {
                "name": {
                  "type": "keyword"
                },
                "tag": {
                  "type": "keyword"
                }
              }
            }
          }
        },
        "kubernetes": {
          "properties": {
            "namespace": {
              "type": "keyword"
            },
            "pod": {
              "properties": {
                "name": {
                  "type": "keyword"
                },
                "uid": {
                  "type": "keyword"
                }
              }
            },
            "node": {
              "properties": {
                "name": {
                  "type": "keyword"
                }
              }
            }
          }
        },
        "error": {
          "properties": {
            "message": {
              "type": "text"
            },
            "stack_trace": {
              "type": "text",
              "index": false
            },
            "type": {
              "type": "keyword"
            }
          }
        },
        "http": {
          "properties": {
            "request": {
              "properties": {
                "method": {
                  "type": "keyword"
                },
                "body": {
                  "properties": {
                    "bytes": {
                      "type": "long"
                    }
                  }
                }
              }
            },
            "response": {
              "properties": {
                "status_code": {
                  "type": "short"
                },
                "body": {
                  "properties": {
                    "bytes": {
                      "type": "long"
                    }
                  }
                }
              }
            }
          }
        },
        "url": {
          "properties": {
            "path": {
              "type": "text",
              "analyzer": "path_analyzer",
              "fields": {
                "keyword": {
                  "type": "keyword",
                  "ignore_above": 256
                }
              }
            },
            "query": {
              "type": "keyword",
              "ignore_above": 1024
            }
          }
        },
        "user_agent": {
          "properties": {
            "original": {
              "type": "keyword",
              "ignore_above": 1024
            }
          }
        },
        "trace": {
          "properties": {
            "id": {
              "type": "keyword"
            }
          }
        },
        "transaction": {
          "properties": {
            "id": {
              "type": "keyword"
            }
          }
        }
      }
    }
  },
  "composed_of": [],
  "priority": 500,
  "version": 1,
  "_meta": {
    "description": "Template for application logs with ECS mapping"
  }
}
```

## Index Lifecycle Management (ILM)

### Production ILM Policy

```json
PUT _ilm/policy/logs-policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_primary_shard_size": "50GB",
            "max_age": "1d",
            "max_docs": 100000000
          },
          "set_priority": {
            "priority": 100
          },
          "readonly": {}
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "set_priority": {
            "priority": 50
          },
          "migrate": {
            "enabled": true
          },
          "forcemerge": {
            "max_num_segments": 1
          },
          "shrink": {
            "number_of_shards": 1
          },
          "allocate": {
            "require": {
              "type": "warm"
            }
          }
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "set_priority": {
            "priority": 0
          },
          "migrate": {
            "enabled": true
          },
          "allocate": {
            "require": {
              "type": "cold"
            }
          },
          "readonly": {}
        }
      },
      "frozen": {
        "min_age": "60d",
        "actions": {
          "searchable_snapshot": {
            "snapshot_repository": "found-snapshots",
            "force_merge_index": true
          }
        }
      },
      "delete": {
        "min_age": "90d",
        "actions": {
          "delete": {
            "delete_searchable_snapshot": true
          }
        }
      }
    }
  }
}
```

### ILM Monitoring Script

```python
#!/usr/bin/env python3
"""
Monitor ILM policy execution and index lifecycle
"""
import requests
from datetime import datetime, timedelta
from typing import Dict, List
import json

class ILMMonitor:
    """Monitor Elasticsearch ILM policies"""

    def __init__(self, elasticsearch_url: str, username: str = None, password: str = None):
        self.es_url = elasticsearch_url.rstrip('/')
        self.auth = (username, password) if username and password else None

    def get_ilm_status(self) -> Dict:
        """Get overall ILM status"""
        response = requests.get(
            f"{self.es_url}/_ilm/status",
            auth=self.auth
        )
        response.raise_for_status()
        return response.json()

    def get_policy_details(self, policy_name: str) -> Dict:
        """Get details of specific ILM policy"""
        response = requests.get(
            f"{self.es_url}/_ilm/policy/{policy_name}",
            auth=self.auth
        )
        response.raise_for_status()
        return response.json()

    def get_indices_in_policy(self, policy_name: str) -> List[Dict]:
        """Get all indices using a specific policy"""
        response = requests.get(
            f"{self.es_url}/*/_ilm/explain",
            auth=self.auth
        )
        response.raise_for_status()

        indices = []
        for index_name, details in response.json()['indices'].items():
            if details.get('policy') == policy_name:
                indices.append({
                    'index': index_name,
                    'phase': details.get('phase'),
                    'action': details.get('action'),
                    'step': details.get('step'),
                    'age': details.get('age'),
                    'phase_time_millis': details.get('phase_time_millis')
                })

        return indices

    def get_stuck_indices(self) -> List[Dict]:
        """Find indices stuck in ILM execution"""
        response = requests.get(
            f"{self.es_url}/*/_ilm/explain",
            auth=self.auth
        )
        response.raise_for_status()

        stuck = []
        for index_name, details in response.json()['indices'].items():
            if details.get('step') == 'ERROR':
                stuck.append({
                    'index': index_name,
                    'policy': details.get('policy'),
                    'phase': details.get('phase'),
                    'action': details.get('action'),
                    'failed_step': details.get('failed_step'),
                    'step_info': details.get('step_info')
                })

        return stuck

    def retry_failed_ilm(self, index_name: str) -> Dict:
        """Retry ILM for failed index"""
        response = requests.post(
            f"{self.es_url}/{index_name}/_ilm/retry",
            auth=self.auth
        )
        response.raise_for_status()
        return response.json()

    def get_phase_statistics(self, policy_name: str) -> Dict:
        """Get statistics about indices in each phase"""
        indices = self.get_indices_in_policy(policy_name)

        stats = {
            'hot': {'count': 0, 'total_size_bytes': 0},
            'warm': {'count': 0, 'total_size_bytes': 0},
            'cold': {'count': 0, 'total_size_bytes': 0},
            'frozen': {'count': 0, 'total_size_bytes': 0}
        }

        # Get size information for each index
        for idx in indices:
            phase = idx['phase']
            if phase in stats:
                stats[phase]['count'] += 1

                # Get index stats
                response = requests.get(
                    f"{self.es_url}/{idx['index']}/_stats",
                    auth=self.auth
                )
                if response.status_code == 200:
                    index_stats = response.json()
                    size_bytes = index_stats['_all']['total']['store']['size_in_bytes']
                    stats[phase]['total_size_bytes'] += size_bytes

        # Convert to GB
        for phase in stats:
            stats[phase]['total_size_gb'] = stats[phase]['total_size_bytes'] / (1024**3)

        return stats

    def generate_report(self, policy_name: str) -> str:
        """Generate comprehensive ILM report"""
        report = []
        report.append("=" * 80)
        report.append(f"ILM POLICY REPORT: {policy_name}")
        report.append("=" * 80)
        report.append("")

        # Overall status
        status = self.get_ilm_status()
        report.append(f"ILM Operation Mode: {status['operation_mode']}")
        report.append("")

        # Policy details
        policy = self.get_policy_details(policy_name)
        report.append("POLICY PHASES:")
        for phase_name in ['hot', 'warm', 'cold', 'frozen', 'delete']:
            if phase_name in policy[policy_name]['policy']['phases']:
                phase = policy[policy_name]['policy']['phases'][phase_name]
                report.append(f"  {phase_name.upper()}:")
                report.append(f"    Min Age: {phase.get('min_age', 'N/A')}")
                report.append(f"    Actions: {', '.join(phase['actions'].keys())}")
        report.append("")

        # Phase statistics
        stats = self.get_phase_statistics(policy_name)
        report.append("PHASE STATISTICS:")
        for phase, data in stats.items():
            if data['count'] > 0:
                report.append(f"  {phase.upper()}:")
                report.append(f"    Indices: {data['count']}")
                report.append(f"    Total Size: {data['total_size_gb']:.2f} GB")
        report.append("")

        # Stuck indices
        stuck = self.get_stuck_indices()
        if stuck:
            report.append("STUCK INDICES:")
            for idx in stuck:
                report.append(f"  {idx['index']}:")
                report.append(f"    Phase: {idx['phase']}")
                report.append(f"    Action: {idx['action']}")
                report.append(f"    Error: {idx['step_info']}")
            report.append("")
        else:
            report.append("No stuck indices found.")
            report.append("")

        return "\n".join(report)

# Example usage
def main():
    monitor = ILMMonitor(
        elasticsearch_url="http://localhost:9200",
        username="elastic",
        password="changeme"
    )

    # Generate report
    report = monitor.generate_report("logs-policy")
    print(report)

    # Retry any stuck indices
    stuck = monitor.get_stuck_indices()
    for idx in stuck:
        print(f"Retrying ILM for {idx['index']}...")
        result = monitor.retry_failed_ilm(idx['index'])
        print(f"Result: {result}")

if __name__ == "__main__":
    main()
```

## Performance Optimization

### JVM Heap Sizing

```bash
#!/bin/bash
# elasticsearch-heap-sizing.sh

# JVM heap sizing script for Elasticsearch
# Rule: Set heap to 50% of RAM, max 31GB

calculate_heap_size() {
    local total_ram_gb=$1
    local max_heap_gb=31

    # Calculate 50% of RAM
    local heap_gb=$((total_ram_gb / 2))

    # Cap at 31GB for compressed OOPs
    if [ $heap_gb -gt $max_heap_gb ]; then
        heap_gb=$max_heap_gb
    fi

    echo "${heap_gb}g"
}

# Get system RAM
total_ram_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
total_ram_gb=$((total_ram_kb / 1024 / 1024))

echo "System RAM: ${total_ram_gb}GB"
heap_size=$(calculate_heap_size $total_ram_gb)
echo "Recommended Heap Size: $heap_size"

# Update jvm.options
cat > /etc/elasticsearch/jvm.options.d/heap.options <<EOF
-Xms${heap_size}
-Xmx${heap_size}
EOF

echo "Updated /etc/elasticsearch/jvm.options.d/heap.options"
```

### Advanced JVM Options

```
# jvm.options - Production tuning

## Heap Size (set via environment or separate file)
# -Xms16g
# -Xmx16g

## GC Configuration - Use G1GC for heaps > 4GB
-XX:+UseG1GC
-XX:G1ReservePercent=25
-XX:InitiatingHeapOccupancyPercent=30

## GC Logging
-Xlog:gc*,gc+age=trace,safepoint:file=/var/log/elasticsearch/gc.log:utctime,pid,tags:filecount=32,filesize=64m

## Heap Dumps
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/lib/elasticsearch/heapdump.hprof

## String Deduplication (saves heap space)
-XX:+UseStringDeduplication

## Exit on OOM
-XX:+ExitOnOutOfMemoryError

## Performance
-XX:+AlwaysPreTouch
-XX:+UseTLAB
-XX:+ResizeTLAB

## Disable expensive debug features
-XX:-OmitStackTraceInFastThrow

## Compressed OOPs (automatic below 32GB heap)
-XX:+UseCompressedOops

## Large pages (if supported)
# -XX:+UseLargePages

## Disable biased locking (problematic with G1GC)
-XX:-UseBiasedLocking

## DNS cache TTL
-Des.networkaddress.cache.ttl=60
-Des.networkaddress.cache.negative.ttl=10

## Security manager
-Djava.security.manager=allow

## Temporary directory
-Djava.io.tmpdir=/var/tmp/elasticsearch
```

### Query Performance Optimization

```python
#!/usr/bin/env python3
"""
Elasticsearch query optimization analyzer
"""
from elasticsearch import Elasticsearch
from typing import Dict, List
import json

class QueryOptimizer:
    """Analyze and optimize Elasticsearch queries"""

    def __init__(self, es_client: Elasticsearch):
        self.es = es_client

    def analyze_query_performance(self, index: str, query: Dict) -> Dict:
        """Analyze query performance with profiling"""
        search_body = {
            "profile": True,
            "query": query
        }

        response = self.es.search(index=index, body=search_body)

        # Extract timing information
        profile = response['profile']
        shards = profile['shards']

        total_time_ms = 0
        breakdown = {}

        for shard in shards:
            for search_type in shard['searches']:
                for query_profile in search_type['query']:
                    query_type = query_profile['type']
                    time_ms = query_profile['time_in_nanos'] / 1_000_000
                    total_time_ms += time_ms

                    if query_type not in breakdown:
                        breakdown[query_type] = 0
                    breakdown[query_type] += time_ms

        return {
            'total_time_ms': total_time_ms,
            'breakdown': breakdown,
            'suggestions': self._generate_optimization_suggestions(query, breakdown)
        }

    def _generate_optimization_suggestions(self, query: Dict, breakdown: Dict) -> List[str]:
        """Generate optimization suggestions based on query analysis"""
        suggestions = []

        # Check for wildcards
        query_str = json.dumps(query)
        if '*' in query_str or '?' in query_str:
            suggestions.append("Consider replacing wildcard queries with prefix queries or edge n-grams")

        # Check for range queries
        if 'range' in query_str:
            suggestions.append("Ensure range queries use cached filters and proper date formats")

        # Check for script queries
        if 'script' in query_str:
            suggestions.append("Script queries are slow - consider using stored scripts or runtime fields")

        # Check for deep pagination
        if 'from' in query and query.get('from', 0) > 10000:
            suggestions.append("Deep pagination detected - use search_after or scroll API instead")

        # Check for large result sets
        if 'size' in query and query.get('size', 10) > 1000:
            suggestions.append("Large result set - consider reducing size or using scroll API")

        # Check for expensive aggregations
        if 'aggs' in query or 'aggregations' in query:
            suggestions.append("Use filter context instead of query context in aggregations when possible")
            suggestions.append("Consider using composite aggregations for large cardinality")

        return suggestions

    def optimize_query(self, query: Dict) -> Dict:
        """Automatically optimize query structure"""
        optimized = query.copy()

        # Move filters to filter context
        if 'bool' in optimized.get('query', {}):
            bool_query = optimized['query']['bool']

            # Move must clauses that don't need scoring to filter
            if 'must' in bool_query:
                must_clauses = bool_query['must']
                filter_candidates = []
                remaining_must = []

                for clause in must_clauses:
                    if self._can_be_filter(clause):
                        filter_candidates.append(clause)
                    else:
                        remaining_must.append(clause)

                if filter_candidates:
                    if 'filter' not in bool_query:
                        bool_query['filter'] = []
                    bool_query['filter'].extend(filter_candidates)

                    if remaining_must:
                        bool_query['must'] = remaining_must
                    else:
                        del bool_query['must']

        return optimized

    def _can_be_filter(self, clause: Dict) -> bool:
        """Determine if a clause can be moved to filter context"""
        # Term and terms queries don't need scoring
        if 'term' in clause or 'terms' in clause:
            return True

        # Range queries typically don't need scoring
        if 'range' in clause:
            return True

        # Exists queries don't need scoring
        if 'exists' in clause:
            return True

        return False

    def benchmark_query(self, index: str, query: Dict, iterations: int = 10) -> Dict:
        """Benchmark query performance"""
        times = []

        for _ in range(iterations):
            result = self.analyze_query_performance(index, query)
            times.append(result['total_time_ms'])

        return {
            'min_ms': min(times),
            'max_ms': max(times),
            'avg_ms': sum(times) / len(times),
            'p50_ms': sorted(times)[len(times) // 2],
            'p95_ms': sorted(times)[int(len(times) * 0.95)],
            'p99_ms': sorted(times)[int(len(times) * 0.99)]
        }

# Example usage
def main():
    es = Elasticsearch(['http://localhost:9200'])
    optimizer = QueryOptimizer(es)

    # Example query
    query = {
        "bool": {
            "must": [
                {"term": {"status": "active"}},
                {"match": {"message": "error"}}
            ],
            "filter": [
                {"range": {"@timestamp": {"gte": "now-1d"}}}
            ]
        }
    }

    # Analyze performance
    print("Analyzing query performance...")
    analysis = optimizer.analyze_query_performance("logs-*", query)
    print(f"Total time: {analysis['total_time_ms']:.2f}ms")
    print("\nBreakdown:")
    for query_type, time_ms in analysis['breakdown'].items():
        print(f"  {query_type}: {time_ms:.2f}ms")

    print("\nSuggestions:")
    for suggestion in analysis['suggestions']:
        print(f"  - {suggestion}")

    # Benchmark
    print("\nBenchmarking query...")
    benchmark = optimizer.benchmark_query("logs-*", query, iterations=10)
    print(f"Average: {benchmark['avg_ms']:.2f}ms")
    print(f"P95: {benchmark['p95_ms']:.2f}ms")
    print(f"P99: {benchmark['p99_ms']:.2f}ms")

if __name__ == "__main__":
    main()
```

## Monitoring and Alerting

### Comprehensive Monitoring Configuration

```yaml
# elasticsearch-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: elasticsearch
  namespace: elasticsearch
  labels:
    app: elasticsearch
spec:
  selector:
    matchLabels:
      app: elasticsearch
  endpoints:
  - port: metrics
    interval: 30s
    path: /_prometheus/metrics

---
# Prometheus alerting rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: elasticsearch-alerts
  namespace: elasticsearch
spec:
  groups:
  - name: elasticsearch
    interval: 30s
    rules:
    # Cluster health
    - alert: ElasticsearchClusterRed
      expr: elasticsearch_cluster_health_status{color="red"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Elasticsearch cluster health is RED"
        description: "Cluster {{ $labels.cluster }} health is RED. Some primary shards are unassigned."

    - alert: ElasticsearchClusterYellow
      expr: elasticsearch_cluster_health_status{color="yellow"} == 1
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch cluster health is YELLOW"
        description: "Cluster {{ $labels.cluster }} health is YELLOW. Some replica shards are unassigned."

    # Node availability
    - alert: ElasticsearchNodeDown
      expr: elasticsearch_cluster_health_number_of_nodes < 3
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Elasticsearch node is down"
        description: "Cluster {{ $labels.cluster }} has fewer than 3 nodes running."

    # Disk space
    - alert: ElasticsearchDiskSpaceLow
      expr: |
        (
          elasticsearch_filesystem_data_available_bytes
          /
          elasticsearch_filesystem_data_size_bytes
        ) < 0.15
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch disk space low"
        description: "Node {{ $labels.name }} has less than 15% disk space available."

    - alert: ElasticsearchDiskSpaceCritical
      expr: |
        (
          elasticsearch_filesystem_data_available_bytes
          /
          elasticsearch_filesystem_data_size_bytes
        ) < 0.05
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Elasticsearch disk space critical"
        description: "Node {{ $labels.name }} has less than 5% disk space available."

    # Heap usage
    - alert: ElasticsearchHeapUsageHigh
      expr: |
        (
          elasticsearch_jvm_memory_used_bytes{area="heap"}
          /
          elasticsearch_jvm_memory_max_bytes{area="heap"}
        ) > 0.90
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch heap usage high"
        description: "Node {{ $labels.name }} heap usage is above 90%."

    # GC duration
    - alert: ElasticsearchGCDurationHigh
      expr: |
        rate(elasticsearch_jvm_gc_collection_seconds_sum[5m]) > 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch GC duration high"
        description: "Node {{ $labels.name }} is spending too much time in GC."

    # Query latency
    - alert: ElasticsearchQueryLatencyHigh
      expr: |
        rate(elasticsearch_indices_search_query_time_seconds[5m])
        /
        rate(elasticsearch_indices_search_query_total[5m])
        > 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch query latency high"
        description: "Average query latency on {{ $labels.name }} exceeds 1 second."

    # Indexing rate
    - alert: ElasticsearchIndexingRateLow
      expr: |
        rate(elasticsearch_indices_indexing_index_total[5m]) < 1000
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch indexing rate low"
        description: "Indexing rate on {{ $labels.name }} has dropped below 1000 docs/sec."

    # Pending tasks
    - alert: ElasticsearchPendingTasksHigh
      expr: elasticsearch_cluster_health_number_of_pending_tasks > 10
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch has many pending tasks"
        description: "Cluster {{ $labels.cluster }} has {{ $value }} pending tasks."

    # Unassigned shards
    - alert: ElasticsearchUnassignedShards
      expr: elasticsearch_cluster_health_unassigned_shards > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch has unassigned shards"
        description: "Cluster {{ $labels.cluster }} has {{ $value }} unassigned shards."

    # Circuit breaker tripped
    - alert: ElasticsearchCircuitBreakerTripped
      expr: |
        rate(elasticsearch_breakers_tripped[5m]) > 0
      labels:
        severity: warning
      annotations:
        summary: "Elasticsearch circuit breaker tripped"
        description: "Circuit breaker {{ $labels.name }} on node {{ $labels.node }} has been tripped."
```

## Conclusion

Elasticsearch cluster sizing requires careful consideration of data characteristics, workload patterns, and resource constraints. Key takeaways:

1. **Capacity Planning**: Use data-driven calculations for storage, compute, and memory requirements
2. **Shard Strategy**: Target 20-50GB shard sizes and distribute across nodes
3. **Tiered Architecture**: Implement hot-warm-cold architecture for cost optimization
4. **Heap Management**: Set heap to 50% of RAM, maximum 31GB
5. **Index Lifecycle**: Use ILM policies to automate data lifecycle management
6. **Monitoring**: Implement comprehensive monitoring and alerting

Proper sizing ensures optimal performance, cost efficiency, and operational reliability for enterprise search workloads.

## Additional Resources

- [Elasticsearch Official Sizing Guide](https://www.elastic.co/guide/en/elasticsearch/reference/current/size-your-shards.html)
- [Heap Sizing and Compressed OOPs](https://www.elastic.co/guide/en/elasticsearch/reference/current/heap-size.html)
- [Index Lifecycle Management](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-lifecycle-management.html)
- [Elasticsearch Performance Tuning](https://www.elastic.co/guide/en/elasticsearch/reference/current/tune-for-indexing-speed.html)