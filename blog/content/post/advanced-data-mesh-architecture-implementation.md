---
title: "Advanced Data Mesh Architecture and Implementation: Decentralized Data Infrastructure at Scale"
date: 2026-03-27T00:00:00-05:00
draft: false
description: "Comprehensive guide to implementing advanced data mesh architecture, covering domain-driven data ownership, federated governance, self-serve data infrastructure, and data product management for enterprise-scale organizations."
keywords: ["data mesh", "data architecture", "domain-driven design", "data product", "federated governance", "self-serve infrastructure", "data platform", "microservices", "decentralized data"]
tags: ["data-mesh", "data-architecture", "domain-driven", "data-product", "governance", "microservices", "platform", "decentralized"]
categories: ["Data Architecture", "Data Engineering", "Enterprise Architecture"]
author: "Support Tools Team"
canonical: "https://support.tools/blog/advanced-data-mesh-architecture-implementation/"
---

# Advanced Data Mesh Architecture and Implementation: Decentralized Data Infrastructure at Scale

Data mesh represents a paradigm shift from centralized data platforms to a decentralized, domain-oriented approach to data architecture. This architectural pattern treats data as a product and distributes data ownership to domain teams while maintaining federated governance and providing self-serve data infrastructure capabilities.

This comprehensive guide explores advanced techniques for implementing data mesh architecture at enterprise scale, covering domain design, data product development, federated governance frameworks, and platform engineering strategies.

## Understanding Data Mesh Principles

### Core Principles and Architecture

Data mesh is built on four fundamental principles: domain ownership, data as a product, self-serve data infrastructure, and federated computational governance.

