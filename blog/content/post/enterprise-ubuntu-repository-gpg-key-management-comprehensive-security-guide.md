---
title: "Enterprise Ubuntu Repository GPG Key Management: Comprehensive Security Infrastructure and Automated Package Trust Framework"
date: 2025-07-08T10:00:00-05:00
draft: false
tags: ["Ubuntu", "GPG", "APT", "Repository Security", "Package Management", "Key Infrastructure", "Enterprise Security", "Automation", "DevSecOps", "Supply Chain"]
categories:
- Security Infrastructure
- Package Management
- Enterprise Automation
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to Ubuntu repository GPG key management, advanced package security frameworks, automated trust infrastructure, and comprehensive supply chain security implementations"
more_link: "yes"
url: "/enterprise-ubuntu-repository-gpg-key-management-comprehensive-security-guide/"
---

Enterprise Ubuntu repository management requires sophisticated GPG key infrastructure, automated trust validation systems, and comprehensive security frameworks to ensure package integrity across thousands of systems while maintaining supply chain security. This guide covers advanced repository key management, enterprise package security architectures, automated trust validation systems, and production-grade APT repository infrastructures.

<!--more-->

# [Enterprise Repository Security Architecture Overview](#enterprise-repository-security-architecture-overview)

## Package Trust Infrastructure Strategy

Enterprise Ubuntu deployments demand comprehensive repository security across multiple trust boundaries, requiring automated key management, cryptographic validation, and supply chain attestation to maintain security posture at scale.

### Enterprise Repository Security Framework

```
┌─────────────────────────────────────────────────────────────────┐
│            Enterprise Repository Security Architecture          │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│  Key Layer      │  Trust Layer    │  Validation     │ Management│
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ GPG Keys    │ │ │ Key Servers │ │ │ SBOM Valid  │ │ │ Vault │ │
│ │ X.509 Certs │ │ │ Trust Chain │ │ │ Sig Verify  │ │ │ HSM   │ │
│ │ Code Sign   │ │ │ Web of Trust│ │ │ Hash Check  │ │ │ PKI   │ │
│ │ Timestamping│ │ │ Notary      │ │ │ Policy Eng  │ │ │ SIEM  │ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Multi-algo    │ • Distributed   │ • Real-time     │ • Central │
│ • Hardware      │ • Attestation   │ • Automated     │ • Policy  │
│ • Rotation      │ • Transparency  │ • Forensic      │ • Audit   │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Repository Security Maturity Model

| Level | Key Management | Trust Validation | Supply Chain | Scale |
|-------|---------------|-----------------|--------------|-------|
| **Basic** | Manual GPG import | Basic signature check | None | 10s |
| **Standard** | Scripted key updates | Automated validation | Package scanning | 100s |
| **Advanced** | Key rotation system | Trust chain verify | SBOM generation | 1000s |
| **Enterprise** | HSM integration | Zero-trust model | Full attestation | 10000s+ |

## Advanced GPG Key Management Framework

### Enterprise Repository Security System

```python
#!/usr/bin/env python3
"""
Enterprise Ubuntu Repository GPG Key Management and Security Framework
"""

import os
import sys
import json
import yaml
import logging
import time
import asyncio
import hashlib
import subprocess
import tempfile
import gnupg
from typing import Dict, List, Optional, Tuple, Any, Union, Set
from dataclasses import dataclass, asdict, field
from pathlib import Path
from enum import Enum
from datetime import datetime, timedelta
import aiohttp
import aiofiles
from cryptography import x509
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
import apt
import apt_pkg
from prometheus_client import Counter, Gauge, Histogram
import redis
import hvac  # HashiCorp Vault
from azure.keyvault.keys import KeyClient
from azure.identity import DefaultAzureCredential

class TrustLevel(Enum):
    UNTRUSTED = "untrusted"
    COMMUNITY = "community"
    VERIFIED = "verified"
    ENTERPRISE = "enterprise"
    CRITICAL = "critical"

class KeyState(Enum):
    UNKNOWN = "unknown"
    VALID = "valid"
    EXPIRED = "expired"
    REVOKED = "revoked"
    ROTATING = "rotating"
    COMPROMISED = "compromised"

class ValidationResult(Enum):
    PASSED = "passed"
    FAILED = "failed"
    WARNING = "warning"
    SKIP = "skip"

@dataclass
class GPGKeyInfo:
    """GPG key information structure"""
    fingerprint: str
    key_id: str
    algorithm: str
    creation_date: datetime
    expiration_date: Optional[datetime]
    trust_level: TrustLevel
    key_state: KeyState
    uid_list: List[str]
    subkeys: List[Dict[str, Any]]
    signatures: List[Dict[str, Any]]
    capabilities: List[str]
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class RepositoryConfig:
    """Repository configuration structure"""
    name: str
    url: str
    components: List[str]
    architectures: List[str]
    gpg_keys: List[str]
    trust_level: TrustLevel
    validation_policy: Dict[str, Any]
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class SecurityPolicy:
    """Security policy configuration"""
    min_key_size: int = 4096
    allowed_algorithms: List[str] = field(default_factory=lambda: ["RSA", "Ed25519"])
    max_key_age_days: int = 365
    require_key_rotation: bool = True
    require_hardware_keys: bool = False
    trust_chain_depth: int = 3
    require_transparency_log: bool = True
    sbom_required: bool = True
    signature_algorithms: List[str] = field(default_factory=lambda: ["SHA512"])

