---
title: "Enterprise Netplan Network Automation: Comprehensive Infrastructure as Code for Production Network Management"
date: 2025-07-22T10:00:00-05:00
draft: false
tags: ["Netplan", "Network Automation", "Infrastructure as Code", "Ubuntu", "YAML", "Network Configuration", "DevOps", "Enterprise Networking", "SDN", "GitOps"]
categories:
- Network Automation
- Infrastructure as Code
- Enterprise Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to Netplan network automation, advanced configuration management, production network orchestration, and comprehensive infrastructure as code implementations"
more_link: "yes"
url: "/enterprise-netplan-network-automation-comprehensive-infrastructure-guide/"
---

Enterprise network infrastructure requires sophisticated automation frameworks, declarative configuration management, and comprehensive orchestration systems to ensure consistent, reliable, and scalable network deployments across thousands of systems. This guide covers advanced Netplan implementations, enterprise network automation architectures, production configuration management, and comprehensive infrastructure as code strategies for modern data centers.

<!--more-->

# [Enterprise Network Automation Architecture](#enterprise-network-automation-architecture)

## Declarative Network Configuration Strategy

Enterprise network management demands declarative, version-controlled, and automated configuration systems that provide consistency, auditability, and rapid deployment capabilities across diverse infrastructure environments.

### Enterprise Netplan Architecture Framework

```
┌─────────────────────────────────────────────────────────────────┐
│             Enterprise Network Automation System                │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│  Config Layer   │  Validation     │  Deployment     │ Monitoring│
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ Git/IaC     │ │ │ Schema Valid│ │ │ Ansible     │ │ │ Metrics│ │
│ │ Templates   │ │ │ Lint/Test   │ │ │ Terraform   │ │ │ Alerts │ │
│ │ Inventory   │ │ │ Simulation  │ │ │ Kubernetes  │ │ │ Logs   │ │
│ │ Secrets     │ │ │ Compliance  │ │ │ CI/CD       │ │ │ SIEM   │ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Version ctrl  │ • Pre-deploy    │ • Zero-touch    │ • Real    │
│ • Declarative   │ • Policy check  │ • Idempotent    │ • Time    │
│ • Multi-env     │ • Security scan │ • Rollback      │ • Audit   │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Network Configuration Maturity Model

| Level | Configuration | Deployment | Validation | Scale |
|-------|--------------|------------|------------|--------|
| **Manual** | Text files | SSH/console | Manual test | 10s |
| **Scripted** | Shell scripts | Automation tools | Basic checks | 100s |
| **Managed** | Config management | Orchestration | Automated tests | 1000s |
| **Enterprise** | GitOps/IaC | Full CI/CD | Policy as code | 10000s+ |

## Advanced Netplan Configuration Framework

### Enterprise Network Configuration System

```python
#!/usr/bin/env python3
"""
Enterprise Netplan Network Configuration Management Framework
"""

import os
import sys
import json
import yaml
import logging
import asyncio
import ipaddress
import subprocess
from typing import Dict, List, Optional, Tuple, Any, Union, Set
from dataclasses import dataclass, asdict, field
from pathlib import Path
from enum import Enum
from datetime import datetime
import jinja2
import jsonschema
from cryptography.fernet import Fernet
import consul
import etcd3
from prometheus_client import Counter, Gauge, Histogram
import aiofiles
import aiohttp
from netaddr import IPNetwork, IPAddress
import dns.resolver
import paramiko
from ansible_runner import run as ansible_run

class NetworkType(Enum):
    PHYSICAL = "physical"
    VLAN = "vlan"
    BOND = "bond"
    BRIDGE = "bridge"
    VXLAN = "vxlan"
    WIREGUARD = "wireguard"
    OPENVSWITCH = "openvswitch"

class ConfigState(Enum):
    PENDING = "pending"
    VALIDATING = "validating"
    DEPLOYING = "deploying"
    ACTIVE = "active"
    FAILED = "failed"
    ROLLBACK = "rollback"

class ValidationLevel(Enum):
    SYNTAX = "syntax"
    SEMANTIC = "semantic"
    POLICY = "policy"
    SECURITY = "security"
    PERFORMANCE = "performance"

@dataclass
class NetworkInterface:
    """Network interface configuration"""
    name: str
    type: NetworkType
    addresses: List[str] = field(default_factory=list)
    gateway4: Optional[str] = None
    gateway6: Optional[str] = None
    nameservers: Dict[str, List[str]] = field(default_factory=dict)
    mtu: int = 1500
    dhcp4: bool = False
    dhcp6: bool = False
    dhcp4_overrides: Dict[str, Any] = field(default_factory=dict)
    dhcp6_overrides: Dict[str, Any] = field(default_factory=dict)
    routes: List[Dict[str, Any]] = field(default_factory=list)
    routing_policy: List[Dict[str, Any]] = field(default_factory=list)
    link_local: List[str] = field(default_factory=list)
    critical: bool = True
    optional: bool = False
    activation_mode: str = "manual"
    parameters: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class NetplanConfig:
    """Complete Netplan configuration"""
    version: int = 2
    renderer: str = "networkd"
    ethernets: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    wifis: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    bonds: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    bridges: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    vlans: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    tunnels: Dict[str, Dict[str, Any]] = field(default_factory=dict)

@dataclass
class NetworkPolicy:
    """Network security and compliance policy"""
    name: str
    description: str
    rules: List[Dict[str, Any]]
    enforcement: str = "strict"
    exceptions: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