```python
# Data mesh domain and data product abstractions
from abc import ABC, abstractmethod
from typing import Dict, List, Any, Optional, Union
from dataclasses import dataclass, field
from datetime import datetime
import uuid
import json
import logging
from enum import Enum

class DataProductType(Enum):
    SOURCE = "source"
    DERIVED = "derived"
    AGGREGATE = "aggregate"
    ML_FEATURE = "ml_feature"

class DataProductStatus(Enum):
    DEVELOPMENT = "development"
    TESTING = "testing"
    PRODUCTION = "production"
    DEPRECATED = "deprecated"

@dataclass
class DataContract:
    """Data contract specification for data products"""
    schema_version: str
    data_format: str  # json, avro, parquet, etc.
    schema: Dict[str, Any]
    sla: Dict[str, Any]
    quality_requirements: Dict[str, Any]
    semantic_model: Optional[Dict[str, Any]] = None
    governance_classification: str = "internal"
    retention_policy: Optional[Dict[str, Any]] = None
    
    def validate_schema(self, data: Dict[str, Any]) -> bool:
        """Validate data against contract schema"""
        # Implementation would use appropriate schema validation
        return True
    
    def check_sla_compliance(self, metrics: Dict[str, Any]) -> bool:
        """Check if current metrics meet SLA requirements"""
        for sla_metric, threshold in self.sla.items():
            if metrics.get(sla_metric, 0) < threshold:
                return False
        return True

@dataclass
class DataProduct:
    """Core data product abstraction"""
    id: str
    name: str
    domain: str
    owner_team: str
    product_type: DataProductType
    status: DataProductStatus
    data_contract: DataContract
    description: str
    version: str = "1.0.0"
    tags: List[str] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)
    consumers: List[str] = field(default_factory=list)
    access_points: Dict[str, str] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    
    def __post_init__(self):
        if not self.id:
            self.id = str(uuid.uuid4())

class DataDomain(ABC):
    """Abstract base class for data domains"""
    
    def __init__(self, domain_name: str, team_owner: str):
        self.domain_name = domain_name
        self.team_owner = team_owner
        self.data_products: Dict[str, DataProduct] = {}
        self.governance_policies: Dict[str, Any] = {}
        
    @abstractmethod
    def create_data_product(self, product_spec: Dict[str, Any]) -> DataProduct:
        """Create a new data product in this domain"""
        pass
    
    @abstractmethod
    def validate_data_quality(self, product_id: str) -> Dict[str, Any]:
        """Validate data quality for a specific product"""
        pass
    
    @abstractmethod
    def monitor_sla_compliance(self) -> Dict[str, Any]:
        """Monitor SLA compliance across domain products"""
        pass
    
    def register_data_product(self, data_product: DataProduct) -> bool:
        """Register a data product with the domain"""
        if data_product.domain != self.domain_name:
            raise ValueError(f"Data product domain {data_product.domain} doesn't match {self.domain_name}")
        
        self.data_products[data_product.id] = data_product
        logging.info(f"Registered data product {data_product.name} in domain {self.domain_name}")
        return True
    
    def get_data_product(self, product_id: str) -> Optional[DataProduct]:
        """Get data product by ID"""
        return self.data_products.get(product_id)
    
    def list_data_products(self, status: Optional[DataProductStatus] = None) -> List[DataProduct]:
        """List data products, optionally filtered by status"""
        products = list(self.data_products.values())
        if status:
            products = [p for p in products if p.status == status]
        return products

class CustomerDomain(DataDomain):
    """Customer domain implementation"""
    
    def __init__(self):
        super().__init__("customer", "customer-data-team")
        self._setup_domain_policies()
    
    def _setup_domain_policies(self):
        """Setup domain-specific governance policies"""
        self.governance_policies = {
            "data_classification": {
                "customer_pii": "confidential",
                "customer_preferences": "internal",
                "customer_segments": "internal"
            },
            "retention_policies": {
                "customer_events": {"retention_days": 2555},  # 7 years
                "customer_profiles": {"retention_days": 2555},
                "customer_interactions": {"retention_days": 1095}  # 3 years
            },
            "quality_requirements": {
                "completeness": 0.95,
                "accuracy": 0.98,
                "timeliness": {"max_delay_hours": 4}
            }
        }
    
    def create_data_product(self, product_spec: Dict[str, Any]) -> DataProduct:
        """Create customer domain data product"""
        
        # Create data contract based on domain policies
        contract = DataContract(
            schema_version="1.0",
            data_format=product_spec.get("format", "parquet"),
            schema=product_spec["schema"],
            sla={
                "availability": 0.999,
                "latency_p95_ms": 500,
                "freshness_hours": 2
            },
            quality_requirements=self.governance_policies["quality_requirements"],
            governance_classification=self.governance_policies["data_classification"].get(
                product_spec["name"], "internal"
            ),
            retention_policy=self.governance_policies["retention_policies"].get(
                product_spec["name"], {"retention_days": 1095}
            )
        )
        
        # Create data product
        data_product = DataProduct(
            id=str(uuid.uuid4()),
            name=product_spec["name"],
            domain=self.domain_name,
            owner_team=self.team_owner,
            product_type=DataProductType(product_spec.get("type", "source")),
            status=DataProductStatus.DEVELOPMENT,
            data_contract=contract,
            description=product_spec["description"],
            tags=product_spec.get("tags", []),
            access_points={
                "api": f"https://api.{self.domain_name}.company.com/{product_spec['name']}",
                "streaming": f"kafka://streaming.company.com/{self.domain_name}.{product_spec['name']}",
                "batch": f"s3://data-mesh/{self.domain_name}/{product_spec['name']}/"
            }
        )
        
        self.register_data_product(data_product)
        return data_product
    
    def validate_data_quality(self, product_id: str) -> Dict[str, Any]:
        """Validate data quality for customer domain product"""
        
        product = self.get_data_product(product_id)
        if not product:
            raise ValueError(f"Product {product_id} not found")
        
        # Simulate data quality validation
        validation_results = {
            "product_id": product_id,
            "product_name": product.name,
            "validation_timestamp": datetime.utcnow().isoformat(),
            "overall_status": "passed",
            "checks": {}
        }
        
        # Check completeness
        completeness_score = 0.97  # Simulated
        threshold = product.data_contract.quality_requirements["completeness"]
        validation_results["checks"]["completeness"] = {
            "score": completeness_score,
            "threshold": threshold,
            "passed": completeness_score >= threshold
        }
        
        # Check accuracy
        accuracy_score = 0.99  # Simulated
        threshold = product.data_contract.quality_requirements["accuracy"]
        validation_results["checks"]["accuracy"] = {
            "score": accuracy_score,
            "threshold": threshold,
            "passed": accuracy_score >= threshold
        }
        
        # Check timeliness
        delay_hours = 1.5  # Simulated
        max_delay = product.data_contract.quality_requirements["timeliness"]["max_delay_hours"]
        validation_results["checks"]["timeliness"] = {
            "delay_hours": delay_hours,
            "max_delay_hours": max_delay,
            "passed": delay_hours <= max_delay
        }
        
        # Update overall status
        all_passed = all(check["passed"] for check in validation_results["checks"].values())
        validation_results["overall_status"] = "passed" if all_passed else "failed"
        
        return validation_results
    
    def monitor_sla_compliance(self) -> Dict[str, Any]:
        """Monitor SLA compliance for customer domain products"""
        
        compliance_report = {
            "domain": self.domain_name,
            "report_timestamp": datetime.utcnow().isoformat(),
            "overall_compliance": True,
            "products": {}
        }
        
        for product_id, product in self.data_products.items():
            # Simulate SLA metrics
            current_metrics = {
                "availability": 0.9995,
                "latency_p95_ms": 450,
                "freshness_hours": 1.8
            }
            
            sla_compliance = product.data_contract.check_sla_compliance(current_metrics)
            
            compliance_report["products"][product_id] = {
                "name": product.name,
                "sla_compliance": sla_compliance,
                "current_metrics": current_metrics,
                "sla_requirements": product.data_contract.sla
            }
            
            if not sla_compliance:
                compliance_report["overall_compliance"] = False
        
        return compliance_report

# Data mesh platform infrastructure
class DataMeshPlatform:
    """Self-serve data infrastructure platform"""
    
    def __init__(self, platform_config: Dict[str, Any]):
        self.platform_config = platform_config
        self.domains: Dict[str, DataDomain] = {}
        self.global_catalog: Dict[str, DataProduct] = {}
        self.governance_engine = FederatedGovernanceEngine()
        self.infrastructure_manager = InfrastructureManager(platform_config)
        
    def register_domain(self, domain: DataDomain) -> bool:
        """Register a data domain with the platform"""
        self.domains[domain.domain_name] = domain
        logging.info(f"Registered domain: {domain.domain_name}")
        return True
    
    def discover_data_products(self, search_criteria: Dict[str, Any]) -> List[DataProduct]:
        """Discover data products across domains based on search criteria"""
        
        matching_products = []
        
        for domain_name, domain in self.domains.items():
            for product in domain.list_data_products():
                if self._matches_criteria(product, search_criteria):
                    matching_products.append(product)
        
        return matching_products
    
    def _matches_criteria(self, product: DataProduct, criteria: Dict[str, Any]) -> bool:
        """Check if product matches search criteria"""
        
        # Domain filter
        if "domain" in criteria and product.domain != criteria["domain"]:
            return False
        
        # Type filter
        if "type" in criteria and product.product_type != DataProductType(criteria["type"]):
            return False
        
        # Status filter
        if "status" in criteria and product.status != DataProductStatus(criteria["status"]):
            return False
        
        # Tag filter
        if "tags" in criteria:
            required_tags = set(criteria["tags"])
            product_tags = set(product.tags)
            if not required_tags.issubset(product_tags):
                return False
        
        # Text search in name and description
        if "search" in criteria:
            search_text = criteria["search"].lower()
            if (search_text not in product.name.lower() and 
                search_text not in product.description.lower()):
                return False
        
        return True
    
    def create_data_lineage(self, product_id: str) -> Dict[str, Any]:
        """Create data lineage graph for a data product"""
        
        lineage = {
            "product_id": product_id,
            "lineage_graph": {
                "nodes": [],
                "edges": []
            },
            "generation_timestamp": datetime.utcnow().isoformat()
        }
        
        # Find the product
        target_product = None
        for domain in self.domains.values():
            product = domain.get_data_product(product_id)
            if product:
                target_product = product
                break
        
        if not target_product:
            raise ValueError(f"Product {product_id} not found")
        
        # Build lineage graph
        visited = set()
        self._build_lineage_recursive(target_product, lineage["lineage_graph"], visited, "downstream")
        
        visited.clear()
        self._build_lineage_recursive(target_product, lineage["lineage_graph"], visited, "upstream")
        
        return lineage
    
    def _build_lineage_recursive(self, product: DataProduct, graph: Dict[str, List], 
                                visited: set, direction: str, depth: int = 0):
        """Recursively build lineage graph"""
        
        if product.id in visited or depth > 5:  # Prevent infinite loops and limit depth
            return
        
        visited.add(product.id)
        
        # Add node
        node = {
            "id": product.id,
            "name": product.name,
            "domain": product.domain,
            "type": product.product_type.value,
            "status": product.status.value
        }
        
        if node not in graph["nodes"]:
            graph["nodes"].append(node)
        
        # Add edges based on direction
        if direction == "downstream":
            # Find products that depend on this one
            for domain in self.domains.values():
                for consumer_product in domain.list_data_products():
                    if product.id in consumer_product.dependencies:
                        edge = {
                            "source": product.id,
                            "target": consumer_product.id,
                            "relationship": "feeds"
                        }
                        if edge not in graph["edges"]:
                            graph["edges"].append(edge)
                        
                        # Recurse
                        self._build_lineage_recursive(consumer_product, graph, visited, direction, depth + 1)
        
        elif direction == "upstream":
            # Find products this one depends on
            for dependency_id in product.dependencies:
                for domain in self.domains.values():
                    dependency_product = domain.get_data_product(dependency_id)
                    if dependency_product:
                        edge = {
                            "source": dependency_id,
                            "target": product.id,
                            "relationship": "feeds"
                        }
                        if edge not in graph["edges"]:
                            graph["edges"].append(edge)
                        
                        # Recurse
                        self._build_lineage_recursive(dependency_product, graph, visited, direction, depth + 1)

class FederatedGovernanceEngine:
    """Federated governance engine for data mesh"""
    
    def __init__(self):
        self.global_policies: Dict[str, Any] = {}
        self.domain_policies: Dict[str, Dict[str, Any]] = {}
        self.compliance_checks: List[callable] = []
        
    def define_global_policy(self, policy_name: str, policy_spec: Dict[str, Any]):
        """Define a global governance policy"""
        self.global_policies[policy_name] = {
            "specification": policy_spec,
            "created_at": datetime.utcnow().isoformat(),
            "enforcement_level": policy_spec.get("enforcement", "advisory")
        }
        
        logging.info(f"Defined global policy: {policy_name}")
    
    def define_domain_policy(self, domain_name: str, policy_name: str, 
                           policy_spec: Dict[str, Any]):
        """Define a domain-specific governance policy"""
        if domain_name not in self.domain_policies:
            self.domain_policies[domain_name] = {}
        
        self.domain_policies[domain_name][policy_name] = {
            "specification": policy_spec,
            "created_at": datetime.utcnow().isoformat(),
            "enforcement_level": policy_spec.get("enforcement", "advisory")
        }
        
        logging.info(f"Defined domain policy for {domain_name}: {policy_name}")
    
    def validate_data_product_compliance(self, data_product: DataProduct) -> Dict[str, Any]:
        """Validate data product against applicable policies"""
        
        compliance_report = {
            "product_id": data_product.id,
            "product_name": data_product.name,
            "domain": data_product.domain,
            "validation_timestamp": datetime.utcnow().isoformat(),
            "overall_compliance": True,
            "policy_violations": [],
            "warnings": []
        }
        
        # Check global policies
        for policy_name, policy in self.global_policies.items():
            violation = self._check_policy_compliance(data_product, policy_name, policy)
            if violation:
                compliance_report["policy_violations"].append(violation)
                if policy["enforcement_level"] == "mandatory":
                    compliance_report["overall_compliance"] = False
        
        # Check domain-specific policies
        domain_policies = self.domain_policies.get(data_product.domain, {})
        for policy_name, policy in domain_policies.items():
            violation = self._check_policy_compliance(data_product, policy_name, policy)
            if violation:
                compliance_report["policy_violations"].append(violation)
                if policy["enforcement_level"] == "mandatory":
                    compliance_report["overall_compliance"] = False
        
        return compliance_report
    
    def _check_policy_compliance(self, data_product: DataProduct, 
                               policy_name: str, policy: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Check compliance against a specific policy"""
        
        spec = policy["specification"]
        
        # Data classification policy
        if policy_name == "data_classification_required":
            if not data_product.data_contract.governance_classification:
                return {
                    "policy": policy_name,
                    "violation": "Data product must have classification",
                    "enforcement_level": policy["enforcement_level"]
                }
        
        # Retention policy
        elif policy_name == "retention_policy_required":
            if not data_product.data_contract.retention_policy:
                return {
                    "policy": policy_name,
                    "violation": "Data product must have retention policy",
                    "enforcement_level": policy["enforcement_level"]
                }
        
        # SLA requirements
        elif policy_name == "minimum_sla_requirements":
            required_slas = spec.get("required_slas", {})
            product_slas = data_product.data_contract.sla
            
            for sla_metric, min_value in required_slas.items():
                if sla_metric not in product_slas or product_slas[sla_metric] < min_value:
                    return {
                        "policy": policy_name,
                        "violation": f"SLA {sla_metric} below minimum requirement",
                        "enforcement_level": policy["enforcement_level"]
                    }
        
        # Schema documentation
        elif policy_name == "schema_documentation_required":
            if not data_product.data_contract.schema or not data_product.description:
                return {
                    "policy": policy_name,
                    "violation": "Data product must have documented schema and description",
                    "enforcement_level": policy["enforcement_level"]
                }
        
        return None

class InfrastructureManager:
    """Self-serve infrastructure manager for data mesh"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.provisioned_resources: Dict[str, Dict[str, Any]] = {}
        
    def provision_data_product_infrastructure(self, data_product: DataProduct) -> Dict[str, Any]:
        """Provision infrastructure for a data product"""
        
        infrastructure_spec = {
            "product_id": data_product.id,
            "product_name": data_product.name,
            "domain": data_product.domain,
            "resources": {}
        }
        
        # Provision storage
        storage_config = self._provision_storage(data_product)
        infrastructure_spec["resources"]["storage"] = storage_config
        
        # Provision compute
        compute_config = self._provision_compute(data_product)
        infrastructure_spec["resources"]["compute"] = compute_config
        
        # Provision networking
        network_config = self._provision_networking(data_product)
        infrastructure_spec["resources"]["networking"] = network_config
        
        # Provision monitoring
        monitoring_config = self._provision_monitoring(data_product)
        infrastructure_spec["resources"]["monitoring"] = monitoring_config
        
        # Store provisioned resources
        self.provisioned_resources[data_product.id] = infrastructure_spec
        
        logging.info(f"Provisioned infrastructure for data product: {data_product.name}")
        return infrastructure_spec
    
    def _provision_storage(self, data_product: DataProduct) -> Dict[str, Any]:
        """Provision storage resources"""
        
        storage_config = {
            "type": "s3",
            "bucket": f"data-mesh-{data_product.domain}",
            "path": f"{data_product.name}/",
            "encryption": "AES256",
            "versioning": True,
            "lifecycle_policy": {
                "transitions": [
                    {"days": 30, "storage_class": "STANDARD_IA"},
                    {"days": 90, "storage_class": "GLACIER"}
                ]
            }
        }
        
        # Apply retention policy from data contract
        if data_product.data_contract.retention_policy:
            retention_days = data_product.data_contract.retention_policy.get("retention_days")
            if retention_days:
                storage_config["lifecycle_policy"]["expiration"] = {"days": retention_days}
        
        return storage_config
    
    def _provision_compute(self, data_product: DataProduct) -> Dict[str, Any]:
        """Provision compute resources"""
        
        compute_config = {
            "type": "kubernetes",
            "namespace": f"data-mesh-{data_product.domain}",
            "resources": {
                "requests": {
                    "cpu": "100m",
                    "memory": "256Mi"
                },
                "limits": {
                    "cpu": "1",
                    "memory": "2Gi"
                }
            },
            "autoscaling": {
                "enabled": True,
                "min_replicas": 1,
                "max_replicas": 10,
                "target_cpu_utilization": 70
            }
        }
        
        # Adjust resources based on product type
        if data_product.product_type == DataProductType.ML_FEATURE:
            compute_config["resources"]["requests"]["cpu"] = "500m"
            compute_config["resources"]["requests"]["memory"] = "1Gi"
            compute_config["resources"]["limits"]["cpu"] = "2"
            compute_config["resources"]["limits"]["memory"] = "4Gi"
        
        return compute_config
    
    def _provision_networking(self, data_product: DataProduct) -> Dict[str, Any]:
        """Provision networking resources"""
        
        network_config = {
            "api_gateway": {
                "enabled": True,
                "endpoint": f"https://api.{data_product.domain}.company.com/{data_product.name}",
                "rate_limiting": {
                    "requests_per_minute": 1000
                },
                "authentication": "oauth2"
            },
            "streaming": {
                "enabled": True,
                "topic": f"{data_product.domain}.{data_product.name}",
                "partitions": 6,
                "replication_factor": 3
            },
            "service_mesh": {
                "enabled": True,
                "circuit_breaker": True,
                "retry_policy": {
                    "max_retries": 3,
                    "timeout": "30s"
                }
            }
        }
        
        return network_config
    
    def _provision_monitoring(self, data_product: DataProduct) -> Dict[str, Any]:
        """Provision monitoring resources"""
        
        monitoring_config = {
            "metrics": {
                "enabled": True,
                "prometheus_endpoint": f"/metrics",
                "custom_metrics": [
                    "data_freshness_seconds",
                    "data_quality_score",
                    "sla_compliance_percentage"
                ]
            },
            "logging": {
                "enabled": True,
                "log_level": "INFO",
                "structured_logging": True
            },
            "alerting": {
                "enabled": True,
                "alert_manager": "prometheus",
                "notification_channels": ["slack", "email"]
            },
            "dashboards": {
                "grafana": {
                    "enabled": True,
                    "dashboard_template": "data_product_template"
                }
            }
        }
        
        # Add SLA-specific monitoring
        for sla_metric, threshold in data_product.data_contract.sla.items():
            monitoring_config["alerting"][f"sla_{sla_metric}_alert"] = {
                "condition": f"{sla_metric} < {threshold}",
                "severity": "warning"
            }
        
        return monitoring_config
    
    def get_resource_usage(self, product_id: str) -> Dict[str, Any]:
        """Get resource usage for a data product"""
        
        if product_id not in self.provisioned_resources:
            raise ValueError(f"No provisioned resources found for product {product_id}")
        
        # Simulate resource usage metrics
        usage_metrics = {
            "product_id": product_id,
            "timestamp": datetime.utcnow().isoformat(),
            "storage": {
                "used_gb": 245.7,
                "requests_per_day": 12456,
                "cost_usd_per_month": 8.42
            },
            "compute": {
                "cpu_utilization_percent": 65.3,
                "memory_utilization_percent": 78.1,
                "pod_count": 3,
                "cost_usd_per_month": 156.78
            },
            "networking": {
                "api_requests_per_day": 8934,
                "streaming_messages_per_day": 145678,
                "bandwidth_gb_per_day": 12.4,
                "cost_usd_per_month": 23.45
            },
            "total_cost_usd_per_month": 188.65
        }
        
        return usage_metrics
```