class EnterpriseGPGKeyManager:
    """Enterprise GPG key management system"""
    
    def __init__(self, config_path: str):
        self.config = self._load_config(config_path)
        self.logger = self._setup_logging()
        self.gpg = gnupg.GPG(gnupghome=self.config.get('gpg_home', '/var/lib/apt/gpg'))
        self.vault_client = self._init_vault()
        self.azure_kv_client = self._init_azure_kv()
        self.redis_client = self._init_redis()
        self.security_policy = SecurityPolicy(**self.config.get('security_policy', {}))
        
        # Metrics
        self.key_operations = Counter('gpg_key_operations_total', 
                                     'Total GPG key operations',
                                     ['operation', 'status'])
        self.validation_results = Counter('repository_validations_total',
                                        'Total repository validations',
                                        ['repository', 'result'])
        self.key_age = Gauge('gpg_key_age_days',
                           'Age of GPG keys in days',
                           ['fingerprint'])
        
    def _load_config(self, config_path: str) -> Dict[str, Any]:
        """Load configuration from file"""
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    
    def _setup_logging(self) -> logging.Logger:
        """Setup enterprise logging"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        # Add handlers for different log destinations
        handlers = []
        
        # File handler
        file_handler = logging.FileHandler('/var/log/gpg-key-manager.log')
        file_handler.setLevel(logging.INFO)
        
        # Syslog handler for SIEM integration
        syslog_handler = logging.handlers.SysLogHandler(
            address=self.config.get('syslog_server', 'localhost')
        )
        syslog_handler.setLevel(logging.WARNING)
        
        # Format
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        
        for handler in [file_handler, syslog_handler]:
            handler.setFormatter(formatter)
            logger.addHandler(handler)
        
        return logger
    
    def _init_vault(self) -> Optional[hvac.Client]:
        """Initialize HashiCorp Vault client"""
        if not self.config.get('vault_enabled'):
            return None
        
        client = hvac.Client(
            url=self.config['vault_url'],
            token=self.config.get('vault_token')
        )
        
        if not client.is_authenticated():
            self.logger.error("Failed to authenticate with Vault")
            return None
        
        return client
    
    def _init_azure_kv(self) -> Optional[KeyClient]:
        """Initialize Azure Key Vault client"""
        if not self.config.get('azure_kv_enabled'):
            return None
        
        credential = DefaultAzureCredential()
        return KeyClient(
            vault_url=self.config['azure_kv_url'],
            credential=credential
        )
    
    def _init_redis(self) -> redis.Redis:
        """Initialize Redis for caching"""
        return redis.Redis(
            host=self.config.get('redis_host', 'localhost'),
            port=self.config.get('redis_port', 6379),
            decode_responses=True
        )
    
    async def import_repository_key(self, 
                                  repository: str,
                                  key_url: str,
                                  trust_level: TrustLevel = TrustLevel.COMMUNITY) -> GPGKeyInfo:
        """Import GPG key for repository with validation"""
        self.logger.info(f"Importing GPG key for repository: {repository}")
        
        try:
            # Download key
            key_data = await self._download_key(key_url)
            
            # Validate key
            validation_result = await self._validate_key(key_data)
            if validation_result != ValidationResult.PASSED:
                raise ValueError(f"Key validation failed: {validation_result}")
            
            # Parse key information
            key_info = self._parse_key_info(key_data)
            
            # Check security policy
            policy_violations = self._check_security_policy(key_info)
            if policy_violations:
                self.logger.warning(f"Security policy violations: {policy_violations}")
                if self.config.get('enforce_policy', True):
                    raise ValueError(f"Security policy violations: {policy_violations}")
            
            # Store in secure key storage
            if self.vault_client:
                await self._store_key_in_vault(key_info, key_data)
            
            # Import to APT keyring
            result = self.gpg.import_keys(key_data)
            if not result.imported:
                raise ValueError("Failed to import key to GPG keyring")
            
            # Configure APT repository
            await self._configure_apt_repository(repository, key_info)
            
            # Log to transparency log
            if self.security_policy.require_transparency_log:
                await self._log_to_transparency_log(repository, key_info)
            
            # Update metrics
            self.key_operations.labels(operation='import', status='success').inc()
            
            # Cache key info
            self._cache_key_info(key_info)
            
            self.logger.info(f"Successfully imported key: {key_info.fingerprint}")
            return key_info
            
        except Exception as e:
            self.logger.error(f"Failed to import key: {e}")
            self.key_operations.labels(operation='import', status='failure').inc()
            raise
    
    async def _download_key(self, key_url: str) -> str:
        """Download GPG key from URL"""
        async with aiohttp.ClientSession() as session:
            async with session.get(key_url, timeout=30) as response:
                if response.status != 200:
                    raise ValueError(f"Failed to download key: HTTP {response.status}")
                return await response.text()
    
    async def _validate_key(self, key_data: str) -> ValidationResult:
        """Validate GPG key data"""
        try:
            # Import temporarily for validation
            temp_gpg = gnupg.GPG(gnupghome=tempfile.mkdtemp())
            result = temp_gpg.import_keys(key_data)
            
            if not result.imported:
                return ValidationResult.FAILED
            
            # Get key info
            keys = temp_gpg.list_keys()
            if not keys:
                return ValidationResult.FAILED
            
            key = keys[0]
            
            # Check key size
            if int(key.get('length', 0)) < self.security_policy.min_key_size:
                self.logger.warning(f"Key size below minimum: {key.get('length')}")
                return ValidationResult.WARNING
            
            # Check algorithm
            algo = key.get('algo')
            if algo not in self.security_policy.allowed_algorithms:
                self.logger.warning(f"Unsupported algorithm: {algo}")
                return ValidationResult.WARNING
            
            # Check expiration
            expires = key.get('expires')
            if expires and int(expires) < time.time():
                return ValidationResult.FAILED
            
            return ValidationResult.PASSED
            
        except Exception as e:
            self.logger.error(f"Key validation error: {e}")
            return ValidationResult.FAILED
    
    def _parse_key_info(self, key_data: str) -> GPGKeyInfo:
        """Parse GPG key information"""
        temp_gpg = gnupg.GPG(gnupghome=tempfile.mkdtemp())
        result = temp_gpg.import_keys(key_data)
        
        if not result.imported:
            raise ValueError("Failed to parse key")
        
        keys = temp_gpg.list_keys()
        key = keys[0]
        
        # Parse key details
        creation_date = datetime.fromtimestamp(int(key['date']))
        expiration_date = None
        if key.get('expires'):
            expiration_date = datetime.fromtimestamp(int(key['expires']))
        
        # Get UIDs
        uids = key.get('uids', [])
        
        # Get subkeys
        subkeys = []
        for subkey in key.get('subkeys', []):
            subkeys.append({
                'keyid': subkey[0],
                'length': subkey[1],
                'algo': subkey[2],
                'caps': subkey[3],
                'created': subkey[4],
                'expires': subkey[5]
            })
        
        return GPGKeyInfo(
            fingerprint=key['fingerprint'],
            key_id=key['keyid'],
            algorithm=key['algo'],
            creation_date=creation_date,
            expiration_date=expiration_date,
            trust_level=TrustLevel.COMMUNITY,
            key_state=KeyState.VALID,
            uid_list=uids,
            subkeys=subkeys,
            signatures=[],
            capabilities=list(key.get('cap', '')),
            metadata={
                'length': key['length'],
                'ownertrust': key.get('ownertrust', '-'),
                'trust': key.get('trust', '-')
            }
        )
    
    def _check_security_policy(self, key_info: GPGKeyInfo) -> List[str]:
        """Check key against security policy"""
        violations = []
        
        # Check key age
        key_age = (datetime.now() - key_info.creation_date).days
        if key_age > self.security_policy.max_key_age_days:
            violations.append(f"Key age exceeds maximum: {key_age} days")
        
        # Check key size
        key_size = int(key_info.metadata.get('length', 0))
        if key_size < self.security_policy.min_key_size:
            violations.append(f"Key size below minimum: {key_size}")
        
        # Check algorithm
        if key_info.algorithm not in self.security_policy.allowed_algorithms:
            violations.append(f"Unsupported algorithm: {key_info.algorithm}")
        
        # Check expiration
        if key_info.expiration_date:
            days_until_expiry = (key_info.expiration_date - datetime.now()).days
            if days_until_expiry < 30:
                violations.append(f"Key expires soon: {days_until_expiry} days")
        
        return violations
    
    async def _store_key_in_vault(self, key_info: GPGKeyInfo, key_data: str):
        """Store key in HashiCorp Vault"""
        if not self.vault_client:
            return
        
        try:
            # Store key data
            self.vault_client.secrets.kv.v2.create_or_update_secret(
                path=f"gpg-keys/{key_info.fingerprint}",
                secret={
                    'key_data': key_data,
                    'fingerprint': key_info.fingerprint,
                    'key_id': key_info.key_id,
                    'algorithm': key_info.algorithm,
                    'creation_date': key_info.creation_date.isoformat(),
                    'trust_level': key_info.trust_level.value,
                    'metadata': json.dumps(key_info.metadata)
                }
            )
            
            self.logger.info(f"Stored key in Vault: {key_info.fingerprint}")
            
        except Exception as e:
            self.logger.error(f"Failed to store key in Vault: {e}")
            raise
    
    async def _configure_apt_repository(self, repository: str, key_info: GPGKeyInfo):
        """Configure APT repository with GPG key"""
        try:
            # Export key to APT trusted keyring
            key_path = f"/etc/apt/trusted.gpg.d/{repository}.gpg"
            
            # Export key in binary format
            export_cmd = [
                'gpg', '--export', '--armor',
                key_info.fingerprint
            ]
            
            result = subprocess.run(export_cmd, capture_output=True, text=True)
            if result.returncode != 0:
                raise ValueError(f"Failed to export key: {result.stderr}")
            
            # Save to trusted keyring
            async with aiofiles.open(key_path, 'w') as f:
                await f.write(result.stdout)
            
            # Set permissions
            os.chmod(key_path, 0o644)
            
            self.logger.info(f"Configured APT repository: {repository}")
            
        except Exception as e:
            self.logger.error(f"Failed to configure APT repository: {e}")
            raise
    
    async def _log_to_transparency_log(self, repository: str, key_info: GPGKeyInfo):
        """Log key operation to transparency log"""
        log_entry = {
            'timestamp': datetime.utcnow().isoformat(),
            'operation': 'key_import',
            'repository': repository,
            'key_fingerprint': key_info.fingerprint,
            'key_id': key_info.key_id,
            'algorithm': key_info.algorithm,
            'trust_level': key_info.trust_level.value,
            'operator': os.getenv('USER', 'system')
        }
        
        # Log to append-only transparency log
        if self.config.get('transparency_log_enabled'):
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.config['transparency_log_url'],
                    json=log_entry,
                    headers={'X-API-Key': self.config.get('transparency_log_api_key')}
                ) as response:
                    if response.status != 200:
                        self.logger.warning(f"Failed to log to transparency log: {response.status}")
    
    def _cache_key_info(self, key_info: GPGKeyInfo):
        """Cache key information in Redis"""
        try:
            cache_key = f"gpg_key:{key_info.fingerprint}"
            cache_data = {
                'fingerprint': key_info.fingerprint,
                'key_id': key_info.key_id,
                'algorithm': key_info.algorithm,
                'creation_date': key_info.creation_date.isoformat(),
                'expiration_date': key_info.expiration_date.isoformat() if key_info.expiration_date else None,
                'trust_level': key_info.trust_level.value,
                'key_state': key_info.key_state.value
            }
            
            self.redis_client.setex(
                cache_key,
                timedelta(hours=24),
                json.dumps(cache_data)
            )
            
        except Exception as e:
            self.logger.warning(f"Failed to cache key info: {e}")
    
    async def rotate_repository_keys(self, repository: str) -> Dict[str, Any]:
        """Rotate GPG keys for repository"""
        self.logger.info(f"Starting key rotation for repository: {repository}")
        
        rotation_result = {
            'repository': repository,
            'timestamp': datetime.utcnow().isoformat(),
            'old_keys': [],
            'new_keys': [],
            'status': 'pending'
        }
        
        try:
            # Get current keys
            current_keys = await self._get_repository_keys(repository)
            rotation_result['old_keys'] = [k.fingerprint for k in current_keys]
            
            # Generate new key pair
            new_key = await self._generate_repository_key(repository)
            rotation_result['new_keys'].append(new_key.fingerprint)
            
            # Sign new key with old key for trust transition
            if current_keys:
                await self._cross_sign_keys(current_keys[0], new_key)
            
            # Update repository configuration
            await self._update_repository_config(repository, new_key)
            
            # Publish new key
            await self._publish_key_to_keyservers(new_key)
            
            # Schedule old key revocation
            for old_key in current_keys:
                await self._schedule_key_revocation(old_key, days=30)
            
            rotation_result['status'] = 'completed'
            
            # Log rotation event
            await self._log_key_rotation(rotation_result)
            
            self.logger.info(f"Key rotation completed for: {repository}")
            return rotation_result
            
        except Exception as e:
            self.logger.error(f"Key rotation failed: {e}")
            rotation_result['status'] = 'failed'
            rotation_result['error'] = str(e)
            raise
    
    async def _generate_repository_key(self, repository: str) -> GPGKeyInfo:
        """Generate new GPG key for repository"""
        key_params = {
            'key_type': 'RSA',
            'key_length': self.security_policy.min_key_size,
            'key_usage': 'sign',
            'expire_date': '2y',  # 2 years
            'name_real': f'{repository} Repository',
            'name_email': f'{repository}@{self.config["domain"]}',
            'name_comment': f'Repository signing key for {repository}'
        }
        
        # Generate key
        input_data = self.gpg.gen_key_input(**key_params)
        key = self.gpg.gen_key(input_data)
        
        if not key:
            raise ValueError("Failed to generate GPG key")
        
        # Get key info
        keys = self.gpg.list_keys(keys=str(key))
        if not keys:
            raise ValueError("Generated key not found")
        
        return self._parse_key_info(self.gpg.export_keys(str(key)))
    
    async def _cross_sign_keys(self, old_key: GPGKeyInfo, new_key: GPGKeyInfo):
        """Cross-sign keys for trust transition"""
        try:
            # Sign new key with old key
            self.gpg.sign_key(new_key.fingerprint, keyid=old_key.key_id)
            
            # Create transition certificate
            transition_cert = {
                'old_key': old_key.fingerprint,
                'new_key': new_key.fingerprint,
                'transition_date': datetime.utcnow().isoformat(),
                'validity_period': 30  # days
            }
            
            # Store transition certificate
            if self.vault_client:
                self.vault_client.secrets.kv.v2.create_or_update_secret(
                    path=f"key-transitions/{old_key.fingerprint}",
                    secret=transition_cert
                )
            
        except Exception as e:
            self.logger.error(f"Failed to cross-sign keys: {e}")
            raise
    
    async def validate_package_signatures(self, 
                                        package_path: str,
                                        repository: str) -> ValidationResult:
        """Validate package signatures against repository keys"""
        self.logger.info(f"Validating package: {package_path}")
        
        try:
            # Get repository keys
            repo_keys = await self._get_repository_keys(repository)
            if not repo_keys:
                return ValidationResult.FAILED
            
            # Check detached signature
            sig_path = f"{package_path}.sig"
            if not os.path.exists(sig_path):
                self.logger.warning("No signature file found")
                return ValidationResult.WARNING
            
            # Verify signature
            with open(sig_path, 'rb') as f:
                verified = self.gpg.verify_file(f, package_path)
            
            if not verified.valid:
                self.logger.error(f"Invalid signature: {verified.status}")
                self.validation_results.labels(
                    repository=repository,
                    result='invalid_signature'
                ).inc()
                return ValidationResult.FAILED
            
            # Check if signing key is trusted
            signing_key = verified.key_id
            trusted = False
            
            for key in repo_keys:
                if key.key_id == signing_key or signing_key in [sk['keyid'] for sk in key.subkeys]:
                    trusted = True
                    break
            
            if not trusted:
                self.logger.warning(f"Package signed by untrusted key: {signing_key}")
                return ValidationResult.WARNING
            
            # Validate package metadata
            metadata_valid = await self._validate_package_metadata(package_path)
            if not metadata_valid:
                return ValidationResult.WARNING
            
            # Check against security policy
            if self.security_policy.sbom_required:
                sbom_valid = await self._validate_sbom(package_path)
                if not sbom_valid:
                    return ValidationResult.WARNING
            
            self.validation_results.labels(
                repository=repository,
                result='success'
            ).inc()
            
            return ValidationResult.PASSED
            
        except Exception as e:
            self.logger.error(f"Package validation error: {e}")
            self.validation_results.labels(
                repository=repository,
                result='error'
            ).inc()
            return ValidationResult.FAILED
    
    async def _validate_package_metadata(self, package_path: str) -> bool:
        """Validate package metadata"""
        try:
            # Extract package metadata
            result = subprocess.run(
                ['dpkg-deb', '-I', package_path],
                capture_output=True,
                text=True
            )
            
            if result.returncode != 0:
                return False
            
            # Parse control file
            control_data = result.stdout
            
            # Validate required fields
            required_fields = ['Package', 'Version', 'Architecture', 'Maintainer']
            for field in required_fields:
                if field not in control_data:
                    self.logger.warning(f"Missing required field: {field}")
                    return False
            
            return True
            
        except Exception as e:
            self.logger.error(f"Metadata validation error: {e}")
            return False
    
    async def _validate_sbom(self, package_path: str) -> bool:
        """Validate Software Bill of Materials"""
        try:
            # Look for SBOM file
            sbom_path = f"{package_path}.sbom"
            if not os.path.exists(sbom_path):
                self.logger.warning("No SBOM file found")
                return False
            
            # Validate SBOM format and signature
            with open(sbom_path, 'r') as f:
                sbom_data = json.load(f)
            
            # Check SBOM version
            if sbom_data.get('bomFormat') != 'CycloneDX':
                self.logger.warning("Unsupported SBOM format")
                return False
            
            # Verify SBOM signature
            sbom_sig_path = f"{sbom_path}.sig"
            if os.path.exists(sbom_sig_path):
                with open(sbom_sig_path, 'rb') as f:
                    verified = self.gpg.verify_file(f, sbom_path)
                
                if not verified.valid:
                    self.logger.warning("Invalid SBOM signature")
                    return False
            
            return True
            
        except Exception as e:
            self.logger.error(f"SBOM validation error: {e}")
            return False
    
    async def monitor_key_health(self) -> Dict[str, Any]:
        """Monitor health of all managed keys"""
        health_report = {
            'timestamp': datetime.utcnow().isoformat(),
            'total_keys': 0,
            'healthy_keys': 0,
            'expiring_keys': [],
            'expired_keys': [],
            'weak_keys': [],
            'recommendations': []
        }
        
        try:
            # Get all keys
            keys = self.gpg.list_keys()
            health_report['total_keys'] = len(keys)
            
            for key in keys:
                key_info = self._parse_key_from_gpg(key)
                
                # Check expiration
                if key_info.expiration_date:
                    days_until_expiry = (key_info.expiration_date - datetime.now()).days
                    
                    if days_until_expiry < 0:
                        health_report['expired_keys'].append({
                            'fingerprint': key_info.fingerprint,
                            'expired_days_ago': abs(days_until_expiry)
                        })
                    elif days_until_expiry < 30:
                        health_report['expiring_keys'].append({
                            'fingerprint': key_info.fingerprint,
                            'days_until_expiry': days_until_expiry
                        })
                    else:
                        health_report['healthy_keys'] += 1
                    
                    # Update metrics
                    self.key_age.labels(fingerprint=key_info.fingerprint).set(
                        (datetime.now() - key_info.creation_date).days
                    )
                
                # Check key strength
                key_size = int(key_info.metadata.get('length', 0))
                if key_size < self.security_policy.min_key_size:
                    health_report['weak_keys'].append({
                        'fingerprint': key_info.fingerprint,
                        'key_size': key_size,
                        'recommended_size': self.security_policy.min_key_size
                    })
            
            # Generate recommendations
            if health_report['expiring_keys']:
                health_report['recommendations'].append(
                    f"Rotate {len(health_report['expiring_keys'])} expiring keys"
                )
            
            if health_report['expired_keys']:
                health_report['recommendations'].append(
                    f"Remove {len(health_report['expired_keys'])} expired keys"
                )
            
            if health_report['weak_keys']:
                health_report['recommendations'].append(
                    f"Upgrade {len(health_report['weak_keys'])} weak keys"
                )
            
            return health_report
            
        except Exception as e:
            self.logger.error(f"Key health monitoring error: {e}")
            health_report['error'] = str(e)
            return health_report


class EnterpriseRepositoryManager:
    """Enterprise Ubuntu repository management system"""
    
    def __init__(self, config_path: str):
        self.config = self._load_config(config_path)
        self.logger = self._setup_logging()
        self.key_manager = EnterpriseGPGKeyManager(config_path)
        self.apt_cache = apt.Cache()
        
    def _load_config(self, config_path: str) -> Dict[str, Any]:
        """Load configuration"""
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    
    def _setup_logging(self) -> logging.Logger:
        """Setup logging"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        return logger
    
    async def add_repository(self, 
                           repository_url: str,
                           components: List[str],
                           gpg_key_url: str,
                           distribution: str = None) -> Dict[str, Any]:
        """Add new repository with security validation"""
        self.logger.info(f"Adding repository: {repository_url}")
        
        result = {
            'repository': repository_url,
            'status': 'pending',
            'timestamp': datetime.utcnow().isoformat()
        }
        
        try:
            # Import GPG key
            key_info = await self.key_manager.import_repository_key(
                repository_url,
                gpg_key_url
            )
            result['key_fingerprint'] = key_info.fingerprint
            
            # Detect distribution if not provided
            if not distribution:
                distribution = self._detect_distribution()
            
            # Create sources.list entry
            repo_name = self._generate_repo_name(repository_url)
            sources_path = f"/etc/apt/sources.list.d/{repo_name}.list"
            
            # Build repository line
            repo_line = f"deb [signed-by=/etc/apt/trusted.gpg.d/{repo_name}.gpg] {repository_url} {distribution} {' '.join(components)}"
            
            # Write sources.list file
            async with aiofiles.open(sources_path, 'w') as f:
                await f.write(f"# {repo_name} repository\n")
                await f.write(f"# Added: {datetime.now().isoformat()}\n")
                await f.write(f"# Key: {key_info.fingerprint}\n")
                await f.write(repo_line + "\n")
            
            # Update package cache
            await self._update_package_cache()
            
            # Validate repository
            validation_result = await self._validate_repository(repository_url)
            result['validation'] = validation_result
            
            result['status'] = 'success'
            self.logger.info(f"Successfully added repository: {repository_url}")
            
            return result
            
        except Exception as e:
            self.logger.error(f"Failed to add repository: {e}")
            result['status'] = 'failed'
            result['error'] = str(e)
            raise
    
    def _detect_distribution(self) -> str:
        """Detect Ubuntu distribution codename"""
        try:
            with open('/etc/os-release', 'r') as f:
                for line in f:
                    if line.startswith('VERSION_CODENAME='):
                        return line.split('=')[1].strip().strip('"')
        except:
            pass
        
        # Fallback to lsb_release
        try:
            result = subprocess.run(
                ['lsb_release', '-cs'],
                capture_output=True,
                text=True
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except:
            pass
        
        raise ValueError("Could not detect distribution")
    
    def _generate_repo_name(self, repository_url: str) -> str:
        """Generate safe repository name from URL"""
        import re
        from urllib.parse import urlparse
        
        parsed = urlparse(repository_url)
        name = parsed.hostname or 'unknown'
        name = re.sub(r'[^a-zA-Z0-9-]', '-', name)
        
        return name
    
    async def _update_package_cache(self):
        """Update APT package cache"""
        self.logger.info("Updating package cache")
        
        result = subprocess.run(
            ['apt-get', 'update'],
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            self.logger.error(f"Package cache update failed: {result.stderr}")
            raise ValueError("Failed to update package cache")
    
    async def _validate_repository(self, repository_url: str) -> Dict[str, Any]:
        """Validate repository configuration"""
        validation = {
            'repository': repository_url,
            'checks': [],
            'passed': True
        }
        
        # Check repository accessibility
        check_result = await self._check_repository_accessible(repository_url)
        validation['checks'].append(check_result)
        if not check_result['passed']:
            validation['passed'] = False
        
        # Check package signatures
        check_result = await self._check_package_signatures(repository_url)
        validation['checks'].append(check_result)
        if not check_result['passed']:
            validation['passed'] = False
        
        # Check repository metadata
        check_result = await self._check_repository_metadata(repository_url)
        validation['checks'].append(check_result)
        if not check_result['passed']:
            validation['passed'] = False
        
        return validation
    
    async def _check_repository_accessible(self, repository_url: str) -> Dict[str, Any]:
        """Check if repository is accessible"""
        check = {
            'name': 'repository_accessible',
            'passed': False
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                # Check Release file
                release_url = f"{repository_url}/dists/{self._detect_distribution()}/Release"
                async with session.get(release_url, timeout=10) as response:
                    if response.status == 200:
                        check['passed'] = True
                    else:
                        check['error'] = f"HTTP {response.status}"
        except Exception as e:
            check['error'] = str(e)
        
        return check
    
    async def _check_package_signatures(self, repository_url: str) -> Dict[str, Any]:
        """Check package signature configuration"""
        check = {
            'name': 'package_signatures',
            'passed': False
        }
        
        try:
            # Check if Release.gpg exists
            async with aiohttp.ClientSession() as session:
                release_gpg_url = f"{repository_url}/dists/{self._detect_distribution()}/Release.gpg"
                async with session.get(release_gpg_url, timeout=10) as response:
                    if response.status == 200:
                        check['passed'] = True
                    else:
                        check['error'] = "No Release.gpg file"
        except Exception as e:
            check['error'] = str(e)
        
        return check
    
    async def _check_repository_metadata(self, repository_url: str) -> Dict[str, Any]:
        """Check repository metadata"""
        check = {
            'name': 'repository_metadata',
            'passed': False
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                # Download Release file
                release_url = f"{repository_url}/dists/{self._detect_distribution()}/Release"
                async with session.get(release_url, timeout=10) as response:
                    if response.status == 200:
                        content = await response.text()
                        
                        # Check required fields
                        required_fields = ['Origin', 'Label', 'Suite', 'Codename', 'Components', 'Architectures']
                        missing_fields = []
                        
                        for field in required_fields:
                            if f"{field}:" not in content:
                                missing_fields.append(field)
                        
                        if not missing_fields:
                            check['passed'] = True
                        else:
                            check['error'] = f"Missing fields: {', '.join(missing_fields)}"
                    else:
                        check['error'] = f"HTTP {response.status}"
        except Exception as e:
            check['error'] = str(e)
        
        return check


async def main():
    """Main execution function"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise GPG Key Management')
    parser.add_argument('--config', default='/etc/gpg-manager/config.yaml',
                       help='Configuration file path')
    parser.add_argument('--action', required=True,
                       choices=['add-repo', 'import-key', 'rotate-keys', 'validate', 'monitor'],
                       help='Action to perform')
    parser.add_argument('--repository', help='Repository URL')
    parser.add_argument('--key-url', help='GPG key URL')
    parser.add_argument('--components', nargs='+', default=['main'],
                       help='Repository components')
    parser.add_argument('--package', help='Package file to validate')
    
    args = parser.parse_args()
    
    # Initialize managers
    repo_manager = EnterpriseRepositoryManager(args.config)
    key_manager = repo_manager.key_manager
    
    if args.action == 'add-repo':
        if not args.repository or not args.key_url:
            parser.error('Repository and key URL required for add-repo')
        
        result = await repo_manager.add_repository(
            args.repository,
            args.components,
            args.key_url
        )
        print(json.dumps(result, indent=2))
    
    elif args.action == 'import-key':
        if not args.key_url:
            parser.error('Key URL required for import-key')
        
        key_info = await key_manager.import_repository_key(
            args.repository or 'default',
            args.key_url
        )
        print(f"Imported key: {key_info.fingerprint}")
    
    elif args.action == 'rotate-keys':
        if not args.repository:
            parser.error('Repository required for rotate-keys')
        
        result = await key_manager.rotate_repository_keys(args.repository)
        print(json.dumps(result, indent=2))
    
    elif args.action == 'validate':
        if not args.package or not args.repository:
            parser.error('Package and repository required for validate')
        
        result = await key_manager.validate_package_signatures(
            args.package,
            args.repository
        )
        print(f"Validation result: {result.value}")
    
    elif args.action == 'monitor':
        health = await key_manager.monitor_key_health()
        print(json.dumps(health, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
```

# [Repository Security Implementation](#repository-security-implementation)

## Production GPG Key Management

### Enterprise Key Rotation System

```bash
#!/bin/bash
# Enterprise GPG Key Rotation and Management Script

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-/etc/gpg-manager/config.yaml}"
LOG_DIR="/var/log/gpg-manager"
STATE_DIR="/var/lib/gpg-manager"
BACKUP_DIR="/var/backups/gpg-keys"

# Logging setup
mkdir -p "$LOG_DIR" "$STATE_DIR" "$BACKUP_DIR"
LOG_FILE="$LOG_DIR/key-rotation-$(date +%Y%m%d-%H%M%S).log"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG_FILE" >&2
}

# Key management functions
generate_repository_key() {
    local repo_name="$1"
    local key_type="${2:-RSA}"
    local key_length="${3:-4096}"
    
    log "Generating new $key_type key for repository: $repo_name"
    
    # Create key generation template
    cat > "$STATE_DIR/key-gen-template.txt" <<EOF
%echo Generating repository key
Key-Type: $key_type
Key-Length: $key_length
Subkey-Type: $key_type
Subkey-Length: $key_length
Name-Real: $repo_name Repository
Name-Email: $repo_name@$(hostname -d)
Expire-Date: 2y
%no-protection
%commit
%echo done
EOF
    
    # Generate key
    gpg --batch --generate-key "$STATE_DIR/key-gen-template.txt" 2>&1 | tee -a "$LOG_FILE"
    
    # Get fingerprint of newly created key
    local fingerprint=$(gpg --list-secret-keys --with-colons "$repo_name@$(hostname -d)" | \
                       grep '^fpr' | head -1 | cut -d: -f10)
    
    if [[ -z "$fingerprint" ]]; then
        error "Failed to generate key for $repo_name"
        return 1
    fi
    
    log "Generated key with fingerprint: $fingerprint"
    echo "$fingerprint"
}

export_repository_key() {
    local fingerprint="$1"
    local output_file="$2"
    
    log "Exporting public key: $fingerprint"
    
    # Export public key
    gpg --armor --export "$fingerprint" > "$output_file"
    
    # Export to APT keyring format
    gpg --export "$fingerprint" > "${output_file%.asc}.gpg"
    
    log "Exported key to: $output_file"
}

sign_repository_metadata() {
    local repo_path="$1"
    local key_fingerprint="$2"
    
    log "Signing repository metadata with key: $key_fingerprint"
    
    # Find Release files
    find "$repo_path" -name "Release" -type f | while read -r release_file; do
        log "Signing: $release_file"
        
        # Clear sign Release file
        gpg --default-key "$key_fingerprint" \
            --clearsign \
            --output "${release_file}.gpg" \
            "$release_file"
        
        # Create detached signature
        gpg --default-key "$key_fingerprint" \
            --detach-sign \
            --armor \
            --output "${release_file}.asc" \
            "$release_file"
    done
}

rotate_repository_keys() {
    local repo_name="$1"
    
    log "Starting key rotation for repository: $repo_name"
    
    # Backup current keys
    backup_current_keys "$repo_name"
    
    # Generate new key
    local new_fingerprint=$(generate_repository_key "$repo_name")
    
    if [[ -z "$new_fingerprint" ]]; then
        error "Key generation failed"
        return 1
    fi
    
    # Export new public key
    export_repository_key "$new_fingerprint" \
        "/etc/apt/trusted.gpg.d/${repo_name}-new.asc"
    
    # Cross-sign with old key
    cross_sign_keys "$repo_name" "$new_fingerprint"
    
    # Update repository configuration
    update_repository_config "$repo_name" "$new_fingerprint"
    
    # Schedule old key removal
    schedule_key_removal "$repo_name"
    
    log "Key rotation completed for: $repo_name"
}

backup_current_keys() {
    local repo_name="$1"
    local backup_date=$(date +%Y%m%d-%H%M%S)
    local backup_path="$BACKUP_DIR/${repo_name}-${backup_date}"
    
    log "Backing up current keys to: $backup_path"
    
    mkdir -p "$backup_path"
    
    # Export all keys for repository
    gpg --export-secret-keys --armor "$repo_name@$(hostname -d)" \
        > "$backup_path/secret-keys.asc"
    
    gpg --export --armor "$repo_name@$(hostname -d)" \
        > "$backup_path/public-keys.asc"
    
    # Backup trust database
    gpg --export-ownertrust > "$backup_path/trustdb.txt"
    
    # Create encrypted archive
    tar -czf - -C "$backup_path" . | \
        gpg --symmetric --cipher-algo AES256 \
        > "$backup_path.tar.gz.gpg"
    
    rm -rf "$backup_path"
    
    log "Backup completed: $backup_path.tar.gz.gpg"
}

cross_sign_keys() {
    local repo_name="$1"
    local new_fingerprint="$2"
    
    log "Cross-signing keys for trust transition"
    
    # Find current key
    local current_fingerprint=$(gpg --list-secret-keys --with-colons \
        "$repo_name@$(hostname -d)" | \
        grep '^fpr' | head -1 | cut -d: -f10)
    
    if [[ -n "$current_fingerprint" ]] && [[ "$current_fingerprint" != "$new_fingerprint" ]]; then
        # Sign new key with current key
        gpg --default-key "$current_fingerprint" \
            --sign-key "$new_fingerprint"
        
        # Create transition statement
        cat > "$STATE_DIR/key-transition-${repo_name}.txt" <<EOF
Repository: $repo_name
Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
Old Key: $current_fingerprint
New Key: $new_fingerprint

This is to certify that the repository signing key for $repo_name
is transitioning from the old key to the new key listed above.
Both keys should be trusted during the transition period.

Transition period: 30 days
EOF
        
        # Sign transition statement
        gpg --default-key "$current_fingerprint" \
            --clearsign \
            --output "$STATE_DIR/key-transition-${repo_name}.txt.asc" \
            "$STATE_DIR/key-transition-${repo_name}.txt"
        
        log "Created key transition statement"
    fi
}

update_repository_config() {
    local repo_name="$1"
    local new_fingerprint="$2"
    
    log "Updating repository configuration"
    
    # Update sources.list files
    find /etc/apt/sources.list.d -name "*${repo_name}*" -type f | \
    while read -r source_file; do
        if grep -q "signed-by=" "$source_file"; then
            # Update signed-by parameter
            sed -i "s|signed-by=[^ ]*|signed-by=/etc/apt/trusted.gpg.d/${repo_name}.gpg|g" \
                "$source_file"
        fi
    done
    
    # Install new key
    mv "/etc/apt/trusted.gpg.d/${repo_name}-new.asc" \
       "/etc/apt/trusted.gpg.d/${repo_name}.asc"
    
    mv "/etc/apt/trusted.gpg.d/${repo_name}-new.gpg" \
       "/etc/apt/trusted.gpg.d/${repo_name}.gpg"
    
    log "Repository configuration updated"
}

schedule_key_removal() {
    local repo_name="$1"
    local removal_date=$(date -d "+30 days" +%Y-%m-%d)
    
    log "Scheduling old key removal for: $removal_date"
    
    # Create systemd timer for key removal
    cat > "/etc/systemd/system/gpg-key-removal-${repo_name}.service" <<EOF
[Unit]
Description=Remove old GPG key for $repo_name repository
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/remove-old-gpg-key.sh $repo_name
StandardOutput=journal
StandardError=journal
EOF
    
    cat > "/etc/systemd/system/gpg-key-removal-${repo_name}.timer" <<EOF
[Unit]
Description=Timer for old GPG key removal for $repo_name
Requires=gpg-key-removal-${repo_name}.service

[Timer]
OnCalendar=$removal_date 00:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    
    systemctl daemon-reload
    systemctl enable "gpg-key-removal-${repo_name}.timer"
    systemctl start "gpg-key-removal-${repo_name}.timer"
    
    log "Removal timer scheduled"
}

validate_repository_signatures() {
    local repo_url="$1"
    
    log "Validating repository signatures for: $repo_url"
    
    # Download Release and Release.gpg
    local temp_dir=$(mktemp -d)
    trap "rm -rf $temp_dir" EXIT
    
    # Parse repository URL
    local dist=$(lsb_release -cs)
    
    # Download files
    wget -q -O "$temp_dir/Release" "$repo_url/dists/$dist/Release" || {
        error "Failed to download Release file"
        return 1
    }
    
    wget -q -O "$temp_dir/Release.gpg" "$repo_url/dists/$dist/Release.gpg" || {
        error "Failed to download Release.gpg file"
        return 1
    }
    
    # Verify signature
    gpg --verify "$temp_dir/Release.gpg" "$temp_dir/Release" 2>&1 | tee -a "$LOG_FILE"
    
    if [[ ${PIPESTATUS[0]} -eq 0 ]]; then
        log "Repository signature valid"
        return 0
    else
        error "Repository signature invalid"
        return 1
    fi
}

monitor_key_expiration() {
    log "Monitoring GPG key expiration"
    
    local warning_days=30
    local critical_days=7
    
    gpg --list-keys --with-colons | grep '^pub' | while IFS=: read -r \
        type trust length algo keyid date expires uid rest; do
        
        if [[ -n "$expires" ]]; then
            local expiry_date=$(date -d "@$expires" +%Y-%m-%d)
            local days_until_expiry=$(( (expires - $(date +%s)) / 86400 ))
            
            if [[ $days_until_expiry -lt 0 ]]; then
                error "Key $keyid has expired on $expiry_date"
            elif [[ $days_until_expiry -lt $critical_days ]]; then
                error "Key $keyid expires in $days_until_expiry days (Critical)"
            elif [[ $days_until_expiry -lt $warning_days ]]; then
                log "Key $keyid expires in $days_until_expiry days (Warning)"
            fi
        fi
    done
}

# Main execution
main() {
    local action="${1:-help}"
    
    case "$action" in
        generate)
            generate_repository_key "${2:-default}" "${3:-RSA}" "${4:-4096}"
            ;;
        rotate)
            rotate_repository_keys "${2:-default}"
            ;;
        validate)
            validate_repository_signatures "${2}"
            ;;
        monitor)
            monitor_key_expiration
            ;;
        backup)
            backup_current_keys "${2:-all}"
            ;;
        help|*)
            cat <<EOF
Usage: $0 <action> [arguments]

Actions:
  generate <repo> [type] [size]  - Generate new repository key
  rotate <repo>                  - Rotate repository keys
  validate <repo-url>            - Validate repository signatures
  monitor                        - Monitor key expiration
  backup <repo>                  - Backup repository keys
  help                          - Show this help message

Examples:
  $0 generate myrepo RSA 4096
  $0 rotate myrepo
  $0 validate https://repo.example.com/ubuntu
  $0 monitor
EOF
            ;;
    esac
}

# Execute main function
main "$@"
```

## Advanced Repository Security Monitoring

### Security Event Detection System

```python
#!/usr/bin/env python3
"""
Repository Security Event Detection and Response System
"""

import asyncio
import json
import logging
from datetime import datetime
from typing import Dict, List, Optional
import aiohttp
from elasticsearch import AsyncElasticsearch
import yaml

class SecurityEventDetector:
    """Detect and respond to repository security events"""
    
    def __init__(self, config_path: str):
        self.config = self._load_config(config_path)
        self.logger = self._setup_logging()
        self.es_client = AsyncElasticsearch(
            self.config['elasticsearch']['hosts']
        )
        self.alert_handlers = self._setup_alert_handlers()
        
    async def monitor_repository_events(self):
        """Monitor repository security events"""
        while True:
            try:
                # Check for suspicious activities
                await self._check_key_anomalies()
                await self._check_signature_failures()
                await self._check_unauthorized_access()
                await self._check_package_tampering()
                
                # Sleep before next check
                await asyncio.sleep(60)
                
            except Exception as e:
                self.logger.error(f"Monitoring error: {e}")
                await asyncio.sleep(300)  # Back off on error
    
    async def _check_key_anomalies(self):
        """Check for GPG key anomalies"""
        query = {
            "query": {
                "bool": {
                    "must": [
                        {"range": {"@timestamp": {"gte": "now-5m"}}},
                        {"term": {"event.category": "gpg_key"}},
                        {"terms": {"event.outcome": ["failure", "unknown"]}}
                    ]
                }
            },
            "aggs": {
                "by_key": {
                    "terms": {
                        "field": "gpg.key.fingerprint",
                        "size": 10
                    }
                }
            }
        }
        
        result = await self.es_client.search(index="security-*", body=query)
        
        # Check for anomalies
        for bucket in result['aggregations']['by_key']['buckets']:
            if bucket['doc_count'] > self.config['thresholds']['key_failures']:
                await self._raise_alert({
                    'type': 'key_anomaly',
                    'severity': 'high',
                    'key_fingerprint': bucket['key'],
                    'failure_count': bucket['doc_count'],
                    'message': f"Multiple key failures detected for {bucket['key']}"
                })
    
    async def _check_signature_failures(self):
        """Check for package signature verification failures"""
        query = {
            "query": {
                "bool": {
                    "must": [
                        {"range": {"@timestamp": {"gte": "now-15m"}}},
                        {"term": {"event.action": "signature_verification"}},
                        {"term": {"event.outcome": "failure"}}
                    ]
                }
            },
            "aggs": {
                "by_repository": {
                    "terms": {
                        "field": "repository.name",
                        "size": 10
                    }
                }
            }
        }
        
        result = await self.es_client.search(index="security-*", body=query)
        
        for bucket in result['aggregations']['by_repository']['buckets']:
            if bucket['doc_count'] > self.config['thresholds']['signature_failures']:
                await self._raise_alert({
                    'type': 'signature_failure',
                    'severity': 'critical',
                    'repository': bucket['key'],
                    'failure_count': bucket['doc_count'],
                    'message': f"Multiple signature failures for repository {bucket['key']}"
                })
    
    async def _raise_alert(self, alert: Dict[str, Any]):
        """Raise security alert"""
        alert['timestamp'] = datetime.utcnow().isoformat()
        
        self.logger.warning(f"Security alert: {alert}")
        
        # Send to all configured handlers
        for handler in self.alert_handlers:
            try:
                await handler.send_alert(alert)
            except Exception as e:
                self.logger.error(f"Alert handler error: {e}")


# Example configuration file (config.yaml):
"""
# GPG Key Manager Configuration
domain: example.com
gpg_home: /var/lib/apt/gpg

# Security Policy
security_policy:
  min_key_size: 4096
  allowed_algorithms:
    - RSA
    - Ed25519
  max_key_age_days: 365
  require_key_rotation: true
  require_hardware_keys: false
  trust_chain_depth: 3
  require_transparency_log: true
  sbom_required: true

# Vault Configuration
vault_enabled: true
vault_url: https://vault.example.com:8200
vault_token: ${VAULT_TOKEN}

# Azure Key Vault
azure_kv_enabled: false
azure_kv_url: https://keyvault.vault.azure.net/

# Redis Cache
redis_host: localhost
redis_port: 6379

# Transparency Log
transparency_log_enabled: true
transparency_log_url: https://transparency.example.com/api/v1/log
transparency_log_api_key: ${TRANSPARENCY_API_KEY}

# Monitoring
syslog_server: syslog.example.com
elasticsearch:
  hosts:
    - https://elastic.example.com:9200

# Alert Thresholds
thresholds:
  key_failures: 5
  signature_failures: 3
  unauthorized_access: 10
  package_tampering: 1

# Repository defaults
repositories:
  - name: internal
    url: https://repo.example.com/ubuntu
    components: [main, restricted, universe, multiverse]
    trust_level: enterprise
  
  - name: external
    url: https://external.example.com/ubuntu
    components: [main]
    trust_level: verified
"""
```

# [Enterprise Repository Security Best Practices](#enterprise-repository-security-best-practices)

## Security Implementation Checklist

### 1. Key Management
- [ ] Use hardware security modules (HSM) for critical keys
- [ ] Implement automated key rotation every 90-365 days
- [ ] Maintain secure key backup and recovery procedures
- [ ] Use key escrow for business continuity
- [ ] Implement split knowledge and dual control

### 2. Repository Hardening
- [ ] Enable HTTPS for all repository access
- [ ] Implement IP whitelisting for sensitive repositories
- [ ] Use repository mirroring for availability
- [ ] Enable access logging and monitoring
- [ ] Implement rate limiting and DDoS protection

### 3. Package Validation
- [ ] Verify all package signatures before installation
- [ ] Implement SBOM (Software Bill of Materials) validation
- [ ] Use reproducible builds where possible
- [ ] Scan packages for known vulnerabilities
- [ ] Implement supply chain attestation

### 4. Monitoring and Alerting
- [ ] Monitor key expiration and rotation
- [ ] Track signature verification failures
- [ ] Alert on unauthorized repository access
- [ ] Monitor for package tampering
- [ ] Implement security event correlation

### 5. Compliance and Audit
- [ ] Maintain audit logs for all key operations
- [ ] Implement transparency logging
- [ ] Document key custody chain
- [ ] Regular security assessments
- [ ] Compliance reporting automation

## Troubleshooting Common Issues

### GPG Key Errors

```bash
# Fix "NO_PUBKEY" errors
sudo apt-key adv --keyserver keyserver.ubuntu.com --recv-keys <KEY_ID>

# Convert old apt-key to trusted.gpg.d
apt-key export <KEY_ID> | sudo gpg --dearmour -o /etc/apt/trusted.gpg.d/repo-name.gpg

# Debug signature verification
apt-get update -o Debug::Acquire::gpgv=true

# List all trusted keys
apt-key list

# Remove deprecated keys
sudo apt-key del <KEY_ID>
```

### Repository Configuration Issues

```bash
# Test repository configuration
apt-get update --print-uris

# Verify repository signatures manually
gpgv --keyring /etc/apt/trusted.gpg.d/repo.gpg Release.gpg Release

# Check APT security settings
apt-config dump | grep -i secure

# Force signature verification
echo 'Acquire::AllowInsecureRepositories "false";' | sudo tee /etc/apt/apt.conf.d/99security
```

## Conclusion

Enterprise Ubuntu repository GPG key management requires comprehensive security frameworks that encompass key lifecycle management, automated trust validation, and robust monitoring systems. By implementing these advanced security architectures and automation tools, organizations can maintain package integrity, ensure supply chain security, and meet compliance requirements while scaling across thousands of systems.

The combination of hardware security modules, automated key rotation, transparency logging, and continuous security monitoring provides the foundation for zero-trust repository management in modern enterprise environments. These implementations ensure that package distribution remains secure, auditable, and resilient against sophisticated supply chain attacks.