class EnterpriseNetplanManager:
    """Enterprise Netplan configuration management system"""
    
    def __init__(self, config_path: str):
        self.config = self._load_config(config_path)
        self.logger = self._setup_logging()
        self.template_env = self._setup_templates()
        self.consul_client = consul.Consul(
            host=self.config.get('consul_host', 'localhost'),
            port=self.config.get('consul_port', 8500)
        )
        self.etcd_client = etcd3.client(
            host=self.config.get('etcd_host', 'localhost'),
            port=self.config.get('etcd_port', 2379)
        )
        
        # Metrics
        self.config_deployments = Counter('netplan_deployments_total',
                                        'Total Netplan deployments',
                                        ['status', 'environment'])
        self.validation_errors = Counter('netplan_validation_errors_total',
                                       'Total validation errors',
                                       ['type', 'severity'])
        self.config_drift = Gauge('netplan_config_drift',
                                'Configuration drift detected',
                                ['hostname', 'interface'])
        
        # Schema for validation
        self.netplan_schema = self._load_netplan_schema()
        self.policies = self._load_policies()
    
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
            '/var/log/netplan-manager/netplan-manager.log',
            maxBytes=10*1024*1024,  # 10MB
            backupCount=10
        )
        file_handler.setLevel(logging.DEBUG)
        
        # Syslog handler for SIEM
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
    
    def _setup_templates(self) -> jinja2.Environment:
        """Setup Jinja2 template environment"""
        template_dir = self.config.get('template_dir', '/etc/netplan-manager/templates')
        
        env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(template_dir),
            autoescape=True,
            trim_blocks=True,
            lstrip_blocks=True
        )
        
        # Add custom filters
        env.filters['ipaddr'] = self._ipaddr_filter
        env.filters['ipsubnet'] = self._ipsubnet_filter
        env.filters['hwaddr'] = self._hwaddr_filter
        
        return env
    
    def _ipaddr_filter(self, value: str, query: str = '') -> str:
        """Jinja2 filter for IP address manipulation"""
        try:
            if query == 'address':
                return str(ipaddress.ip_interface(value).ip)
            elif query == 'network':
                return str(ipaddress.ip_interface(value).network)
            elif query == 'netmask':
                return str(ipaddress.ip_interface(value).netmask)
            elif query == 'prefix':
                return str(ipaddress.ip_interface(value).network.prefixlen)
            else:
                return str(ipaddress.ip_interface(value))
        except:
            return value
    
    def _ipsubnet_filter(self, value: str, prefix: int) -> str:
        """Jinja2 filter for subnet calculation"""
        try:
            network = ipaddress.ip_network(f"{value}/{prefix}", strict=False)
            return str(network)
        except:
            return value
    
    def _hwaddr_filter(self, value: str, format: str = 'linux') -> str:
        """Jinja2 filter for MAC address formatting"""
        # Remove any existing separators
        mac = value.replace(':', '').replace('-', '').replace('.', '')
        
        if format == 'linux':
            # aa:bb:cc:dd:ee:ff
            return ':'.join(mac[i:i+2] for i in range(0, 12, 2)).lower()
        elif format == 'windows':
            # AA-BB-CC-DD-EE-FF
            return '-'.join(mac[i:i+2] for i in range(0, 12, 2)).upper()
        elif format == 'cisco':
            # aabb.ccdd.eeff
            return '.'.join(mac[i:i+4] for i in range(0, 12, 4)).lower()
        else:
            return value
    
    def _load_netplan_schema(self) -> Dict[str, Any]:
        """Load Netplan JSON schema for validation"""
        schema_path = self.config.get('netplan_schema', '/etc/netplan-manager/netplan-schema.json')
        
        if os.path.exists(schema_path):
            with open(schema_path, 'r') as f:
                return json.load(f)
        else:
            # Simplified schema if file not found
            return {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "network": {
                        "type": "object",
                        "properties": {
                            "version": {"type": "integer", "enum": [2]},
                            "renderer": {"type": "string", "enum": ["networkd", "NetworkManager"]},
                            "ethernets": {"type": "object"},
                            "bonds": {"type": "object"},
                            "bridges": {"type": "object"},
                            "vlans": {"type": "object"}
                        },
                        "required": ["version"]
                    }
                },
                "required": ["network"]
            }
    
    def _load_policies(self) -> List[NetworkPolicy]:
        """Load network policies"""
        policies = []
        policy_dir = self.config.get('policy_dir', '/etc/netplan-manager/policies')
        
        if os.path.exists(policy_dir):
            for policy_file in Path(policy_dir).glob('*.yaml'):
                with open(policy_file, 'r') as f:
                    policy_data = yaml.safe_load(f)
                    policies.append(NetworkPolicy(**policy_data))
        
        return policies
    
    async def generate_config(self,
                            hostname: str,
                            environment: str = 'production',
                            variables: Dict[str, Any] = None) -> NetplanConfig:
        """Generate Netplan configuration for host"""
        self.logger.info(f"Generating configuration for {hostname} in {environment}")
        
        # Get host data from inventory
        host_data = await self._get_host_data(hostname)
        
        # Merge with provided variables
        if variables:
            host_data.update(variables)
        
        # Add environment-specific data
        host_data['environment'] = environment
        host_data['hostname'] = hostname
        
        # Load and render template
        template_name = host_data.get('network_template', 'default.yaml.j2')
        template = self.template_env.get_template(template_name)
        
        # Render configuration
        rendered = template.render(**host_data)
        
        # Parse YAML
        config_dict = yaml.safe_load(rendered)
        
        # Create NetplanConfig object
        config = self._dict_to_netplan_config(config_dict.get('network', {}))
        
        # Validate configuration
        validation_results = await self.validate_config(config, hostname)
        
        if not all(r['passed'] for r in validation_results):
            raise ValueError(f"Configuration validation failed: {validation_results}")
        
        return config
    
    async def _get_host_data(self, hostname: str) -> Dict[str, Any]:
        """Get host data from inventory systems"""
        host_data = {}
        
        # Try Consul first
        try:
            _, data = self.consul_client.kv.get(f"hosts/{hostname}/network")
            if data:
                host_data.update(json.loads(data['Value'].decode()))
        except Exception as e:
            self.logger.warning(f"Failed to get data from Consul: {e}")
        
        # Try etcd
        try:
            value = self.etcd_client.get(f"/hosts/{hostname}/network")
            if value:
                host_data.update(json.loads(value))
        except Exception as e:
            self.logger.warning(f"Failed to get data from etcd: {e}")
        
        # Try external API
        if self.config.get('inventory_api'):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        f"{self.config['inventory_api']}/hosts/{hostname}",
                        headers={'Authorization': f"Bearer {self.config.get('api_token')}"}
                    ) as response:
                        if response.status == 200:
                            api_data = await response.json()
                            host_data.update(api_data.get('network', {}))
            except Exception as e:
                self.logger.warning(f"Failed to get data from API: {e}")
        
        # Apply defaults
        defaults = self.config.get('host_defaults', {})
        for key, value in defaults.items():
            if key not in host_data:
                host_data[key] = value
        
        return host_data
    
    def _dict_to_netplan_config(self, config_dict: Dict[str, Any]) -> NetplanConfig:
        """Convert dictionary to NetplanConfig object"""
        return NetplanConfig(
            version=config_dict.get('version', 2),
            renderer=config_dict.get('renderer', 'networkd'),
            ethernets=config_dict.get('ethernets', {}),
            wifis=config_dict.get('wifis', {}),
            bonds=config_dict.get('bonds', {}),
            bridges=config_dict.get('bridges', {}),
            vlans=config_dict.get('vlans', {}),
            tunnels=config_dict.get('tunnels', {})
        )
    
    async def validate_config(self,
                            config: NetplanConfig,
                            hostname: str,
                            level: ValidationLevel = ValidationLevel.POLICY) -> List[Dict[str, Any]]:
        """Validate Netplan configuration"""
        self.logger.info(f"Validating configuration for {hostname} at level {level.value}")
        
        results = []
        
        # Syntax validation
        if level.value in ['syntax', 'semantic', 'policy', 'security', 'performance']:
            syntax_result = await self._validate_syntax(config)
            results.append(syntax_result)
            if not syntax_result['passed']:
                return results
        
        # Semantic validation
        if level.value in ['semantic', 'policy', 'security', 'performance']:
            semantic_result = await self._validate_semantic(config, hostname)
            results.append(semantic_result)
            if not semantic_result['passed']:
                return results
        
        # Policy validation
        if level.value in ['policy', 'security', 'performance']:
            policy_result = await self._validate_policy(config, hostname)
            results.append(policy_result)
        
        # Security validation
        if level.value in ['security', 'performance']:
            security_result = await self._validate_security(config)
            results.append(security_result)
        
        # Performance validation
        if level.value == 'performance':
            perf_result = await self._validate_performance(config)
            results.append(perf_result)
        
        return results
    
    async def _validate_syntax(self, config: NetplanConfig) -> Dict[str, Any]:
        """Validate configuration syntax"""
        result = {
            'validation': 'syntax',
            'passed': True,
            'errors': [],
            'warnings': []
        }
        
        try:
            # Convert to dict for schema validation
            config_dict = {
                'network': {
                    'version': config.version,
                    'renderer': config.renderer
                }
            }
            
            # Add non-empty sections
            for section in ['ethernets', 'bonds', 'bridges', 'vlans']:
                section_data = getattr(config, section)
                if section_data:
                    config_dict['network'][section] = section_data
            
            # Validate against schema
            jsonschema.validate(config_dict, self.netplan_schema)
            
            # Additional syntax checks
            for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
                interfaces = getattr(config, iface_type)
                for name, iface_config in interfaces.items():
                    # Check interface naming
                    if not self._valid_interface_name(name):
                        result['errors'].append(
                            f"Invalid interface name: {name}"
                        )
                        result['passed'] = False
                    
                    # Check IP addresses
                    for addr in iface_config.get('addresses', []):
                        try:
                            ipaddress.ip_interface(addr)
                        except ValueError:
                            result['errors'].append(
                                f"Invalid IP address on {name}: {addr}"
                            )
                            result['passed'] = False
                    
                    # Check MTU
                    mtu = iface_config.get('mtu', 1500)
                    if not 68 <= mtu <= 9000:
                        result['warnings'].append(
                            f"Unusual MTU on {name}: {mtu}"
                        )
        
        except jsonschema.ValidationError as e:
            result['passed'] = False
            result['errors'].append(f"Schema validation failed: {e.message}")
        except Exception as e:
            result['passed'] = False
            result['errors'].append(f"Syntax validation error: {str(e)}")
        
        if not result['passed']:
            self.validation_errors.labels(
                type='syntax',
                severity='error'
            ).inc()
        
        return result
    
    def _valid_interface_name(self, name: str) -> bool:
        """Check if interface name is valid"""
        import re
        
        # Linux interface naming rules
        if len(name) > 15:
            return False
        
        # Must not be empty or contain certain characters
        if not name or not re.match(r'^[a-zA-Z0-9._-]+$', name):
            return False
        
        # Reserved names
        reserved = ['all', 'default', 'lo']
        if name in reserved:
            return False
        
        return True
    
    async def _validate_semantic(self, config: NetplanConfig, hostname: str) -> Dict[str, Any]:
        """Validate configuration semantics"""
        result = {
            'validation': 'semantic',
            'passed': True,
            'errors': [],
            'warnings': []
        }
        
        # Check for duplicate IP addresses
        all_addresses = []
        for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
            interfaces = getattr(config, iface_type)
            for name, iface_config in interfaces.items():
                for addr in iface_config.get('addresses', []):
                    if addr in all_addresses:
                        result['errors'].append(
                            f"Duplicate IP address: {addr}"
                        )
                        result['passed'] = False
                    all_addresses.append(addr)
        
        # Check gateway configuration
        gateway_interfaces = []
        for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
            interfaces = getattr(config, iface_type)
            for name, iface_config in interfaces.items():
                if iface_config.get('gateway4') or iface_config.get('gateway6'):
                    gateway_interfaces.append(name)
        
        if len(gateway_interfaces) > 1:
            result['warnings'].append(
                f"Multiple interfaces with gateways: {gateway_interfaces}"
            )
        
        # Check bond configuration
        for bond_name, bond_config in config.bonds.items():
            interfaces = bond_config.get('interfaces', [])
            
            if len(interfaces) < 2:
                result['errors'].append(
                    f"Bond {bond_name} has less than 2 interfaces"
                )
                result['passed'] = False
            
            # Check bond mode
            params = bond_config.get('parameters', {})
            mode = params.get('mode', 'balance-rr')
            valid_modes = [
                'balance-rr', 'active-backup', 'balance-xor',
                'broadcast', '802.3ad', 'balance-tlb', 'balance-alb'
            ]
            
            if mode not in valid_modes:
                result['errors'].append(
                    f"Invalid bond mode for {bond_name}: {mode}"
                )
                result['passed'] = False
        
        # Check VLAN configuration
        for vlan_name, vlan_config in config.vlans.items():
            vlan_id = vlan_config.get('id')
            if not vlan_id or not 1 <= vlan_id <= 4094:
                result['errors'].append(
                    f"Invalid VLAN ID for {vlan_name}: {vlan_id}"
                )
                result['passed'] = False
            
            link = vlan_config.get('link')
            if not link:
                result['errors'].append(
                    f"No link interface specified for VLAN {vlan_name}"
                )
                result['passed'] = False
        
        if not result['passed']:
            self.validation_errors.labels(
                type='semantic',
                severity='error'
            ).inc()
        
        return result
    
    async def _validate_policy(self, config: NetplanConfig, hostname: str) -> Dict[str, Any]:
        """Validate configuration against policies"""
        result = {
            'validation': 'policy',
            'passed': True,
            'errors': [],
            'warnings': []
        }
        
        # Get host metadata for policy evaluation
        host_data = await self._get_host_data(hostname)
        
        for policy in self.policies:
            # Check if policy applies to this host
            if not self._policy_applies(policy, host_data):
                continue
            
            self.logger.debug(f"Evaluating policy: {policy.name}")
            
            for rule in policy.rules:
                rule_result = self._evaluate_policy_rule(rule, config, host_data)
                
                if not rule_result['passed']:
                    if policy.enforcement == 'strict':
                        result['errors'].extend(rule_result['violations'])
                        result['passed'] = False
                    else:
                        result['warnings'].extend(rule_result['violations'])
        
        if not result['passed']:
            self.validation_errors.labels(
                type='policy',
                severity='error'
            ).inc()
        
        return result
    
    def _policy_applies(self, policy: NetworkPolicy, host_data: Dict[str, Any]) -> bool:
        """Check if policy applies to host"""
        # Check exceptions
        hostname = host_data.get('hostname', '')
        if hostname in policy.exceptions:
            return False
        
        # Check policy metadata conditions
        conditions = policy.metadata.get('conditions', {})
        
        for key, value in conditions.items():
            host_value = host_data.get(key)
            
            if isinstance(value, list):
                if host_value not in value:
                    return False
            else:
                if host_value != value:
                    return False
        
        return True
    
    def _evaluate_policy_rule(self,
                            rule: Dict[str, Any],
                            config: NetplanConfig,
                            host_data: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate a single policy rule"""
        result = {
            'passed': True,
            'violations': []
        }
        
        rule_type = rule.get('type')
        
        if rule_type == 'required_interface':
            # Check for required interfaces
            required = rule.get('interfaces', [])
            all_interfaces = set()
            
            for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
                interfaces = getattr(config, iface_type)
                all_interfaces.update(interfaces.keys())
            
            for req_iface in required:
                if req_iface not in all_interfaces:
                    result['passed'] = False
                    result['violations'].append(
                        f"Required interface missing: {req_iface}"
                    )
        
        elif rule_type == 'mtu_range':
            # Check MTU ranges
            min_mtu = rule.get('min', 1500)
            max_mtu = rule.get('max', 9000)
            
            for iface_type in ['ethernets', 'bonds', 'bridges']:
                interfaces = getattr(config, iface_type)
                for name, iface_config in interfaces.items():
                    mtu = iface_config.get('mtu', 1500)
                    if not min_mtu <= mtu <= max_mtu:
                        result['passed'] = False
                        result['violations'].append(
                            f"Interface {name} MTU {mtu} outside range "
                            f"[{min_mtu}, {max_mtu}]"
                        )
        
        elif rule_type == 'ip_range':
            # Check IP address ranges
            allowed_ranges = [IPNetwork(r) for r in rule.get('ranges', [])]
            
            for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
                interfaces = getattr(config, iface_type)
                for name, iface_config in interfaces.items():
                    for addr in iface_config.get('addresses', []):
                        ip = IPAddress(addr.split('/')[0])
                        
                        if not any(ip in range for range in allowed_ranges):
                            result['passed'] = False
                            result['violations'].append(
                                f"Interface {name} IP {addr} not in allowed ranges"
                            )
        
        elif rule_type == 'dns_servers':
            # Check DNS server configuration
            required_dns = rule.get('servers', [])
            
            for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
                interfaces = getattr(config, iface_type)
                for name, iface_config in interfaces.items():
                    nameservers = iface_config.get('nameservers', {})
                    addresses = nameservers.get('addresses', [])
                    
                    if addresses and not all(dns in required_dns for dns in addresses):
                        result['passed'] = False
                        result['violations'].append(
                            f"Interface {name} has unauthorized DNS servers"
                        )
        
        return result
    
    async def _validate_security(self, config: NetplanConfig) -> Dict[str, Any]:
        """Validate security aspects of configuration"""
        result = {
            'validation': 'security',
            'passed': True,
            'errors': [],
            'warnings': []
        }
        
        # Check for interfaces with DHCP enabled
        dhcp_interfaces = []
        for iface_type in ['ethernets', 'bonds', 'bridges']:
            interfaces = getattr(config, iface_type)
            for name, iface_config in interfaces.items():
                if iface_config.get('dhcp4') or iface_config.get('dhcp6'):
                    dhcp_interfaces.append(name)
        
        if dhcp_interfaces:
            result['warnings'].append(
                f"Interfaces with DHCP enabled: {dhcp_interfaces}"
            )
        
        # Check for missing critical interfaces
        for iface_type in ['ethernets', 'bonds', 'bridges']:
            interfaces = getattr(config, iface_type)
            for name, iface_config in interfaces.items():
                if not iface_config.get('critical', True):
                    result['warnings'].append(
                        f"Interface {name} marked as non-critical"
                    )
        
        # Check for public IP addresses
        public_interfaces = []
        for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
            interfaces = getattr(config, iface_type)
            for name, iface_config in interfaces.items():
                for addr in iface_config.get('addresses', []):
                    ip = ipaddress.ip_interface(addr)
                    if ip.is_global:
                        public_interfaces.append(f"{name}: {addr}")
        
        if public_interfaces:
            result['warnings'].append(
                f"Interfaces with public IPs: {public_interfaces}"
            )
        
        # Check routing policy
        for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
            interfaces = getattr(config, iface_type)
            for name, iface_config in interfaces.items():
                routing_policy = iface_config.get('routing-policy', [])
                if routing_policy:
                    result['warnings'].append(
                        f"Interface {name} has custom routing policy"
                    )
        
        return result
    
    async def _validate_performance(self, config: NetplanConfig) -> Dict[str, Any]:
        """Validate performance aspects of configuration"""
        result = {
            'validation': 'performance',
            'passed': True,
            'errors': [],
            'warnings': []
        }
        
        # Check MTU consistency
        mtu_map = {}
        for iface_type in ['ethernets', 'bonds', 'bridges']:
            interfaces = getattr(config, iface_type)
            for name, iface_config in interfaces.items():
                mtu = iface_config.get('mtu', 1500)
                mtu_map[name] = mtu
        
        # Check VLAN MTU
        for vlan_name, vlan_config in config.vlans.items():
            vlan_mtu = vlan_config.get('mtu', 1500)
            link = vlan_config.get('link')
            
            if link and link in mtu_map:
                parent_mtu = mtu_map[link]
                if vlan_mtu > parent_mtu:
                    result['errors'].append(
                        f"VLAN {vlan_name} MTU ({vlan_mtu}) exceeds "
                        f"parent {link} MTU ({parent_mtu})"
                    )
                    result['passed'] = False
        
        # Check bond configuration for performance
        for bond_name, bond_config in config.bonds.items():
            params = bond_config.get('parameters', {})
            mode = params.get('mode', 'balance-rr')
            
            # Check lacp-rate for 802.3ad
            if mode == '802.3ad':
                lacp_rate = params.get('lacp-rate', 'slow')
                if lacp_rate == 'slow':
                    result['warnings'].append(
                        f"Bond {bond_name} using slow LACP rate"
                    )
            
            # Check mii-monitor-interval
            mii_interval = params.get('mii-monitor-interval', 100)
            if mii_interval > 100:
                result['warnings'].append(
                    f"Bond {bond_name} has high MII monitor interval: {mii_interval}ms"
                )
        
        # Check for jumbo frames consistency
        jumbo_interfaces = []
        standard_interfaces = []
        
        for iface_type in ['ethernets', 'bonds', 'bridges']:
            interfaces = getattr(config, iface_type)
            for name, iface_config in interfaces.items():
                mtu = iface_config.get('mtu', 1500)
                if mtu > 1500:
                    jumbo_interfaces.append(f"{name}({mtu})")
                else:
                    standard_interfaces.append(f"{name}({mtu})")
        
        if jumbo_interfaces and standard_interfaces:
            result['warnings'].append(
                f"Mixed MTU sizes - Jumbo: {jumbo_interfaces}, "
                f"Standard: {standard_interfaces}"
            )
        
        if not result['passed']:
            self.validation_errors.labels(
                type='performance',
                severity='error'
            ).inc()
        
        return result
    
    async def deploy_config(self,
                          config: NetplanConfig,
                          hostname: str,
                          method: str = 'ansible',
                          dry_run: bool = False) -> Dict[str, Any]:
        """Deploy configuration to host"""
        self.logger.info(f"Deploying configuration to {hostname} using {method}")
        
        deployment_result = {
            'hostname': hostname,
            'method': method,
            'timestamp': datetime.utcnow().isoformat(),
            'status': ConfigState.PENDING.value,
            'details': {}
        }
        
        try:
            # Generate configuration file
            config_content = self._generate_netplan_yaml(config)
            
            # Store configuration for audit
            await self._store_config_version(hostname, config_content)
            
            if dry_run:
                deployment_result['status'] = ConfigState.ACTIVE.value
                deployment_result['details']['dry_run'] = True
                deployment_result['details']['config'] = config_content
                return deployment_result
            
            # Deploy based on method
            if method == 'ansible':
                result = await self._deploy_with_ansible(hostname, config_content)
            elif method == 'ssh':
                result = await self._deploy_with_ssh(hostname, config_content)
            elif method == 'api':
                result = await self._deploy_with_api(hostname, config_content)
            else:
                raise ValueError(f"Unknown deployment method: {method}")
            
            deployment_result['details'] = result
            
            if result['success']:
                deployment_result['status'] = ConfigState.ACTIVE.value
                self.config_deployments.labels(
                    status='success',
                    environment=self.config.get('environment', 'production')
                ).inc()
                
                # Schedule post-deployment validation
                asyncio.create_task(
                    self._post_deployment_validation(hostname, config)
                )
            else:
                deployment_result['status'] = ConfigState.FAILED.value
                self.config_deployments.labels(
                    status='failure',
                    environment=self.config.get('environment', 'production')
                ).inc()
                
                # Attempt rollback if configured
                if self.config.get('auto_rollback', True):
                    rollback_result = await self._rollback_config(hostname)
                    deployment_result['rollback'] = rollback_result
            
        except Exception as e:
            self.logger.error(f"Deployment failed: {e}")
            deployment_result['status'] = ConfigState.FAILED.value
            deployment_result['error'] = str(e)
            
            self.config_deployments.labels(
                status='error',
                environment=self.config.get('environment', 'production')
            ).inc()
        
        return deployment_result
    
    def _generate_netplan_yaml(self, config: NetplanConfig) -> str:
        """Generate Netplan YAML from configuration object"""
        config_dict = {
            'network': {
                'version': config.version,
                'renderer': config.renderer
            }
        }
        
        # Add non-empty sections
        for section in ['ethernets', 'wifis', 'bonds', 'bridges', 'vlans', 'tunnels']:
            section_data = getattr(config, section)
            if section_data:
                config_dict['network'][section] = section_data
        
        # Convert to YAML with proper formatting
        yaml_content = yaml.dump(
            config_dict,
            default_flow_style=False,
            allow_unicode=True,
            sort_keys=False
        )
        
        return yaml_content
    
    async def _store_config_version(self, hostname: str, config_content: str):
        """Store configuration version for audit and rollback"""
        timestamp = datetime.utcnow().isoformat()
        
        # Store in Consul
        try:
            self.consul_client.kv.put(
                f"netplan/configs/{hostname}/current",
                config_content.encode()
            )
            self.consul_client.kv.put(
                f"netplan/configs/{hostname}/history/{timestamp}",
                config_content.encode()
            )
        except Exception as e:
            self.logger.error(f"Failed to store config in Consul: {e}")
        
        # Store in etcd
        try:
            self.etcd_client.put(
                f"/netplan/configs/{hostname}/current",
                config_content
            )
            self.etcd_client.put(
                f"/netplan/configs/{hostname}/history/{timestamp}",
                config_content
            )
        except Exception as e:
            self.logger.error(f"Failed to store config in etcd: {e}")
    
    async def _deploy_with_ansible(self, hostname: str, config_content: str) -> Dict[str, Any]:
        """Deploy using Ansible"""
        result = {
            'success': False,
            'output': '',
            'errors': ''
        }
        
        # Create temporary playbook
        playbook = [{
            'name': 'Deploy Netplan Configuration',
            'hosts': hostname,
            'gather_facts': False,
            'tasks': [
                {
                    'name': 'Backup current configuration',
                    'copy': {
                        'src': '/etc/netplan/',
                        'dest': '/etc/netplan.backup/',
                        'remote_src': True,
                        'backup': True
                    }
                },
                {
                    'name': 'Deploy new configuration',
                    'copy': {
                        'content': config_content,
                        'dest': '/etc/netplan/50-cloud-init.yaml',
                        'owner': 'root',
                        'group': 'root',
                        'mode': '0600',
                        'backup': True
                    }
                },
                {
                    'name': 'Validate configuration',
                    'command': 'netplan generate',
                    'register': 'generate_result',
                    'failed_when': 'generate_result.rc != 0'
                },
                {
                    'name': 'Apply configuration',
                    'command': 'netplan apply',
                    'register': 'apply_result',
                    'when': 'generate_result.rc == 0'
                }
            ]
        }]
        
        # Write playbook to temporary file
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.yml', delete=False) as f:
            yaml.dump(playbook, f)
            playbook_path = f.name
        
        try:
            # Run ansible-playbook
            ansible_result = ansible_run(
                playbook=playbook_path,
                inventory=self.config.get('ansible_inventory'),
                extravars={
                    'ansible_user': self.config.get('ansible_user', 'root'),
                    'ansible_ssh_private_key_file': self.config.get('ansible_key_file')
                }
            )
            
            result['success'] = ansible_result.status == 'successful'
            result['output'] = ansible_result.stdout.read()
            
            if not result['success']:
                result['errors'] = ansible_result.stderr.read()
        
        finally:
            # Cleanup
            os.unlink(playbook_path)
        
        return result
    
    async def _deploy_with_ssh(self, hostname: str, config_content: str) -> Dict[str, Any]:
        """Deploy using direct SSH"""
        result = {
            'success': False,
            'output': '',
            'errors': ''
        }
        
        try:
            # Setup SSH connection
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            ssh.connect(
                hostname,
                username=self.config.get('ssh_user', 'root'),
                key_filename=self.config.get('ssh_key_file'),
                timeout=30
            )
            
            # Backup current configuration
            stdin, stdout, stderr = ssh.exec_command(
                'cp -r /etc/netplan/ /etc/netplan.backup/'
            )
            stdout.read()
            
            # Write new configuration
            sftp = ssh.open_sftp()
            with sftp.file('/etc/netplan/50-cloud-init.yaml', 'w') as f:
                f.write(config_content)
            sftp.close()
            
            # Validate configuration
            stdin, stdout, stderr = ssh.exec_command('netplan generate')
            generate_output = stdout.read().decode()
            generate_error = stderr.read().decode()
            
            if stderr.channel.recv_exit_status() != 0:
                result['errors'] = f"Validation failed: {generate_error}"
                
                # Restore backup
                ssh.exec_command('rm -rf /etc/netplan/ && mv /etc/netplan.backup/ /etc/netplan/')
                return result
            
            # Apply configuration
            stdin, stdout, stderr = ssh.exec_command('netplan apply')
            apply_output = stdout.read().decode()
            apply_error = stderr.read().decode()
            
            if stderr.channel.recv_exit_status() == 0:
                result['success'] = True
                result['output'] = f"{generate_output}\n{apply_output}"
            else:
                result['errors'] = f"Apply failed: {apply_error}"
                
                # Restore backup
                ssh.exec_command('rm -rf /etc/netplan/ && mv /etc/netplan.backup/ /etc/netplan/')
                ssh.exec_command('netplan apply')
            
            ssh.close()
            
        except Exception as e:
            result['errors'] = f"SSH deployment failed: {str(e)}"
        
        return result
    
    async def _post_deployment_validation(self, hostname: str, config: NetplanConfig):
        """Validate configuration after deployment"""
        await asyncio.sleep(30)  # Wait for network to stabilize
        
        try:
            # Check connectivity
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            ssh.connect(
                hostname,
                username=self.config.get('ssh_user', 'root'),
                key_filename=self.config.get('ssh_key_file'),
                timeout=10
            )
            
            # Check interface status
            stdin, stdout, stderr = ssh.exec_command('ip -j link show')
            link_data = json.loads(stdout.read().decode())
            
            # Check each configured interface
            expected_interfaces = set()
            for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
                interfaces = getattr(config, iface_type)
                expected_interfaces.update(interfaces.keys())
            
            actual_interfaces = {link['ifname'] for link in link_data}
            
            missing_interfaces = expected_interfaces - actual_interfaces
            if missing_interfaces:
                self.logger.error(
                    f"Missing interfaces on {hostname}: {missing_interfaces}"
                )
                self.config_drift.labels(
                    hostname=hostname,
                    interface='multiple'
                ).set(len(missing_interfaces))
            
            # Check IP addresses
            stdin, stdout, stderr = ssh.exec_command('ip -j addr show')
            addr_data = json.loads(stdout.read().decode())
            
            # Validate each interface configuration
            for iface in addr_data:
                iface_name = iface['ifname']
                
                # Find configuration for this interface
                iface_config = None
                for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
                    interfaces = getattr(config, iface_type)
                    if iface_name in interfaces:
                        iface_config = interfaces[iface_name]
                        break
                
                if iface_config:
                    # Check addresses
                    expected_addrs = set(iface_config.get('addresses', []))
                    actual_addrs = set()
                    
                    for addr_info in iface.get('addr_info', []):
                        addr = f"{addr_info['local']}/{addr_info['prefixlen']}"
                        actual_addrs.add(addr)
                    
                    if expected_addrs != actual_addrs:
                        self.logger.warning(
                            f"Address mismatch on {hostname}:{iface_name} - "
                            f"Expected: {expected_addrs}, Actual: {actual_addrs}"
                        )
                        self.config_drift.labels(
                            hostname=hostname,
                            interface=iface_name
                        ).set(1)
            
            ssh.close()
            
        except Exception as e:
            self.logger.error(f"Post-deployment validation failed: {e}")


class NetplanConfigGenerator:
    """Generate Netplan configurations from templates"""
    
    def __init__(self, template_dir: str):
        self.template_dir = Path(template_dir)
        self.env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(self.template_dir),
            autoescape=True,
            trim_blocks=True,
            lstrip_blocks=True
        )
    
    def generate_datacenter_config(self,
                                 hostname: str,
                                 role: str,
                                 datacenter: str,
                                 rack: str) -> str:
        """Generate datacenter server configuration"""
        template = self.env.get_template('datacenter.yaml.j2')
        
        # Calculate network parameters based on location
        pod = int(rack[1:3])  # Extract pod from rack ID
        rack_num = int(rack[3:5])  # Extract rack number
        
        # Management network: 10.{datacenter}.{pod}.{rack}/24
        mgmt_network = f"10.{self._dc_to_octet(datacenter)}.{pod}.0/24"
        mgmt_ip = f"10.{self._dc_to_octet(datacenter)}.{pod}.{rack_num}"
        
        # Storage network: 172.16.{pod}.0/24
        storage_network = f"172.16.{pod}.0/24"
        storage_ip = f"172.16.{pod}.{rack_num}"
        
        # vMotion network: 172.17.{pod}.0/24
        vmotion_network = f"172.17.{pod}.0/24"
        vmotion_ip = f"172.17.{pod}.{rack_num}"
        
        return template.render(
            hostname=hostname,
            role=role,
            datacenter=datacenter,
            rack=rack,
            mgmt_ip=mgmt_ip,
            mgmt_network=mgmt_network,
            storage_ip=storage_ip,
            storage_network=storage_network,
            vmotion_ip=vmotion_ip,
            vmotion_network=vmotion_network,
            dns_servers=['8.8.8.8', '8.8.4.4'],
            ntp_servers=['0.pool.ntp.org', '1.pool.ntp.org'],
            domain='example.com'
        )
    
    def _dc_to_octet(self, datacenter: str) -> int:
        """Convert datacenter code to IP octet"""
        dc_map = {
            'dc1': 1,
            'dc2': 2,
            'dc3': 3,
            'aws-us-east-1': 10,
            'aws-us-west-2': 11,
            'azure-eastus': 20,
            'azure-westus': 21
        }
        return dc_map.get(datacenter.lower(), 99)


async def main():
    """Main execution function"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise Netplan Manager')
    parser.add_argument('--config', default='/etc/netplan-manager/config.yaml',
                       help='Configuration file path')
    parser.add_argument('--action', required=True,
                       choices=['generate', 'validate', 'deploy', 'rollback', 'status'],
                       help='Action to perform')
    parser.add_argument('--hostname', required=True, help='Target hostname')
    parser.add_argument('--environment', default='production',
                       help='Deployment environment')
    parser.add_argument('--template', help='Template name')
    parser.add_argument('--dry-run', action='store_true',
                       help='Perform dry run')
    parser.add_argument('--method', default='ansible',
                       choices=['ansible', 'ssh', 'api'],
                       help='Deployment method')
    
    args = parser.parse_args()
    
    # Initialize manager
    manager = EnterpriseNetplanManager(args.config)
    
    try:
        if args.action == 'generate':
            # Generate configuration
            config = await manager.generate_config(
                args.hostname,
                args.environment
            )
            
            # Output YAML
            yaml_content = manager._generate_netplan_yaml(config)
            print(yaml_content)
        
        elif args.action == 'validate':
            # Generate and validate configuration
            config = await manager.generate_config(
                args.hostname,
                args.environment
            )
            
            results = await manager.validate_config(
                config,
                args.hostname,
                ValidationLevel.POLICY
            )
            
            # Display results
            for result in results:
                print(f"\n{result['validation'].upper()} Validation:")
                print(f"  Status: {'PASSED' if result['passed'] else 'FAILED'}")
                
                if result['errors']:
                    print("  Errors:")
                    for error in result['errors']:
                        print(f"    - {error}")
                
                if result['warnings']:
                    print("  Warnings:")
                    for warning in result['warnings']:
                        print(f"    - {warning}")
        
        elif args.action == 'deploy':
            # Generate, validate, and deploy
            config = await manager.generate_config(
                args.hostname,
                args.environment
            )
            
            deployment = await manager.deploy_config(
                config,
                args.hostname,
                method=args.method,
                dry_run=args.dry_run
            )
            
            print(json.dumps(deployment, indent=2))
        
        elif args.action == 'rollback':
            # Rollback to previous configuration
            result = await manager._rollback_config(args.hostname)
            print(json.dumps(result, indent=2))
        
        elif args.action == 'status':
            # Get current status
            # This would query the system for current configuration
            print(f"Status check for {args.hostname}")
    
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
```

# [Enterprise Netplan Templates](#enterprise-netplan-templates)

## Production Template Examples

### Datacenter Server Template

```yaml
# datacenter.yaml.j2 - Enterprise datacenter server network configuration
network:
  version: 2
  renderer: networkd
  
  ethernets:
    # Management interface
    eno1:
      addresses:
        - {{ mgmt_ip }}/24
      gateway4: {{ mgmt_network | ipaddr('1') | ipaddr('address') }}
      nameservers:
        addresses: {{ dns_servers }}
        search:
          - {{ domain }}
      routes:
        - to: 10.0.0.0/8
          via: {{ mgmt_network | ipaddr('1') | ipaddr('address') }}
          metric: 100
    
    # Storage network interfaces (bonded)
    eno2:
      mtu: 9000
    eno3:
      mtu: 9000
    
    # vMotion/Migration interfaces (bonded)
    eno4:
      mtu: 9000
    eno5:
      mtu: 9000
    
    # VM traffic interfaces (bonded)
    eno6:
      mtu: 1500
    eno7:
      mtu: 1500
  
  bonds:
    # Storage bond (LACP)
    bond-storage:
      interfaces:
        - eno2
        - eno3
      addresses:
        - {{ storage_ip }}/24
      mtu: 9000
      parameters:
        mode: 802.3ad
        lacp-rate: fast
        mii-monitor-interval: 50
        transmit-hash-policy: layer3+4
    
    # vMotion bond (Active/Backup)
    bond-vmotion:
      interfaces:
        - eno4
        - eno5
      addresses:
        - {{ vmotion_ip }}/24
      mtu: 9000
      parameters:
        mode: active-backup
        mii-monitor-interval: 50
        primary: eno4
    
    # VM traffic bond (LACP)
    bond-vm:
      interfaces:
        - eno6
        - eno7
      mtu: 1500
      parameters:
        mode: 802.3ad
        lacp-rate: fast
        mii-monitor-interval: 50
        transmit-hash-policy: layer2+3
  
  vlans:
    # Production VLANs
    {% for vlan_id in production_vlans %}
    vlan{{ vlan_id }}:
      id: {{ vlan_id }}
      link: bond-vm
      addresses:
        - {{ vlan_networks[vlan_id] | ipsubnet(24, rack_num) }}
    {% endfor %}
```

### Kubernetes Node Template

```yaml
# kubernetes.yaml.j2 - Kubernetes node network configuration
network:
  version: 2
  renderer: networkd
  
  ethernets:
    # Primary interface
    {{ primary_interface }}:
      dhcp4: false
      dhcp6: false
      {% if not bonding_enabled %}
      addresses:
        - {{ node_ip }}/{{ subnet_prefix }}
      gateway4: {{ gateway }}
      nameservers:
        addresses: {{ dns_servers }}
      {% endif %}
    
    {% if bonding_enabled %}
    # Secondary interface for bonding
    {{ secondary_interface }}:
      dhcp4: false
      dhcp6: false
    {% endif %}
  
  {% if bonding_enabled %}
  bonds:
    bond0:
      interfaces:
        - {{ primary_interface }}
        - {{ secondary_interface }}
      addresses:
        - {{ node_ip }}/{{ subnet_prefix }}
      gateway4: {{ gateway }}
      nameservers:
        addresses: {{ dns_servers }}
      parameters:
        mode: {{ bond_mode | default('802.3ad') }}
        lacp-rate: fast
        mii-monitor-interval: 100
  {% endif %}
  
  bridges:
    # CNI bridge for pod networking
    cni0:
      addresses:
        - {{ pod_network | default('10.244.0.1/24') }}
      forward-delay: 0
      stp: false
      parameters:
        forward-delay: 0
    
    {% if calico_enabled %}
    # Calico IPIP tunnel bridge
    tunl0:
      addresses:
        - {{ calico_tunnel_ip }}/32
      parameters:
        mode: ipip
    {% endif %}
```

## Network Automation Scripts

### Bulk Configuration Deployment

```bash
#!/bin/bash
# deploy-netplan-bulk.sh - Deploy Netplan configurations to multiple hosts

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY_FILE="${1:-/etc/netplan-manager/inventory.yaml}"
ENVIRONMENT="${2:-production}"
LOG_DIR="/var/log/netplan-deployments"
PARALLEL_JOBS=10

# Create log directory
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/bulk-deploy-$(date +%Y%m%d-%H%M%S).log"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG_FILE" >&2
}