## Advanced Data Product Development

### Data Product Lifecycle Management

```python
# Advanced data product lifecycle and development frameworks
from typing import Protocol, runtime_checkable
import asyncio
from contextlib import asynccontextmanager

@runtime_checkable
class DataProductInterface(Protocol):
    """Protocol defining data product interface"""
    
    async def produce_data(self, request: Dict[str, Any]) -> Any:
        """Produce data based on request"""
        ...
    
    async def validate_quality(self) -> Dict[str, Any]:
        """Validate data quality"""
        ...
    
    async def get_schema(self) -> Dict[str, Any]:
        """Get current data schema"""
        ...
    
    async def get_metrics(self) -> Dict[str, Any]:
        """Get current metrics"""
        ...

class DataProductFactory:
    """Factory for creating data products with standardized patterns"""
    
    def __init__(self, platform: DataMeshPlatform):
        self.platform = platform
        self.templates = {
            "customer_events": CustomerEventsProductTemplate(),
            "customer_segments": CustomerSegmentsProductTemplate(),
            "order_analytics": OrderAnalyticsProductTemplate()
        }
    
    def create_data_product(self, template_name: str, 
                           config: Dict[str, Any]) -> DataProduct:
        """Create data product from template"""
        
        if template_name not in self.templates:
            raise ValueError(f"Unknown template: {template_name}")
        
        template = self.templates[template_name]
        return template.create_product(config, self.platform)
    
    def register_template(self, name: str, template: 'DataProductTemplate'):
        """Register a new data product template"""
        self.templates[name] = template

class DataProductTemplate(ABC):
    """Abstract base class for data product templates"""
    
    @abstractmethod
    def create_product(self, config: Dict[str, Any], 
                      platform: DataMeshPlatform) -> DataProduct:
        """Create data product from template"""
        pass
    
    @abstractmethod
    def validate_config(self, config: Dict[str, Any]) -> bool:
        """Validate configuration"""
        pass

class CustomerEventsProductTemplate(DataProductTemplate):
    """Template for customer events data products"""
    
    def validate_config(self, config: Dict[str, Any]) -> bool:
        """Validate customer events configuration"""
        required_fields = ["name", "event_types", "schema", "source_systems"]
        return all(field in config for field in required_fields)
    
    def create_product(self, config: Dict[str, Any], 
                      platform: DataMeshPlatform) -> DataProduct:
        """Create customer events data product"""
        
        if not self.validate_config(config):
            raise ValueError("Invalid configuration for customer events product")
        
        # Create standardized schema
        schema = {
            "type": "object",
            "properties": {
                "event_id": {"type": "string", "format": "uuid"},
                "customer_id": {"type": "string"},
                "event_type": {"type": "string", "enum": config["event_types"]},
                "event_timestamp": {"type": "string", "format": "date-time"},
                "event_data": {"type": "object"},
                "source_system": {"type": "string", "enum": config["source_systems"]},
                "version": {"type": "string"}
            },
            "required": ["event_id", "customer_id", "event_type", "event_timestamp"]
        }
        
        # Merge with custom schema
        schema["properties"].update(config["schema"].get("properties", {}))
        
        # Create data contract
        contract = DataContract(
            schema_version="1.0",
            data_format="json",
            schema=schema,
            sla={
                "availability": 0.999,
                "latency_p95_ms": 200,
                "freshness_minutes": 5
            },
            quality_requirements={
                "completeness": 0.98,
                "accuracy": 0.99,
                "uniqueness": 1.0,
                "timeliness": {"max_delay_minutes": 10}
            },
            governance_classification="internal",
            retention_policy={"retention_days": 2555}  # 7 years
        )
        
        # Create data product
        product = DataProduct(
            id=str(uuid.uuid4()),
            name=config["name"],
            domain="customer",
            owner_team="customer-data-team",
            product_type=DataProductType.SOURCE,
            status=DataProductStatus.DEVELOPMENT,
            data_contract=contract,
            description=f"Customer events data product for {', '.join(config['event_types'])}",
            tags=["customer", "events", "real-time"] + config.get("additional_tags", []),
            access_points={
                "streaming": f"kafka://streaming.company.com/customer.{config['name']}",
                "api": f"https://api.customer.company.com/{config['name']}",
                "batch": f"s3://data-mesh/customer/{config['name']}/"
            }
        )
        
        return product

class CustomerSegmentsProductTemplate(DataProductTemplate):
    """Template for customer segments data products"""
    
    def validate_config(self, config: Dict[str, Any]) -> bool:
        """Validate customer segments configuration"""
        required_fields = ["name", "segmentation_logic", "update_frequency"]
        return all(field in config for field in required_fields)
    
    def create_product(self, config: Dict[str, Any], 
                      platform: DataMeshPlatform) -> DataProduct:
        """Create customer segments data product"""
        
        if not self.validate_config(config):
            raise ValueError("Invalid configuration for customer segments product")
        
        # Create schema for customer segments
        schema = {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "segment_id": {"type": "string"},
                "segment_name": {"type": "string"},
                "segment_score": {"type": "number", "minimum": 0, "maximum": 1},
                "segment_attributes": {"type": "object"},
                "effective_date": {"type": "string", "format": "date"},
                "expiration_date": {"type": "string", "format": "date"},
                "model_version": {"type": "string"},
                "confidence_score": {"type": "number", "minimum": 0, "maximum": 1}
            },
            "required": ["customer_id", "segment_id", "segment_name", "effective_date"]
        }
        
        # Create data contract
        contract = DataContract(
            schema_version="1.0",
            data_format="parquet",
            schema=schema,
            sla={
                "availability": 0.995,
                "latency_p95_ms": 1000,
                "freshness_hours": 24
            },
            quality_requirements={
                "completeness": 0.95,
                "accuracy": 0.92,
                "consistency": 0.98
            },
            governance_classification="internal",
            retention_policy={"retention_days": 1095}  # 3 years
        )
        
        # Create data product
        product = DataProduct(
            id=str(uuid.uuid4()),
            name=config["name"],
            domain="customer",
            owner_team="customer-analytics-team",
            product_type=DataProductType.DERIVED,
            status=DataProductStatus.DEVELOPMENT,
            data_contract=contract,
            description=f"Customer segments based on {config['segmentation_logic']}",
            tags=["customer", "segments", "analytics", "ml"] + config.get("additional_tags", []),
            access_points={
                "api": f"https://api.customer.company.com/{config['name']}",
                "batch": f"s3://data-mesh/customer/{config['name']}/",
                "database": f"postgresql://analytics.company.com/customer_segments/{config['name']}"
            }
        )
        
        return product

class DataProductImplementation:
    """Concrete implementation of a data product with full lifecycle management"""
    
    def __init__(self, data_product: DataProduct, 
                 platform: DataMeshPlatform):
        self.data_product = data_product
        self.platform = platform
        self.metrics_collector = DataProductMetricsCollector(data_product)
        self.quality_monitor = DataQualityMonitor(data_product)
        
    async def initialize(self):
        """Initialize data product infrastructure and monitoring"""
        
        # Provision infrastructure
        infrastructure = self.platform.infrastructure_manager.provision_data_product_infrastructure(
            self.data_product
        )
        
        # Setup monitoring
        await self.metrics_collector.initialize()
        await self.quality_monitor.initialize()
        
        # Update status
        self.data_product.status = DataProductStatus.TESTING
        
        logging.info(f"Initialized data product: {self.data_product.name}")
    
    async def produce_data(self, request: Dict[str, Any]) -> Any:
        """Produce data according to the data product contract"""
        
        start_time = datetime.utcnow()
        
        try:
            # Validate request against schema
            if not self.data_product.data_contract.validate_schema(request):
                raise ValueError("Request does not match data contract schema")
            
            # Generate or retrieve data
            data = await self._generate_data(request)
            
            # Validate output quality
            quality_check = await self.quality_monitor.validate_output(data)
            if not quality_check["passed"]:
                raise ValueError(f"Output quality check failed: {quality_check['reason']}")
            
            # Record metrics
            processing_time = (datetime.utcnow() - start_time).total_seconds()
            await self.metrics_collector.record_request(request, processing_time, "success")
            
            return data
            
        except Exception as e:
            processing_time = (datetime.utcnow() - start_time).total_seconds()
            await self.metrics_collector.record_request(request, processing_time, "error", str(e))
            raise
    
    async def _generate_data(self, request: Dict[str, Any]) -> Any:
        """Generate data based on product type and request"""
        
        if self.data_product.product_type == DataProductType.SOURCE:
            # For source data products, retrieve from source systems
            return await self._retrieve_source_data(request)
            
        elif self.data_product.product_type == DataProductType.DERIVED:
            # For derived data products, process from dependencies
            return await self._process_derived_data(request)
            
        elif self.data_product.product_type == DataProductType.AGGREGATE:
            # For aggregate data products, compute aggregations
            return await self._compute_aggregates(request)
            
        elif self.data_product.product_type == DataProductType.ML_FEATURE:
            # For ML feature products, generate features
            return await self._generate_features(request)
        
        else:
            raise ValueError(f"Unknown product type: {self.data_product.product_type}")
    
    async def _retrieve_source_data(self, request: Dict[str, Any]) -> Any:
        """Retrieve data from source systems"""
        # Simulate data retrieval
        await asyncio.sleep(0.1)  # Simulate processing time
        
        return {
            "data": f"Source data for {request.get('query', 'default')}",
            "timestamp": datetime.utcnow().isoformat(),
            "source": "source_system"
        }
    
    async def _process_derived_data(self, request: Dict[str, Any]) -> Any:
        """Process derived data from dependencies"""
        # Simulate data processing
        await asyncio.sleep(0.3)  # Simulate processing time
        
        return {
            "data": f"Derived data for {request.get('query', 'default')}",
            "timestamp": datetime.utcnow().isoformat(),
            "derived_from": self.data_product.dependencies
        }
    
    async def _compute_aggregates(self, request: Dict[str, Any]) -> Any:
        """Compute aggregate data"""
        # Simulate aggregation computation
        await asyncio.sleep(0.5)  # Simulate processing time
        
        return {
            "data": f"Aggregate data for {request.get('query', 'default')}",
            "timestamp": datetime.utcnow().isoformat(),
            "aggregation_window": request.get("window", "1h")
        }
    
    async def _generate_features(self, request: Dict[str, Any]) -> Any:
        """Generate ML features"""
        # Simulate feature generation
        await asyncio.sleep(0.2)  # Simulate processing time
        
        return {
            "features": {
                "feature_1": 0.75,
                "feature_2": 1.23,
                "feature_3": -0.45
            },
            "timestamp": datetime.utcnow().isoformat(),
            "model_version": "1.0"
        }
    
    async def validate_quality(self) -> Dict[str, Any]:
        """Validate current data quality"""
        return await self.quality_monitor.run_quality_checks()
    
    async def get_schema(self) -> Dict[str, Any]:
        """Get current data schema"""
        return {
            "schema": self.data_product.data_contract.schema,
            "version": self.data_product.data_contract.schema_version,
            "format": self.data_product.data_contract.data_format
        }
    
    async def get_metrics(self) -> Dict[str, Any]:
        """Get current metrics"""
        return await self.metrics_collector.get_current_metrics()
    
    async def shutdown(self):
        """Shutdown data product gracefully"""
        await self.metrics_collector.shutdown()
        await self.quality_monitor.shutdown()
        
        logging.info(f"Shutdown data product: {self.data_product.name}")

class DataProductMetricsCollector:
    """Collect and manage metrics for data products"""
    
    def __init__(self, data_product: DataProduct):
        self.data_product = data_product
        self.metrics_history: List[Dict[str, Any]] = []
        
    async def initialize(self):
        """Initialize metrics collection"""
        logging.info(f"Initialized metrics collection for {self.data_product.name}")
    
    async def record_request(self, request: Dict[str, Any], 
                           processing_time: float, 
                           status: str, 
                           error_message: Optional[str] = None):
        """Record request metrics"""
        
        metric_record = {
            "timestamp": datetime.utcnow().isoformat(),
            "request_id": str(uuid.uuid4()),
            "processing_time_seconds": processing_time,
            "status": status,
            "request_size_bytes": len(json.dumps(request)),
            "error_message": error_message
        }
        
        self.metrics_history.append(metric_record)
        
        # Keep only recent metrics (last 1000 requests)
        if len(self.metrics_history) > 1000:
            self.metrics_history = self.metrics_history[-1000:]
    
    async def get_current_metrics(self) -> Dict[str, Any]:
        """Get current aggregated metrics"""
        
        if not self.metrics_history:
            return {"message": "No metrics available"}
        
        recent_metrics = self.metrics_history[-100:]  # Last 100 requests
        
        total_requests = len(recent_metrics)
        successful_requests = len([m for m in recent_metrics if m["status"] == "success"])
        error_rate = (total_requests - successful_requests) / total_requests
        
        processing_times = [m["processing_time_seconds"] for m in recent_metrics]
        avg_processing_time = sum(processing_times) / len(processing_times)
        
        return {
            "total_requests": total_requests,
            "success_rate": successful_requests / total_requests,
            "error_rate": error_rate,
            "avg_processing_time_seconds": avg_processing_time,
            "p95_processing_time_seconds": sorted(processing_times)[int(0.95 * len(processing_times))],
            "sla_compliance": self._check_sla_compliance(recent_metrics)
        }
    
    def _check_sla_compliance(self, metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Check SLA compliance against data contract"""
        
        sla_requirements = self.data_product.data_contract.sla
        
        # Check latency SLA
        processing_times_ms = [m["processing_time_seconds"] * 1000 for m in metrics]
        p95_latency = sorted(processing_times_ms)[int(0.95 * len(processing_times_ms))]
        latency_compliant = p95_latency <= sla_requirements.get("latency_p95_ms", float('inf'))
        
        # Check availability SLA
        successful_requests = len([m for m in metrics if m["status"] == "success"])
        availability = successful_requests / len(metrics)
        availability_compliant = availability >= sla_requirements.get("availability", 0)
        
        return {
            "latency_compliant": latency_compliant,
            "availability_compliant": availability_compliant,
            "overall_compliant": latency_compliant and availability_compliant,
            "current_p95_latency_ms": p95_latency,
            "current_availability": availability
        }
    
    async def shutdown(self):
        """Shutdown metrics collection"""
        # Save metrics to persistent storage if needed
        logging.info(f"Shutdown metrics collection for {self.data_product.name}")

class DataQualityMonitor:
    """Monitor data quality for data products"""
    
    def __init__(self, data_product: DataProduct):
        self.data_product = data_product
        self.quality_history: List[Dict[str, Any]] = []
        
    async def initialize(self):
        """Initialize quality monitoring"""
        logging.info(f"Initialized quality monitoring for {self.data_product.name}")
    
    async def validate_output(self, data: Any) -> Dict[str, Any]:
        """Validate output data quality"""
        
        validation_result = {
            "passed": True,
            "timestamp": datetime.utcnow().isoformat(),
            "checks": {}
        }
        
        # Schema validation
        try:
            schema_valid = self.data_product.data_contract.validate_schema(data)
            validation_result["checks"]["schema"] = {
                "passed": schema_valid,
                "message": "Schema validation passed" if schema_valid else "Schema validation failed"
            }
            if not schema_valid:
                validation_result["passed"] = False
        except Exception as e:
            validation_result["checks"]["schema"] = {
                "passed": False,
                "message": f"Schema validation error: {str(e)}"
            }
            validation_result["passed"] = False
        
        # Business rule validation
        business_rules_passed = await self._validate_business_rules(data)
        validation_result["checks"]["business_rules"] = {
            "passed": business_rules_passed,
            "message": "Business rules validation passed" if business_rules_passed else "Business rules validation failed"
        }
        if not business_rules_passed:
            validation_result["passed"] = False
        
        return validation_result
    
    async def _validate_business_rules(self, data: Any) -> bool:
        """Validate business rules for the data product"""
        
        # Implement domain-specific business rules
        if self.data_product.domain == "customer":
            # Customer domain business rules
            if isinstance(data, dict):
                # Check for required customer fields
                if "customer_id" in data and not data["customer_id"]:
                    return False
                
                # Check for valid timestamp
                if "timestamp" in data:
                    try:
                        datetime.fromisoformat(data["timestamp"].replace('Z', '+00:00'))
                    except:
                        return False
        
        return True
    
    async def run_quality_checks(self) -> Dict[str, Any]:
        """Run comprehensive quality checks"""
        
        quality_report = {
            "product_id": self.data_product.id,
            "product_name": self.data_product.name,
            "check_timestamp": datetime.utcnow().isoformat(),
            "overall_quality_score": 0.0,
            "checks": {}
        }
        
        # Simulate quality checks
        checks = {
            "completeness": 0.97,
            "accuracy": 0.95,
            "consistency": 0.98,
            "timeliness": 0.93,
            "validity": 0.96
        }
        
        requirements = self.data_product.data_contract.quality_requirements
        
        total_score = 0.0
        check_count = 0
        
        for check_name, score in checks.items():
            threshold = requirements.get(check_name, 0.9)
            
            quality_report["checks"][check_name] = {
                "score": score,
                "threshold": threshold,
                "passed": score >= threshold
            }
            
            total_score += score
            check_count += 1
        
        quality_report["overall_quality_score"] = total_score / check_count if check_count > 0 else 0.0
        
        # Store quality history
        self.quality_history.append(quality_report)
        
        return quality_report
    
    async def shutdown(self):
        """Shutdown quality monitoring"""
        logging.info(f"Shutdown quality monitoring for {self.data_product.name}")
```

## Conclusion

Implementing advanced data mesh architecture requires a fundamental shift from centralized data platforms to distributed, domain-oriented data ownership with federated governance and self-serve infrastructure capabilities. The patterns and implementations shown in this guide provide a comprehensive foundation for building scalable, maintainable data mesh architectures.

Key takeaways for successful data mesh implementation include:

1. **Domain-Driven Design**: Organize data products around business domains with clear ownership and accountability
2. **Data as a Product**: Treat data products with the same discipline as software products, including contracts, SLAs, and lifecycle management
3. **Self-Serve Infrastructure**: Provide platform capabilities that enable domain teams to independently develop and deploy data products
4. **Federated Governance**: Implement governance frameworks that balance autonomy with consistency and compliance
5. **Quality and Observability**: Build comprehensive monitoring and quality assurance into every data product

By following these advanced patterns and architectural principles, organizations can build data mesh implementations that scale efficiently while maintaining data quality, governance, and operational excellence across distributed teams and domains.