# Load inventory
load_inventory() {
    log "Loading inventory from $INVENTORY_FILE"
    
    # Parse YAML inventory
    python3 -c "
import yaml
import sys

with open('$INVENTORY_FILE', 'r') as f:
    inventory = yaml.safe_load(f)

for group, hosts in inventory.get('hosts', {}).items():
    if '$ENVIRONMENT' in hosts.get('environments', []):
        for host in hosts.get('members', []):
            print(f\"{host} {group}\")
"
}

# Deploy to single host
deploy_host() {
    local hostname="$1"
    local group="$2"
    local log_file="$LOG_DIR/deploy-${hostname}-$(date +%Y%m%d-%H%M%S).log"
    
    log "Deploying to $hostname (group: $group)"
    
    # Generate configuration
    if ! netplan-manager --action generate \
                       --hostname "$hostname" \
                       --environment "$ENVIRONMENT" \
                       > "/tmp/netplan-${hostname}.yaml" 2>"$log_file"; then
        error "Failed to generate config for $hostname"
        return 1
    fi
    
    # Validate configuration
    if ! netplan-manager --action validate \
                       --hostname "$hostname" \
                       --environment "$ENVIRONMENT" \
                       >> "$log_file" 2>&1; then
        error "Validation failed for $hostname"
        return 1
    fi
    
    # Deploy configuration
    if ! netplan-manager --action deploy \
                       --hostname "$hostname" \
                       --environment "$ENVIRONMENT" \
                       --method ansible \
                       >> "$log_file" 2>&1; then
        error "Deployment failed for $hostname"
        return 1
    fi
    
    log "Successfully deployed to $hostname"
    return 0
}

# Export function for parallel execution
export -f deploy_host log error
export LOG_DIR ENVIRONMENT

# Main deployment
main() {
    log "Starting bulk Netplan deployment for environment: $ENVIRONMENT"
    
    # Get host list
    hosts=$(load_inventory)
    
    if [[ -z "$hosts" ]]; then
        error "No hosts found in inventory for environment $ENVIRONMENT"
        exit 1
    fi
    
    # Count hosts
    host_count=$(echo "$hosts" | wc -l)
    log "Found $host_count hosts to deploy"
    
    # Deploy in parallel
    echo "$hosts" | parallel -j "$PARALLEL_JOBS" --colsep ' ' deploy_host {1} {2}
    
    # Check results
    success_count=$(grep -c "Successfully deployed" "$LOG_FILE" || true)
    failed_count=$((host_count - success_count))
    
    log "Deployment complete: $success_count succeeded, $failed_count failed"
    
    if [[ $failed_count -gt 0 ]]; then
        error "Some deployments failed. Check logs in $LOG_DIR"
        exit 1
    fi
}

# Run main function
main
```

### Network Configuration Validator

```python
#!/usr/bin/env python3
"""
Network Configuration Compliance Validator
"""

import asyncio
import argparse
import yaml
from typing import List, Dict, Any
from pathlib import Path

class NetworkComplianceValidator:
    """Validate network configurations against compliance policies"""
    
    def __init__(self, policy_file: str):
        self.policies = self._load_policies(policy_file)
        self.violations = []
    
    def _load_policies(self, policy_file: str) -> Dict[str, Any]:
        """Load compliance policies"""
        with open(policy_file, 'r') as f:
            return yaml.safe_load(f)
    
    async def validate_host(self, hostname: str, config_file: str) -> bool:
        """Validate host configuration"""
        with open(config_file, 'r') as f:
            config = yaml.safe_load(f)
        
        network_config = config.get('network', {})
        
        # Run all validators
        validators = [
            self._validate_ip_ranges,
            self._validate_vlan_usage,
            self._validate_mtu_settings,
            self._validate_security_settings,
            self._validate_redundancy
        ]
        
        for validator in validators:
            await validator(hostname, network_config)
        
        return len(self.violations) == 0
    
    async def _validate_ip_ranges(self, hostname: str, config: Dict[str, Any]):
        """Validate IP address assignments"""
        allowed_ranges = self.policies.get('ip_ranges', {})
        
        for iface_type in ['ethernets', 'bonds', 'bridges', 'vlans']:
            interfaces = config.get(iface_type, {})
            
            for iface_name, iface_config in interfaces.items():
                for address in iface_config.get('addresses', []):
                    if not self._ip_in_allowed_ranges(address, allowed_ranges):
                        self.violations.append({
                            'host': hostname,
                            'interface': iface_name,
                            'type': 'ip_range',
                            'message': f'IP {address} not in allowed ranges'
                        })
    
    async def _validate_redundancy(self, hostname: str, config: Dict[str, Any]):
        """Validate network redundancy requirements"""
        redundancy_required = self.policies.get('redundancy_required', [])
        
        bonds = config.get('bonds', {})
        
        for req_type in redundancy_required:
            if req_type == 'management' and not any('mgmt' in b for b in bonds):
                self.violations.append({
                    'host': hostname,
                    'type': 'redundancy',
                    'message': 'No redundant management interface found'
                })

# Example compliance policy file:
"""
# compliance-policy.yaml
ip_ranges:
  management:
    - 10.0.0.0/8
  production:
    - 172.16.0.0/12
  dmz:
    - 192.168.0.0/16

vlan_ranges:
  production: [100, 199]
  development: [200, 299]
  management: [10, 19]

mtu_requirements:
  storage: 9000
  vmotion: 9000
  standard: 1500

security_requirements:
  - no_dhcp_on_production
  - no_public_ips_on_internal
  - firewall_zones_required

redundancy_required:
  - management
  - storage
  - production
"""
```

# [Production Operations](#production-operations)

## Monitoring and Alerting

### Netplan Configuration Drift Detection

```python
#!/usr/bin/env python3
"""
Netplan Configuration Drift Detector
"""

import asyncio
import difflib
import hashlib
from datetime import datetime
from prometheus_client import Gauge, Counter

class DriftDetector:
    """Detect configuration drift across fleet"""
    
    def __init__(self, manager):
        self.manager = manager
        self.drift_gauge = Gauge(
            'netplan_config_drift_score',
            'Configuration drift score',
            ['hostname']
        )
        self.drift_events = Counter(
            'netplan_drift_events_total',
            'Total drift events detected',
            ['hostname', 'severity']
        )
    
    async def check_drift(self, hostname: str) -> Dict[str, Any]:
        """Check for configuration drift"""
        # Get expected configuration
        expected = await self.manager.generate_config(hostname)
        expected_yaml = self.manager._generate_netplan_yaml(expected)
        
        # Get actual configuration
        actual_yaml = await self._get_actual_config(hostname)
        
        # Calculate drift
        drift_score = self._calculate_drift_score(expected_yaml, actual_yaml)
        
        self.drift_gauge.labels(hostname=hostname).set(drift_score)
        
        if drift_score > 0:
            severity = 'high' if drift_score > 50 else 'low'
            self.drift_events.labels(
                hostname=hostname,
                severity=severity
            ).inc()
            
            return {
                'hostname': hostname,
                'drift_detected': True,
                'drift_score': drift_score,
                'expected_hash': hashlib.sha256(expected_yaml.encode()).hexdigest(),
                'actual_hash': hashlib.sha256(actual_yaml.encode()).hexdigest(),
                'diff': list(difflib.unified_diff(
                    expected_yaml.splitlines(),
                    actual_yaml.splitlines(),
                    fromfile='expected',
                    tofile='actual'
                ))
            }
        
        return {
            'hostname': hostname,
            'drift_detected': False,
            'drift_score': 0
        }
```

## Troubleshooting Guide

### Common Issues and Solutions

#### 1. Network Connectivity Lost After Apply

```bash
# Emergency recovery procedure
# Boot with recovery/single-user mode

# Mount root filesystem
mount -o remount,rw /

# Restore backup configuration
cp /etc/netplan.backup/*.yaml /etc/netplan/

# Remove problematic configuration
rm /etc/netplan/50-cloud-init.yaml

# Apply working configuration
netplan --debug generate
netplan --debug apply

# If still failing, use networkd directly
systemctl stop systemd-networkd
systemctl start systemd-networkd
```

#### 2. Validation Errors

```bash
# Debug validation issues
netplan --debug generate

# Check systemd-networkd status
systemctl status systemd-networkd
journalctl -u systemd-networkd -f

# Validate YAML syntax
python3 -c "import yaml; yaml.safe_load(open('/etc/netplan/50-cloud-init.yaml'))"

# Test configuration without applying
netplan try --timeout 120
```

#### 3. Bond Interface Issues

```bash
# Check bond status
cat /proc/net/bonding/bond0

# Monitor LACP
tcpdump -i eno1 -n "ether proto 0x8809"

# Force bond interface up
ip link set bond0 up
ip link set eno1 master bond0
ip link set eno2 master bond0

# Check switch LACP configuration
show lacp neighbor  # On switch
```

#### 4. VLAN Connectivity Problems

```bash
# Check VLAN interface
ip -d link show vlan100

# Verify VLAN tagging
tcpdump -i bond0 -n -e vlan

# Test specific VLAN
ip link add link bond0 name test100 type vlan id 100
ip addr add 192.168.100.1/24 dev test100
ip link set test100 up
ping 192.168.100.254
```

## Best Practices

### 1. Configuration Management
- Always version control configurations
- Use templates for consistency
- Implement pre-deployment validation
- Maintain configuration backups
- Document all customizations

### 2. Security Considerations
- Restrict configuration file permissions (600)
- Use encrypted communication for deployment
- Implement network segmentation
- Regular security audits
- Monitor for unauthorized changes

### 3. Performance Optimization
- Use appropriate MTU sizes
- Configure bond modes correctly
- Implement traffic shaping where needed
- Monitor interface statistics
- Regular performance testing

### 4. Operational Excellence
- Automated deployment pipelines
- Comprehensive monitoring
- Drift detection and remediation
- Regular disaster recovery drills
- Clear rollback procedures

## Conclusion

Enterprise Netplan network automation provides the foundation for scalable, reliable, and secure network infrastructure management. By implementing comprehensive automation frameworks, validation systems, and monitoring solutions, organizations can maintain consistent network configurations across thousands of systems while ensuring compliance, security, and operational efficiency.

The combination of declarative configuration, infrastructure as code principles, and sophisticated orchestration enables network teams to manage complex environments with confidence, reducing manual errors and accelerating deployment times while maintaining the highest standards of reliability and security.