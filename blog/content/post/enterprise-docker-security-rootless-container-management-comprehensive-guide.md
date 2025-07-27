---
title: "Enterprise Docker Security and Rootless Container Management: Comprehensive Guide to Zero-Privilege Container Operations"
date: 2025-08-12T10:00:00-05:00
draft: false
tags: ["Docker", "Container Security", "Rootless Containers", "Zero Trust", "Enterprise Security", "DevSecOps", "Access Control", "Kubernetes", "Podman", "Container Runtime"]
categories:
- Container Security
- Enterprise Infrastructure
- DevSecOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to Docker security frameworks, rootless container implementations, zero-privilege operations, comprehensive access management, and production-grade container security architectures"
more_link: "yes"
url: "/enterprise-docker-security-rootless-container-management-comprehensive-guide/"
---

Enterprise container environments require sophisticated security frameworks that eliminate root privileges, implement zero-trust principles, and provide comprehensive access controls while maintaining operational efficiency and developer productivity. This guide covers advanced Docker security architectures, rootless container implementations, enterprise access management systems, and production-grade security frameworks for mission-critical containerized applications.

<!--more-->

# [Enterprise Container Security Architecture](#enterprise-container-security-architecture)

## Zero-Privilege Container Framework

Enterprise container security demands comprehensive approaches that eliminate root privileges, implement user namespace isolation, enforce least-privilege principles, and provide complete audit trails across the entire container lifecycle while maintaining performance and operational simplicity.

### Enterprise Container Security Overview

```
┌─────────────────────────────────────────────────────────────────┐
│           Enterprise Container Security Architecture            │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│  Runtime Layer  │  Access Layer   │  Network Layer  │ Audit     │
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ Rootless    │ │ │ RBAC/ABAC   │ │ │ Zero Trust  │ │ │ Logs  │ │
│ │ User NS     │ │ │ LDAP/OIDC   │ │ │ Micro-seg   │ │ │ Audit │ │
│ │ SecComp     │ │ │ MFA/SSO     │ │ │ Service Mesh│ │ │ Trace │ │
│ │ AppArmor    │ │ │ Policy Eng  │ │ │ Encryption  │ │ │ Alert │ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • No root       │ • Fine-grained  │ • mTLS          │ • Complete│
│ • Isolated      │ • Dynamic       │ • Network pol   │ • Real-time│
│ • Sandboxed     │ • Contextual    │ • Zero-trust    │ • Tamper-proof│
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Container Security Maturity Model

| Level | Privilege Model | Access Control | Network Security | Compliance |
|-------|-----------------|----------------|------------------|------------|
| **Basic** | Root containers | Docker group | Host networking | Basic logs |
| **Managed** | Non-root user | User groups | Bridge networks | Centralized logs |
| **Advanced** | User namespaces | RBAC policies | Network policies | Real-time audit |
| **Enterprise** | Rootless runtime | Zero-trust ABAC | Service mesh | Full compliance |

## Advanced Docker Security Framework

### Enterprise Rootless Container System

```python
#!/usr/bin/env python3
"""
Enterprise Docker Security and Rootless Container Management Framework
"""

import os
import sys
import json
import yaml
import logging
import asyncio
import subprocess
import tempfile
from typing import Dict, List, Optional, Tuple, Any, Union, Set
from dataclasses import dataclass, asdict, field
from pathlib import Path
from enum import Enum
from datetime import datetime, timedelta
import docker
import podman
import kubernetes
from kubernetes import client, config
import ldap3
import jwt
from cryptography.fernet import Fernet
import redis
from prometheus_client import Counter, Gauge, Histogram
import aiohttp
from sqlalchemy import create_engine, Column, String, DateTime, Boolean, Integer, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

Base = declarative_base()

class ContainerRuntime(Enum):
    DOCKER_ROOTLESS = "docker_rootless"
    PODMAN = "podman"
    CONTAINERD = "containerd"
    CRIO = "crio"
    DOCKER_ROOTFUL = "docker_rootful"

class AccessLevel(Enum):
    READ_ONLY = "read_only"
    DEVELOPER = "developer"
    ADMIN = "admin"
    CLUSTER_ADMIN = "cluster_admin"

class SecurityLevel(Enum):
    MINIMAL = "minimal"
    STANDARD = "standard"
    HARDENED = "hardened"
    FIPS = "fips"

@dataclass
class ContainerSecurityPolicy:
    """Container security policy configuration"""
    policy_name: str
    runtime: ContainerRuntime
    allow_privileged: bool = False
    allow_host_network: bool = False
    allow_host_pid: bool = False
    allow_host_ipc: bool = False
    allowed_capabilities: List[str] = field(default_factory=list)
    forbidden_syscalls: List[str] = field(default_factory=list)
    required_seccomp_profile: Optional[str] = None
    required_apparmor_profile: Optional[str] = None
    required_selinux_context: Optional[str] = None
    max_memory: Optional[str] = None
    max_cpu: Optional[str] = None
    read_only_root_filesystem: bool = True
    run_as_non_root: bool = True
    user_namespace_required: bool = True
    network_policies: List[str] = field(default_factory=list)
    image_scanning_required: bool = True
    image_signature_required: bool = True
    allowed_registries: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class UserAccess:
    """User access configuration"""
    username: str
    access_level: AccessLevel
    allowed_namespaces: List[str] = field(default_factory=list)
    allowed_images: List[str] = field(default_factory=list)
    resource_quotas: Dict[str, str] = field(default_factory=dict)
    expires_at: Optional[datetime] = None
    mfa_required: bool = True
    source_ip_restrictions: List[str] = field(default_factory=list)
    time_restrictions: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class ContainerAuditEvent:
    """Container operation audit event"""
    timestamp: datetime
    user: str
    action: str
    container_id: Optional[str] = None
    image: Optional[str] = None
    command: List[str] = field(default_factory=list)
    environment: Dict[str, str] = field(default_factory=dict)
    volumes: List[str] = field(default_factory=list)
    network_mode: Optional[str] = None
    privileged: bool = False
    capabilities: List[str] = field(default_factory=list)
    exit_code: Optional[int] = None
    duration: Optional[float] = None
    risk_score: int = 0
    policy_violations: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

class ContainerAccessDB(Base):
    """Database model for container access"""
    __tablename__ = 'container_access'
    
    access_id = Column(String, primary_key=True)
    username = Column(String, index=True)
    access_level = Column(String)
    allowed_namespaces = Column(JSON)
    allowed_images = Column(JSON)
    resource_quotas = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
    mfa_required = Column(Boolean, default=True)
    active = Column(Boolean, default=True)
    metadata = Column(JSON)

class EnterpriseDockerSecurityManager:
    """Enterprise Docker security and access management system"""
    
    def __init__(self, config_path: str):
        self.config = self._load_config(config_path)
        self.logger = self._setup_logging()
        self.db_engine = create_engine(self.config['database_url'])
        Base.metadata.create_all(self.db_engine)
        self.db_session = sessionmaker(bind=self.db_engine)
        self.redis_client = self._init_redis()
        self.ldap_conn = self._init_ldap()
        
        # Initialize container clients
        self.docker_client = self._init_docker_client()
        self.k8s_client = self._init_k8s_client()
        
        # Metrics
        self.container_operations = Counter('container_operations_total',
                                          'Total container operations',
                                          ['user', 'action', 'runtime'])
        self.security_violations = Counter('container_security_violations_total',
                                         'Security policy violations',
                                         ['policy', 'severity'])
        self.active_containers = Gauge('active_containers_by_user',
                                     'Active containers by user',
                                     ['user', 'namespace'])
        self.container_lifecycle = Histogram('container_lifecycle_seconds',
                                           'Container lifecycle duration',
                                           ['action'])
        
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
            '/var/log/docker-security/docker-security.log',
            maxBytes=100*1024*1024,  # 100MB
            backupCount=20
        )
        file_handler.setLevel(logging.DEBUG)
        
        # Security event handler
        security_handler = RotatingFileHandler(
            '/var/log/docker-security/security-events.log',
            maxBytes=100*1024*1024,
            backupCount=50
        )
        security_handler.setLevel(logging.WARNING)
        
        # Formatter
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - [%(user)s] %(message)s'
        )
        
        for handler in [console_handler, file_handler, security_handler]:
            handler.setFormatter(formatter)
            logger.addHandler(handler)
        
        return logger
    
    def _init_redis(self) -> redis.Redis:
        """Initialize Redis client"""
        return redis.Redis(
            host=self.config.get('redis_host', 'localhost'),
            port=self.config.get('redis_port', 6379),
            password=self.config.get('redis_password'),
            decode_responses=True,
            ssl=self.config.get('redis_ssl', True)
        )
    
    def _init_ldap(self) -> Optional[ldap3.Connection]:
        """Initialize LDAP connection"""
        if not self.config.get('ldap_enabled', True):
            return None
        
        try:
            server = ldap3.Server(
                self.config['ldap_server'],
                port=self.config.get('ldap_port', 636),
                use_ssl=True
            )
            
            conn = ldap3.Connection(
                server,
                user=self.config.get('ldap_bind_dn'),
                password=self.config.get('ldap_bind_password'),
                auto_bind=True
            )
            
            return conn
            
        except Exception as e:
            self.logger.error(f"Failed to initialize LDAP: {e}")
            return None
    
    def _init_docker_client(self) -> Optional[docker.DockerClient]:
        """Initialize Docker client"""
        try:
            # Try rootless Docker first
            if self.config.get('prefer_rootless', True):
                docker_host = f"unix://{os.path.expanduser('~')}/.docker/desktop/docker.sock"
                if os.path.exists(docker_host.replace('unix://', '')):
                    return docker.DockerClient(base_url=docker_host)
            
            # Fallback to system Docker
            return docker.from_env()
            
        except Exception as e:
            self.logger.error(f"Failed to initialize Docker client: {e}")
            return None
    
    def _init_k8s_client(self) -> Optional[kubernetes.client.ApiClient]:
        """Initialize Kubernetes client"""
        try:
            # Try in-cluster config first
            try:
                config.load_incluster_config()
            except:
                # Fallback to kubeconfig
                config.load_kube_config()
            
            return client.ApiClient()
            
        except Exception as e:
            self.logger.error(f"Failed to initialize Kubernetes client: {e}")
            return None
    
    async def setup_rootless_docker(self, username: str) -> Dict[str, Any]:
        """Setup rootless Docker for user"""
        self.logger.info(f"Setting up rootless Docker for user: {username}")
        
        result = {
            'username': username,
            'status': 'pending',
            'timestamp': datetime.now().isoformat()
        }
        
        try:
            # Check if user exists
            import pwd
            try:
                user_info = pwd.getpwnam(username)
            except KeyError:
                result['status'] = 'failed'
                result['error'] = f"User {username} not found"
                return result
            
            # Setup user namespace mapping
            await self._setup_user_namespaces(username, user_info.pw_uid)
            
            # Install rootless Docker
            await self._install_rootless_docker(username)
            
            # Configure systemd user service
            await self._configure_docker_service(username)
            
            # Setup network configuration
            await self._configure_rootless_network(username)
            
            # Apply security policies
            await self._apply_user_security_policies(username)
            
            # Verify installation
            verification = await self._verify_rootless_setup(username)
            
            if verification['success']:
                result['status'] = 'completed'
                result['docker_socket'] = verification['socket_path']
                result['network_range'] = verification['network_range']
                
                # Grant user access
                await self._grant_container_access(username, AccessLevel.DEVELOPER)
                
            else:
                result['status'] = 'failed'
                result['error'] = verification['error']
            
        except Exception as e:
            self.logger.error(f"Rootless Docker setup failed: {e}")
            result['status'] = 'error'
            result['error'] = str(e)
        
        return result
    
    async def _setup_user_namespaces(self, username: str, uid: int):
        """Setup user namespace mappings"""
        self.logger.info(f"Setting up user namespaces for {username}")
        
        # Configure subuid and subgid
        subuid_range = f"{uid}:100000:65536"
        subgid_range = f"{uid}:100000:65536"
        
        # Update /etc/subuid
        subuid_content = []
        subuid_file = "/etc/subuid"
        
        if os.path.exists(subuid_file):
            with open(subuid_file, 'r') as f:
                for line in f:
                    if not line.startswith(f"{username}:"):
                        subuid_content.append(line.strip())
        
        subuid_content.append(subuid_range)
        
        with open(subuid_file, 'w') as f:
            f.write('\n'.join(subuid_content) + '\n')
        
        # Update /etc/subgid
        subgid_content = []
        subgid_file = "/etc/subgid"
        
        if os.path.exists(subgid_file):
            with open(subgid_file, 'r') as f:
                for line in f:
                    if not line.startswith(f"{username}:"):
                        subgid_content.append(line.strip())
        
        subgid_content.append(subgid_range)
        
        with open(subgid_file, 'w') as f:
            f.write('\n'.join(subgid_content) + '\n')
        
        # Set proper permissions
        os.chmod(subuid_file, 0o644)
        os.chmod(subgid_file, 0o644)
    
    async def _install_rootless_docker(self, username: str):
        """Install rootless Docker for user"""
        self.logger.info(f"Installing rootless Docker for {username}")
        
        # Get user home directory
        import pwd
        user_info = pwd.getpwnam(username)
        home_dir = user_info.pw_dir
        
        # Download rootless Docker installer
        installer_url = "https://get.docker.com/rootless"
        installer_path = f"{home_dir}/install-rootless-docker.sh"
        
        # Download installer
        async with aiohttp.ClientSession() as session:
            async with session.get(installer_url) as response:
                if response.status == 200:
                    content = await response.text()
                    with open(installer_path, 'w') as f:
                        f.write(content)
                    os.chmod(installer_path, 0o755)
                else:
                    raise RuntimeError("Failed to download rootless Docker installer")
        
        # Run installer as user
        env = {
            'HOME': home_dir,
            'USER': username,
            'PATH': '/usr/local/bin:/usr/bin:/bin',
            'FORCE_ROOTLESS_INSTALL': '1'
        }
        
        result = subprocess.run(
            ['su', '-', username, '-c', f"bash {installer_path}"],
            env=env,
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            raise RuntimeError(f"Rootless Docker installation failed: {result.stderr}")
        
        # Clean up installer
        os.unlink(installer_path)
    
    async def _configure_docker_service(self, username: str):
        """Configure Docker systemd user service"""
        self.logger.info(f"Configuring Docker service for {username}")
        
        import pwd
        user_info = pwd.getpwnam(username)
        home_dir = user_info.pw_dir
        
        # Enable lingering for user (allows user services to run at boot)
        subprocess.run(['loginctl', 'enable-linger', username], check=True)
        
        # Create systemd user directory
        systemd_dir = f"{home_dir}/.config/systemd/user"
        os.makedirs(systemd_dir, exist_ok=True)
        
        # Create Docker service override
        service_override_dir = f"{systemd_dir}/docker.service.d"
        os.makedirs(service_override_dir, exist_ok=True)
        
        # Security hardening override
        override_content = """[Service]
# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

# Resource limits
MemoryMax=4G
CPUQuota=200%
TasksMax=1000

# Additional security
CapabilityBoundingSet=
AmbientCapabilities=
SecureBits=keep-caps-locked noroot-locked no-setuid-fixup-locked
"""
        
        with open(f"{service_override_dir}/security.conf", 'w') as f:
            f.write(override_content)
        
        # Set ownership
        import shutil
        shutil.chown(systemd_dir, username, username)
        for root, dirs, files in os.walk(systemd_dir):
            for d in dirs:
                shutil.chown(os.path.join(root, d), username, username)
            for file in files:
                shutil.chown(os.path.join(root, file), username, username)
    
    async def _configure_rootless_network(self, username: str):
        """Configure networking for rootless Docker"""
        self.logger.info(f"Configuring rootless network for {username}")
        
        import pwd
        user_info = pwd.getpwnam(username)
        uid = user_info.pw_uid
        
        # Allocate unique port range for user
        base_port = 10000 + (uid % 1000) * 100
        port_range = f"{base_port}-{base_port + 99}"
        
        # Configure slirp4netns port range
        config_dir = f"{user_info.pw_dir}/.config/containers"
        os.makedirs(config_dir, exist_ok=True)
        
        # Create containers.conf
        containers_conf = f"""[containers]
netns="slirp4netns"
userns="auto"

[engine]
cgroup_manager="systemd"
events_logger="journald"
runtime="crun"

[network]
cni_plugin_dirs = ["/usr/libexec/cni"]
default_network = "default"

[machine]
cpus = 2
memory = 2048
"""
        
        with open(f"{config_dir}/containers.conf", 'w') as f:
            f.write(containers_conf)
        
        # Set ownership
        import shutil
        shutil.chown(config_dir, username, username)
        shutil.chown(f"{config_dir}/containers.conf", username, username)
    
    async def _apply_user_security_policies(self, username: str):
        """Apply security policies for user"""
        self.logger.info(f"Applying security policies for {username}")
        
        # Get user security level from LDAP/config
        security_level = await self._get_user_security_level(username)
        
        # Create security policy
        policy = ContainerSecurityPolicy(
            policy_name=f"{username}-policy",
            runtime=ContainerRuntime.DOCKER_ROOTLESS,
            allow_privileged=False,
            allow_host_network=False,
            allow_host_pid=False,
            allow_host_ipc=False,
            allowed_capabilities=[],  # No capabilities by default
            forbidden_syscalls=[
                "reboot", "kexec_load", "open_by_handle_at",
                "init_module", "finit_module", "delete_module"
            ],
            required_seccomp_profile="docker/default",
            read_only_root_filesystem=True,
            run_as_non_root=True,
            user_namespace_required=True,
            image_scanning_required=True,
            image_signature_required=(security_level == SecurityLevel.HARDENED),
            allowed_registries=self.config.get('allowed_registries', [
                "docker.io", "gcr.io", "quay.io", "registry.access.redhat.com"
            ])
        )
        
        # Apply policy-specific restrictions
        if security_level == SecurityLevel.HARDENED:
            policy.allowed_registries = self.config.get('hardened_registries', [
                "internal-registry.company.com"
            ])
            policy.max_memory = "1G"
            policy.max_cpu = "1.0"
        
        # Store policy
        await self._store_security_policy(username, policy)
    
    async def _get_user_security_level(self, username: str) -> SecurityLevel:
        """Get user's security level"""
        # Check LDAP groups or configuration
        if self.ldap_conn:
            try:
                self.ldap_conn.search(
                    search_base=self.config['ldap_group_base'],
                    search_filter=f'(member=uid={username},{self.config["ldap_user_base"]})',
                    attributes=['cn']
                )
                
                user_groups = [entry.cn.value for entry in self.ldap_conn.entries]
                
                if 'security-critical' in user_groups:
                    return SecurityLevel.FIPS
                elif 'security-hardened' in user_groups:
                    return SecurityLevel.HARDENED
                elif 'developers' in user_groups:
                    return SecurityLevel.STANDARD
                else:
                    return SecurityLevel.MINIMAL
                    
            except Exception as e:
                self.logger.error(f"Failed to get user security level: {e}")
        
        return SecurityLevel.STANDARD
    
    async def _store_security_policy(self, username: str, policy: ContainerSecurityPolicy):
        """Store security policy"""
        policy_data = asdict(policy)
        
        # Store in Redis for fast access
        self.redis_client.setex(
            f"security_policy:{username}",
            3600,  # 1 hour cache
            json.dumps(policy_data, default=str)
        )
        
        # Store in database for persistence
        # Implementation depends on schema
    
    async def _verify_rootless_setup(self, username: str) -> Dict[str, Any]:
        """Verify rootless Docker setup"""
        self.logger.info(f"Verifying rootless setup for {username}")
        
        verification = {
            'success': False,
            'socket_path': None,
            'network_range': None,
            'error': None
        }
        
        try:
            import pwd
            user_info = pwd.getpwnam(username)
            home_dir = user_info.pw_dir
            
            # Check Docker socket
            socket_path = f"{home_dir}/.docker/desktop/docker.sock"
            if not os.path.exists(socket_path):
                socket_path = f"/run/user/{user_info.pw_uid}/docker.sock"
            
            if os.path.exists(socket_path):
                verification['socket_path'] = socket_path
                
                # Test Docker connection
                test_cmd = [
                    'su', '-', username, '-c',
                    f'DOCKER_HOST=unix://{socket_path} docker version'
                ]
                
                result = subprocess.run(test_cmd, capture_output=True, text=True)
                
                if result.returncode == 0:
                    verification['success'] = True
                    
                    # Get network configuration
                    net_cmd = [
                        'su', '-', username, '-c',
                        f'DOCKER_HOST=unix://{socket_path} docker network ls'
                    ]
                    
                    net_result = subprocess.run(net_cmd, capture_output=True, text=True)
                    if net_result.returncode == 0:
                        verification['network_range'] = "172.17.0.0/16"  # Default
                else:
                    verification['error'] = f"Docker test failed: {result.stderr}"
            else:
                verification['error'] = "Docker socket not found"
                
        except Exception as e:
            verification['error'] = str(e)
        
        return verification
    
    async def _grant_container_access(self, username: str, access_level: AccessLevel):
        """Grant container access to user"""
        access = UserAccess(
            username=username,
            access_level=access_level,
            allowed_namespaces=['default', f'user-{username}'],
            resource_quotas={
                'memory': '2Gi',
                'cpu': '2',
                'storage': '10Gi'
            },
            mfa_required=True
        )
        
        # Store in database
        session = self.db_session()
        try:
            db_access = ContainerAccessDB(
                access_id=f"{username}-{datetime.now().isoformat()}",
                username=username,
                access_level=access_level.value,
                allowed_namespaces=access.allowed_namespaces,
                resource_quotas=access.resource_quotas,
                mfa_required=access.mfa_required,
                metadata=access.metadata
            )
            
            session.merge(db_access)
            session.commit()
            
        finally:
            session.close()
    
    async def validate_container_operation(self,
                                         username: str,
                                         operation: str,
                                         container_config: Dict[str, Any]) -> Dict[str, Any]:
        """Validate container operation against security policies"""
        self.logger.info(f"Validating container operation for {username}: {operation}")
        
        validation = {
            'allowed': True,
            'violations': [],
            'risk_score': 0,
            'required_approvals': []
        }
        
        try:
            # Get user's security policy
            policy = await self._get_user_security_policy(username)
            
            if not policy:
                validation['allowed'] = False
                validation['violations'].append("No security policy found for user")
                return validation
            
            # Validate image
            image_validation = await self._validate_image(
                container_config.get('image', ''),
                policy
            )
            validation['violations'].extend(image_validation['violations'])
            validation['risk_score'] += image_validation['risk_score']
            
            # Validate privileges
            privilege_validation = self._validate_privileges(container_config, policy)
            validation['violations'].extend(privilege_validation['violations'])
            validation['risk_score'] += privilege_validation['risk_score']
            
            # Validate network configuration
            network_validation = self._validate_network_config(container_config, policy)
            validation['violations'].extend(network_validation['violations'])
            validation['risk_score'] += network_validation['risk_score']
            
            # Validate volumes
            volume_validation = self._validate_volumes(container_config, policy)
            validation['violations'].extend(volume_validation['violations'])
            validation['risk_score'] += volume_validation['risk_score']
            
            # Validate resource limits
            resource_validation = self._validate_resources(container_config, policy)
            validation['violations'].extend(resource_validation['violations'])
            validation['risk_score'] += resource_validation['risk_score']
            
            # Check if operation is allowed
            if validation['violations']:
                validation['allowed'] = False
            
            # High-risk operations require approval
            if validation['risk_score'] > self.config.get('approval_threshold', 70):
                validation['required_approvals'].append('security_team')
                validation['allowed'] = False
            
            # Record validation metrics
            self.security_violations.labels(
                policy=policy.policy_name,
                severity='high' if validation['risk_score'] > 70 else 'medium'
            ).inc(len(validation['violations']))
            
        except Exception as e:
            self.logger.error(f"Validation failed: {e}")
            validation['allowed'] = False
            validation['violations'].append(f"Validation error: {str(e)}")
        
        return validation
    
    async def _get_user_security_policy(self, username: str) -> Optional[ContainerSecurityPolicy]:
        """Get user's security policy"""
        # Try cache first
        policy_data = self.redis_client.get(f"security_policy:{username}")
        
        if policy_data:
            data = json.loads(policy_data)
            return ContainerSecurityPolicy(**data)
        
        # Fallback to database/config
        return None
    
    async def _validate_image(self,
                            image: str,
                            policy: ContainerSecurityPolicy) -> Dict[str, Any]:
        """Validate container image"""
        validation = {
            'violations': [],
            'risk_score': 0
        }
        
        if not image:
            validation['violations'].append("No image specified")
            validation['risk_score'] += 50
            return validation
        
        # Check allowed registries
        image_registry = image.split('/')[0] if '/' in image else 'docker.io'
        
        if policy.allowed_registries and image_registry not in policy.allowed_registries:
            validation['violations'].append(
                f"Image registry {image_registry} not in allowed list"
            )
            validation['risk_score'] += 30
        
        # Check for latest tag (discouraged)
        if image.endswith(':latest') or ':' not in image:
            validation['violations'].append("Using 'latest' tag is discouraged")
            validation['risk_score'] += 10
        
        # Image scanning (if required)
        if policy.image_scanning_required:
            scan_result = await self._scan_image(image)
            if scan_result['vulnerabilities']:
                high_vulns = [v for v in scan_result['vulnerabilities'] 
                            if v['severity'] in ['HIGH', 'CRITICAL']]
                if high_vulns:
                    validation['violations'].append(
                        f"Image has {len(high_vulns)} high/critical vulnerabilities"
                    )
                    validation['risk_score'] += len(high_vulns) * 5
        
        # Image signature verification (if required)
        if policy.image_signature_required:
            signature_valid = await self._verify_image_signature(image)
            if not signature_valid:
                validation['violations'].append("Image signature verification failed")
                validation['risk_score'] += 25
        
        return validation
    
    def _validate_privileges(self,
                           container_config: Dict[str, Any],
                           policy: ContainerSecurityPolicy) -> Dict[str, Any]:
        """Validate container privilege configuration"""
        validation = {
            'violations': [],
            'risk_score': 0
        }
        
        # Check privileged mode
        if container_config.get('privileged', False):
            if not policy.allow_privileged:
                validation['violations'].append("Privileged containers not allowed")
                validation['risk_score'] += 50
        
        # Check capabilities
        caps_add = container_config.get('cap_add', [])
        for cap in caps_add:
            if cap not in policy.allowed_capabilities:
                validation['violations'].append(f"Capability {cap} not allowed")
                validation['risk_score'] += 15
        
        # Check security options
        security_opt = container_config.get('security_opt', [])
        
        # Require seccomp profile
        if policy.required_seccomp_profile:
            seccomp_found = any('seccomp' in opt for opt in security_opt)
            if not seccomp_found:
                validation['violations'].append("Required seccomp profile missing")
                validation['risk_score'] += 20
        
        # Check for dangerous security options
        dangerous_opts = ['seccomp=unconfined', 'apparmor=unconfined']
        for opt in security_opt:
            if opt in dangerous_opts:
                validation['violations'].append(f"Dangerous security option: {opt}")
                validation['risk_score'] += 30
        
        # Check user configuration
        user = container_config.get('user')
        if user == 'root' or user == '0':
            if policy.run_as_non_root:
                validation['violations'].append("Running as root not allowed")
                validation['risk_score'] += 25
        
        return validation
    
    def _validate_network_config(self,
                                container_config: Dict[str, Any],
                                policy: ContainerSecurityPolicy) -> Dict[str, Any]:
        """Validate network configuration"""
        validation = {
            'violations': [],
            'risk_score': 0
        }
        
        network_mode = container_config.get('network_mode', 'default')
        
        # Check host networking
        if network_mode == 'host':
            if not policy.allow_host_network:
                validation['violations'].append("Host networking not allowed")
                validation['risk_score'] += 40
        
        # Check port bindings
        port_bindings = container_config.get('ports', {})
        for container_port, host_config in port_bindings.items():
            if isinstance(host_config, list):
                for binding in host_config:
                    host_port = binding.get('HostPort')
                    if host_port and int(host_port) < 1024:
                        validation['violations'].append(
                            f"Binding to privileged port {host_port}"
                        )
                        validation['risk_score'] += 15
        
        return validation
    
    def _validate_volumes(self,
                        container_config: Dict[str, Any],
                        policy: ContainerSecurityPolicy) -> Dict[str, Any]:
        """Validate volume mounts"""
        validation = {
            'violations': [],
            'risk_score': 0
        }
        
        binds = container_config.get('binds', [])
        
        # Check for dangerous mounts
        dangerous_paths = [
            '/proc', '/sys', '/dev', '/etc', '/boot',
            '/usr', '/bin', '/sbin', '/lib', '/lib64'
        ]
        
        for bind in binds:
            if ':' in bind:
                host_path = bind.split(':')[0]
                
                # Check for dangerous host paths
                for dangerous in dangerous_paths:
                    if host_path.startswith(dangerous):
                        validation['violations'].append(
                            f"Dangerous host path mount: {host_path}"
                        )
                        validation['risk_score'] += 25
                
                # Check for write access to host paths
                if ':rw' in bind or bind.count(':') == 1:  # Default is rw
                    if host_path.startswith('/'):  # Absolute path
                        validation['violations'].append(
                            f"Write access to host path: {host_path}"
                        )
                        validation['risk_score'] += 15
        
        # Check tmpfs mounts
        tmpfs = container_config.get('tmpfs', {})
        for mount_point, options in tmpfs.items():
            if 'exec' in options:
                validation['violations'].append(
                    f"Executable tmpfs mount: {mount_point}"
                )
                validation['risk_score'] += 10
        
        return validation
    
    def _validate_resources(self,
                          container_config: Dict[str, Any],
                          policy: ContainerSecurityPolicy) -> Dict[str, Any]:
        """Validate resource limits"""
        validation = {
            'violations': [],
            'risk_score': 0
        }
        
        host_config = container_config.get('host_config', {})
        
        # Check memory limit
        memory = host_config.get('memory')
        if policy.max_memory:
            max_memory_bytes = self._parse_memory_string(policy.max_memory)
            if memory and memory > max_memory_bytes:
                validation['violations'].append(
                    f"Memory limit {memory} exceeds policy maximum {policy.max_memory}"
                )
                validation['risk_score'] += 10
        
        # Check CPU limit
        cpu_period = host_config.get('cpu_period', 100000)
        cpu_quota = host_config.get('cpu_quota')
        if cpu_quota and policy.max_cpu:
            cpu_limit = cpu_quota / cpu_period
            max_cpu = float(policy.max_cpu)
            if cpu_limit > max_cpu:
                validation['violations'].append(
                    f"CPU limit {cpu_limit} exceeds policy maximum {max_cpu}"
                )
                validation['risk_score'] += 10
        
        # Check for unlimited resources
        if not memory:
            validation['violations'].append("No memory limit specified")
            validation['risk_score'] += 5
        
        if not cpu_quota:
            validation['violations'].append("No CPU limit specified")
            validation['risk_score'] += 5
        
        return validation
    
    def _parse_memory_string(self, memory_str: str) -> int:
        """Parse memory string to bytes"""
        units = {
            'K': 1024, 'M': 1024**2, 'G': 1024**3, 'T': 1024**4,
            'KB': 1000, 'MB': 1000**2, 'GB': 1000**3, 'TB': 1000**4
        }
        
        for unit, multiplier in units.items():
            if memory_str.upper().endswith(unit):
                return int(float(memory_str[:-len(unit)]) * multiplier)
        
        return int(memory_str)  # Assume bytes
    
    async def _scan_image(self, image: str) -> Dict[str, Any]:
        """Scan container image for vulnerabilities"""
        # This would integrate with image scanning tools like Trivy, Clair, etc.
        scan_result = {
            'vulnerabilities': [],
            'scan_time': datetime.now().isoformat()
        }
        
        # Simplified implementation - in production this would call actual scanner
        self.logger.info(f"Scanning image: {image}")
        
        # Example: Use Trivy
        try:
            result = subprocess.run([
                'trivy', 'image', '--format', 'json', image
            ], capture_output=True, text=True, timeout=300)
            
            if result.returncode == 0:
                scan_data = json.loads(result.stdout)
                for target in scan_data.get('Results', []):
                    for vuln in target.get('Vulnerabilities', []):
                        scan_result['vulnerabilities'].append({
                            'id': vuln.get('VulnerabilityID'),
                            'severity': vuln.get('Severity'),
                            'package': vuln.get('PkgName'),
                            'version': vuln.get('InstalledVersion'),
                            'fixed_version': vuln.get('FixedVersion')
                        })
        except Exception as e:
            self.logger.error(f"Image scanning failed: {e}")
        
        return scan_result
    
    async def _verify_image_signature(self, image: str) -> bool:
        """Verify container image signature"""
        # This would integrate with image signing tools like Cosign, Notary, etc.
        try:
            result = subprocess.run([
                'cosign', 'verify', image
            ], capture_output=True, text=True, timeout=60)
            
            return result.returncode == 0
            
        except Exception as e:
            self.logger.error(f"Image signature verification failed: {e}")
            return False
    
    async def audit_container_operation(self,
                                      username: str,
                                      operation: str,
                                      container_config: Dict[str, Any],
                                      result: Dict[str, Any]):
        """Audit container operation"""
        audit_event = ContainerAuditEvent(
            timestamp=datetime.now(),
            user=username,
            action=operation,
            container_id=result.get('container_id'),
            image=container_config.get('image'),
            command=container_config.get('command', []),
            environment=container_config.get('environment', {}),
            privileged=container_config.get('privileged', False),
            capabilities=container_config.get('cap_add', []),
            exit_code=result.get('exit_code'),
            duration=result.get('duration')
        )
        
        # Calculate risk score
        risk_factors = []
        if audit_event.privileged:
            risk_factors.append(('privileged', 25))
        if audit_event.capabilities:
            risk_factors.append(('capabilities', len(audit_event.capabilities) * 5))
        if 'root' in container_config.get('user', ''):
            risk_factors.append(('root_user', 15))
        
        audit_event.risk_score = sum(score for _, score in risk_factors)
        
        # Store audit event
        await self._store_audit_event(audit_event)
        
        # Send alerts for high-risk operations
        if audit_event.risk_score > 50:
            await self._send_security_alert(audit_event)
    
    async def _store_audit_event(self, event: ContainerAuditEvent):
        """Store audit event"""
        event_data = asdict(event)
        
        # Store in multiple locations for durability
        
        # JSON log
        audit_logger = logging.getLogger('audit')
        audit_logger.info(json.dumps(event_data, default=str))
        
        # Redis for real-time access
        self.redis_client.lpush(
            'container_audit_events',
            json.dumps(event_data, default=str)
        )
        
        # Trim to last 100k events
        self.redis_client.ltrim('container_audit_events', 0, 99999)
        
        # Database for long-term storage
        # Implementation depends on schema
    
    async def _send_security_alert(self, event: ContainerAuditEvent):
        """Send security alert for high-risk operations"""
        alert = {
            'type': 'container_security_alert',
            'severity': 'high' if event.risk_score > 70 else 'medium',
            'user': event.user,
            'action': event.action,
            'risk_score': event.risk_score,
            'timestamp': event.timestamp.isoformat(),
            'details': {
                'image': event.image,
                'privileged': event.privileged,
                'capabilities': event.capabilities
            }
        }
        
        # Send to monitoring system
        self.logger.warning(
            f"SECURITY ALERT: {alert}",
            extra={'user': event.user}
        )
        
        # Send to SIEM/alerting system
        # Implementation depends on alerting infrastructure


async def main():
    """Main execution function"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise Docker Security Manager')
    parser.add_argument('--config', default='/etc/docker-security/config.yaml',
                       help='Configuration file path')
    parser.add_argument('--action', required=True,
                       choices=['setup-rootless', 'validate', 'audit', 'policy'],
                       help='Action to perform')
    parser.add_argument('--username', help='Username for operations')
    parser.add_argument('--image', help='Container image to validate')
    parser.add_argument('--config-file', help='Container configuration file')
    
    args = parser.parse_args()
    
    # Initialize manager
    manager = EnterpriseDockerSecurityManager(args.config)
    
    try:
        if args.action == 'setup-rootless':
            if not args.username:
                parser.error('--username required for setup-rootless')
            
            result = await manager.setup_rootless_docker(args.username)
            print(json.dumps(result, indent=2))
        
        elif args.action == 'validate':
            if not args.username or not args.config_file:
                parser.error('--username and --config-file required for validate')
            
            with open(args.config_file, 'r') as f:
                container_config = json.load(f)
            
            validation = await manager.validate_container_operation(
                args.username,
                'create',
                container_config
            )
            
            print(json.dumps(validation, indent=2))
    
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
```

# [Rootless Container Implementation](#rootless-container-implementation)

## Production Deployment Scripts

### Automated Rootless Docker Setup

```bash
#!/bin/bash
# enterprise-rootless-docker-deploy.sh - Deploy enterprise rootless Docker

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="/etc/docker-security"
LOG_DIR="/var/log/docker-security"

# Create directories
mkdir -p "$CONFIG_DIR" "$LOG_DIR"

# Logging
LOG_FILE="$LOG_DIR/rootless-deploy-$(date +%Y%m%d-%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
    exit 1
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites for rootless Docker"
    
    # Check kernel version
    kernel_version=$(uname -r | cut -d. -f1,2)
    if [[ $(echo "$kernel_version >= 4.18" | bc -l) -eq 0 ]]; then
        error "Kernel 4.18+ required for rootless Docker"
    fi
    
    # Check for required packages
    required_packages=("uidmap" "fuse-overlayfs" "slirp4netns")
    missing_packages=()
    
    for package in "${required_packages[@]}"; do
        if ! command -v "$package" &> /dev/null; then
            missing_packages+=("$package")
        fi
    done
    
    if [[ ${#missing_packages[@]} -gt 0 ]]; then
        log "Installing missing packages: ${missing_packages[*]}"
        if command -v dnf &> /dev/null; then
            dnf install -y "${missing_packages[@]}"
        elif command -v apt-get &> /dev/null; then
            apt-get update && apt-get install -y "${missing_packages[@]}"
        else
            error "Cannot install packages: package manager not found"
        fi
    fi
    
    # Check cgroups v2
    if [[ ! -f /sys/fs/cgroup/cgroup.controllers ]]; then
        log "WARNING: cgroups v2 not detected. Some features may not work."
    fi
    
    log "Prerequisites check completed"
}

# Configure system for rootless containers
configure_system() {
    log "Configuring system for rootless containers"
    
    # Enable user namespaces
    echo 'user.max_user_namespaces = 28633' > /etc/sysctl.d/99-rootless.conf
    sysctl -p /etc/sysctl.d/99-rootless.conf
    
    # Configure subuid/subgid ranges
    configure_subuid_subgid
    
    # Enable lingering for container users
    configure_lingering
    
    # Setup cgroups delegation
    configure_cgroups_delegation
    
    # Configure systemd user services
    configure_systemd_user
}

# Configure subuid and subgid
configure_subuid_subgid() {
    log "Configuring subuid/subgid ranges"
    
    # Backup existing files
    [[ -f /etc/subuid ]] && cp /etc/subuid /etc/subuid.bak
    [[ -f /etc/subgid ]] && cp /etc/subgid /etc/subgid.bak
    
    # Create if they don't exist
    touch /etc/subuid /etc/subgid
    
    # Set default ranges for system
    cat >> /etc/subuid <<'EOF'
# Rootless container user ranges
# Format: username:start_uid:count
EOF
    
    cat >> /etc/subgid <<'EOF'
# Rootless container group ranges
# Format: username:start_gid:count
EOF
    
    # Set permissions
    chmod 644 /etc/subuid /etc/subgid
}

# Configure lingering for container users
configure_lingering() {
    log "Configuring user lingering"
    
    # Create lingering directory
    mkdir -p /var/lib/systemd/linger
    
    # Enable lingering for existing container users
    getent group docker-users 2>/dev/null | cut -d: -f4 | tr ',' '\n' | while read -r user; do
        if [[ -n "$user" ]]; then
            loginctl enable-linger "$user" 2>/dev/null || true
            log "Enabled lingering for user: $user"
        fi
    done
}

# Configure cgroups delegation
configure_cgroups_delegation() {
    log "Configuring cgroups delegation"
    
    # Create systemd user slice configuration
    mkdir -p /etc/systemd/system/user@.service.d
    
    cat > /etc/systemd/system/user@.service.d/delegate.conf <<'EOF'
[Service]
# Delegate cgroups to user
Delegate=yes
EOF
    
    # Reload systemd
    systemctl daemon-reload
    
    # Configure user cgroups
    cat > /etc/systemd/system/user-runtime-dir@.service.d/rootless.conf <<'EOF'
[Service]
# Enable cgroups for user runtime directory
ExecStartPost=/bin/bash -c 'echo "+cpu +cpuset +memory +pids" > /sys/fs/cgroup/user.slice/user-%i.slice/cgroup.subtree_control || true'
EOF
}

# Configure systemd user services
configure_systemd_user() {
    log "Configuring systemd user services"
    
    # Enable user service persistence
    cat > /etc/systemd/system/user-session.target.wants/enable-user-services.service <<'EOF'
[Unit]
Description=Enable user services for rootless containers
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'for user in $(getent group docker-users | cut -d: -f4 | tr "," " "); do systemctl --user --machine=${user}@ enable --now docker.service 2>/dev/null || true; done'

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
}

# Setup user for rootless Docker
setup_user_rootless() {
    local username="$1"
    
    log "Setting up rootless Docker for user: $username"
    
    # Verify user exists
    if ! getent passwd "$username" &>/dev/null; then
        error "User $username not found"
    fi
    
    # Get user info
    local user_info=$(getent passwd "$username")
    local uid=$(echo "$user_info" | cut -d: -f3)
    local gid=$(echo "$user_info" | cut -d: -f4)
    local home=$(echo "$user_info" | cut -d: -f6)
    
    # Configure subuid/subgid for user
    configure_user_namespaces "$username" "$uid" "$gid"
    
    # Install rootless Docker for user
    install_user_rootless_docker "$username" "$home"
    
    # Configure user systemd service
    configure_user_docker_service "$username" "$home"
    
    # Apply security policies
    apply_user_security_policies "$username" "$home"
    
    # Verify installation
    verify_user_setup "$username"
}

# Configure user namespaces
configure_user_namespaces() {
    local username="$1"
    local uid="$2"
    local gid="$3"
    
    log "Configuring user namespaces for $username (UID: $uid)"
    
    # Calculate ranges
    local subuid_start=$((100000 + (uid % 1000) * 65536))
    local subgid_start=$((100000 + (gid % 1000) * 65536))
    local range_size=65536
    
    # Remove existing entries
    sed -i "/^$username:/d" /etc/subuid /etc/subgid
    
    # Add new entries
    echo "$username:$subuid_start:$range_size" >> /etc/subuid
    echo "$username:$subgid_start:$range_size" >> /etc/subgid
    
    log "Configured namespace ranges for $username: UID $subuid_start-$((subuid_start + range_size - 1)), GID $subgid_start-$((subgid_start + range_size - 1))"
}

# Install rootless Docker for user
install_user_rootless_docker() {
    local username="$1"
    local home="$2"
    
    log "Installing rootless Docker for $username"
    
    # Create temporary script
    local install_script=$(mktemp)
    
    cat > "$install_script" <<'EOF'
#!/bin/bash
set -euo pipefail

# Download rootless Docker installer
curl -fsSL https://get.docker.com/rootless | sh

# Add to PATH
echo 'export PATH=$HOME/bin:$PATH' >> ~/.bashrc
echo 'export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock' >> ~/.bashrc

# Create systemd user directory
mkdir -p ~/.config/systemd/user

# Enable user services
systemctl --user daemon-reload
systemctl --user enable docker.service
systemctl --user start docker.service
EOF
    
    chmod +x "$install_script"
    
    # Run as user
    su - "$username" -c "$install_script"
    
    rm "$install_script"
    
    log "Rootless Docker installed for $username"
}

# Configure user Docker service
configure_user_docker_service() {
    local username="$1"
    local home="$2"
    
    log "Configuring Docker service for $username"
    
    # Create service override directory
    local override_dir="$home/.config/systemd/user/docker.service.d"
    mkdir -p "$override_dir"
    chown "$username:$username" -R "$home/.config"
    
    # Create security override
    cat > "$override_dir/security.conf" <<'EOF'
[Service]
# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

# Resource limits
MemoryMax=4G
CPUQuota=200%
TasksMax=1000

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docker-rootless
EOF
    
    # Set ownership
    chown "$username:$username" -R "$override_dir"
    
    # Reload user systemd
    su - "$username" -c "systemctl --user daemon-reload"
    su - "$username" -c "systemctl --user restart docker.service"
}

# Apply security policies
apply_user_security_policies() {
    local username="$1"
    local home="$2"
    
    log "Applying security policies for $username"
    
    # Create Docker daemon configuration
    local docker_config_dir="$home/.config/docker"
    mkdir -p "$docker_config_dir"
    
    cat > "$docker_config_dir/daemon.json" <<'EOF'
{
    "log-driver": "journald",
    "log-opts": {
        "tag": "docker-{{.Name}}"
    },
    "storage-driver": "overlay2",
    "userns-remap": "default",
    "no-new-privileges": true,
    "seccomp-profile": "/etc/docker/seccomp/default.json",
    "default-ulimits": {
        "nofile": {
            "Hard": 64000,
            "Name": "nofile",
            "Soft": 64000
        }
    },
    "max-concurrent-downloads": 3,
    "max-concurrent-uploads": 5,
    "shutdown-timeout": 15
}
EOF
    
    # Create client configuration
    cat > "$docker_config_dir/config.json" <<'EOF'
{
    "auths": {},
    "detachKeys": "ctrl-p,ctrl-q",
    "credsStore": "secretservice",
    "experimental": "disabled",
    "features": {
        "buildkit": true
    }
}
EOF
    
    # Set ownership
    chown "$username:$username" -R "$docker_config_dir"
    chmod 700 "$docker_config_dir"
    chmod 600 "$docker_config_dir"/*.json
    
    # Create user policy file
    cat > "$CONFIG_DIR/$username-policy.yaml" <<EOF
# Security policy for user: $username
policy_name: "${username}-rootless-policy"
runtime: "docker_rootless"
security_level: "standard"

# Container restrictions
allow_privileged: false
allow_host_network: false
allow_host_pid: false
allow_host_ipc: false
run_as_non_root: true
read_only_root_filesystem: true

# Resource limits
max_memory: "2G"
max_cpu: "2.0"
max_containers: 10

# Image restrictions
allowed_registries:
  - "docker.io"
  - "gcr.io"
  - "quay.io"
  - "registry.access.redhat.com"

image_scanning_required: true
image_signature_required: false

# Network restrictions
allowed_ports:
  - "8000-8999"
  - "3000-3999"
  - "4000-4999"

# Volume restrictions
allowed_host_paths:
  - "$home/data"
  - "$home/projects"
  - "/tmp"

forbidden_host_paths:
  - "/etc"
  - "/proc"
  - "/sys"
  - "/dev"
EOF
}

# Verify user setup
verify_user_setup() {
    local username="$1"
    
    log "Verifying rootless Docker setup for $username"
    
    # Test Docker connection
    if su - "$username" -c "docker version" &>/dev/null; then
        log "✓ Docker client working"
    else
        error "✗ Docker client not working"
    fi
    
    # Test container creation
    if su - "$username" -c "docker run --rm hello-world" &>/dev/null; then
        log "✓ Container creation working"
    else
        error "✗ Container creation failed"
    fi
    
    # Check systemd service
    if su - "$username" -c "systemctl --user is-active docker.service" | grep -q "active"; then
        log "✓ Docker service active"
    else
        error "✗ Docker service not active"
    fi
    
    # Check user namespaces
    local runtime_dir="/run/user/$(id -u "$username")"
    if [[ -S "$runtime_dir/docker.sock" ]]; then
        log "✓ Docker socket created"
    else
        error "✗ Docker socket not found"
    fi
    
    log "Rootless Docker verification completed for $username"
}

# Setup monitoring
setup_monitoring() {
    log "Setting up rootless Docker monitoring"
    
    # Create monitoring script
    cat > /usr/local/bin/monitor-rootless-docker.sh <<'EOF'
#!/bin/bash
# Monitor rootless Docker instances

LOG_FILE="/var/log/docker-security/rootless-monitor.log"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

# Check all rootless Docker instances
for user_dir in /run/user/*/; do
    if [[ -d "$user_dir" ]]; then
        user_id=$(basename "$user_dir")
        username=$(getent passwd "$user_id" | cut -d: -f1 2>/dev/null)
        
        if [[ -n "$username" ]] && [[ -S "$user_dir/docker.sock" ]]; then
            # Check if Docker daemon is running
            if systemctl --user --machine="${username}@" is-active docker.service &>/dev/null; then
                log "INFO: Docker active for user $username"
                
                # Check container count
                container_count=$(su - "$username" -c "docker ps -q | wc -l" 2>/dev/null || echo "0")
                log "INFO: User $username has $container_count active containers"
                
                # Check for resource usage
                memory_usage=$(su - "$username" -c "docker stats --no-stream --format 'table {{.MemUsage}}'" 2>/dev/null | tail -n +2 | wc -l)
                if [[ $memory_usage -gt 0 ]]; then
                    log "INFO: Memory usage monitoring for user $username"
                fi
            else
                log "WARNING: Docker inactive for user $username"
            fi
        fi
    fi
done
EOF
    
    chmod +x /usr/local/bin/monitor-rootless-docker.sh
    
    # Create systemd timer
    cat > /etc/systemd/system/monitor-rootless-docker.service <<'EOF'
[Unit]
Description=Monitor rootless Docker instances
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/monitor-rootless-docker.sh
StandardOutput=journal
StandardError=journal
EOF
    
    cat > /etc/systemd/system/monitor-rootless-docker.timer <<'EOF'
[Unit]
Description=Run rootless Docker monitoring
Requires=monitor-rootless-docker.service

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
EOF
    
    systemctl daemon-reload
    systemctl enable monitor-rootless-docker.timer
    systemctl start monitor-rootless-docker.timer
}

# Main deployment function
main() {
    local action="${1:-help}"
    local username="${2:-}"
    
    case "$action" in
        install)
            log "Installing enterprise rootless Docker"
            check_prerequisites
            configure_system
            setup_monitoring
            log "System-wide rootless Docker setup completed"
            ;;
        setup-user)
            if [[ -z "$username" ]]; then
                error "Username required for setup-user action"
            fi
            setup_user_rootless "$username"
            log "Rootless Docker setup completed for user: $username"
            ;;
        verify)
            if [[ -z "$username" ]]; then
                error "Username required for verify action"
            fi
            verify_user_setup "$username"
            ;;
        help|*)
            cat <<EOF
Usage: $0 <action> [username]

Actions:
    install           - Install system-wide rootless Docker support
    setup-user <user> - Setup rootless Docker for specific user
    verify <user>     - Verify user's rootless Docker setup
    help              - Show this help message

Examples:
    $0 install
    $0 setup-user alice
    $0 verify alice
EOF
            ;;
    esac
}

# Execute main function
main "$@"
```

## Security Monitoring Dashboard

### Container Security Metrics

```python
#!/usr/bin/env python3
"""
Container Security Metrics Collection
"""

import time
import json
import docker
import psutil
from prometheus_client import start_http_server, Counter, Gauge, Histogram
from datetime import datetime

# Metrics
container_security_events = Counter(
    'container_security_events_total',
    'Security events by type',
    ['event_type', 'severity', 'user']
)

rootless_containers = Gauge(
    'rootless_containers_active',
    'Active rootless containers',
    ['user', 'image']
)

container_resource_usage = Gauge(
    'container_resource_usage',
    'Container resource usage',
    ['user', 'container', 'resource']
)

privilege_escalations = Counter(
    'privilege_escalations_total',
    'Privilege escalation attempts',
    ['user', 'method', 'result']
)

def collect_metrics():
    """Collect security metrics from all Docker instances"""
    
    # Find all user Docker instances
    for proc in psutil.process_iter(['pid', 'name', 'username', 'cmdline']):
        try:
            if proc.info['name'] == 'dockerd' and '--rootless' in ' '.join(proc.info['cmdline']):
                username = proc.info['username']
                
                # Connect to user's Docker socket
                user_socket = f"/run/user/{proc.info['pid']}/docker.sock"
                if os.path.exists(user_socket):
                    try:
                        client = docker.DockerClient(base_url=f"unix://{user_socket}")
                        
                        # Count active containers
                        containers = client.containers.list()
                        
                        for container in containers:
                            # Update container metrics
                            rootless_containers.labels(
                                user=username,
                                image=container.image.tags[0] if container.image.tags else 'unknown'
                            ).set(1)
                            
                            # Get resource stats
                            stats = container.stats(stream=False)
                            
                            # Memory usage
                            memory_usage = stats['memory_stats'].get('usage', 0)
                            container_resource_usage.labels(
                                user=username,
                                container=container.name,
                                resource='memory'
                            ).set(memory_usage)
                            
                            # CPU usage
                            cpu_usage = calculate_cpu_percent(stats)
                            container_resource_usage.labels(
                                user=username,
                                container=container.name,
                                resource='cpu'
                            ).set(cpu_usage)
                            
                    except Exception as e:
                        print(f"Error connecting to Docker for user {username}: {e}")
                        
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

def calculate_cpu_percent(stats):
    """Calculate CPU usage percentage"""
    try:
        cpu_stats = stats['cpu_stats']
        precpu_stats = stats['precpu_stats']
        
        cpu_usage = cpu_stats['cpu_usage']['total_usage']
        precpu_usage = precpu_stats['cpu_usage']['total_usage']
        
        system_usage = cpu_stats['system_cpu_usage']
        presystem_usage = precpu_stats['system_cpu_usage']
        
        cpu_delta = cpu_usage - precpu_usage
        system_delta = system_usage - presystem_usage
        
        if system_delta > 0:
            return (cpu_delta / system_delta) * 100
        return 0
        
    except (KeyError, ZeroDivisionError):
        return 0

def monitor_security_events():
    """Monitor for security events"""
    
    # Monitor audit logs
    # This would integrate with systemd journal or audit logs
    
    # Example: Check for privilege escalation attempts
    for line in follow_log('/var/log/audit/audit.log'):
        if 'auid=' in line and 'SYSCALL' in line:
            # Parse audit log entry
            if 'setuid' in line or 'setgid' in line:
                # Privilege escalation detected
                privilege_escalations.labels(
                    user='unknown',
                    method='syscall',
                    result='attempted'
                ).inc()

def follow_log(filename):
    """Generator to follow log file"""
    with open(filename, 'r') as f:
        f.seek(0, 2)  # Go to end of file
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.1)
                continue
            yield line

if __name__ == '__main__':
    # Start Prometheus metrics server
    start_http_server(8000)
    
    print("Starting container security metrics collection...")
    
    while True:
        try:
            collect_metrics()
            time.sleep(30)  # Collect every 30 seconds
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Error collecting metrics: {e}")
            time.sleep(60)
```

## Best Practices and Troubleshooting

### Security Best Practices

1. **Never Add Users to Docker Group**
   - Use rootless Docker instead
   - Implement proper access controls
   - Monitor group membership changes

2. **Image Security**
   - Use official base images
   - Scan for vulnerabilities
   - Verify image signatures
   - Implement image policies

3. **Runtime Security**
   - Run as non-root user
   - Use read-only filesystems
   - Implement security profiles
   - Limit capabilities

4. **Network Security**
   - Avoid host networking
   - Use custom networks
   - Implement network policies
   - Monitor network traffic

### Common Issues and Solutions

#### Rootless Setup Failures

```bash
#!/bin/bash
# troubleshoot-rootless.sh - Troubleshoot rootless Docker issues

echo "=== Rootless Docker Troubleshooting ==="

# Check user namespaces
echo "User Namespace Support:"
if [[ -f /proc/sys/user/max_user_namespaces ]]; then
    echo "  Max user namespaces: $(cat /proc/sys/user/max_user_namespaces)"
else
    echo "  User namespaces not supported"
fi

# Check subuid/subgid
echo -e "\nSubUID/SubGID Configuration:"
if [[ -f /etc/subuid ]]; then
    echo "  /etc/subuid exists: $(wc -l < /etc/subuid) entries"
    grep "^$USER:" /etc/subuid || echo "  No entry for $USER"
else
    echo "  /etc/subuid missing"
fi

if [[ -f /etc/subgid ]]; then
    echo "  /etc/subgid exists: $(wc -l < /etc/subgid) entries"
    grep "^$USER:" /etc/subgid || echo "  No entry for $USER"
else
    echo "  /etc/subgid missing"
fi

# Check cgroups
echo -e "\nCgroups Configuration:"
if [[ -d /sys/fs/cgroup/systemd ]]; then
    echo "  Cgroups v1 detected"
elif [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
    echo "  Cgroups v2 detected"
    echo "  Available controllers: $(cat /sys/fs/cgroup/cgroup.controllers)"
else
    echo "  Cgroups not properly configured"
fi

# Check systemd user session
echo -e "\nSystemd User Session:"
if systemctl --user is-active docker.service &>/dev/null; then
    echo "  Docker service: ACTIVE"
else
    echo "  Docker service: INACTIVE"
    systemctl --user status docker.service
fi

# Check Docker socket
echo -e "\nDocker Socket:"
if [[ -S "$XDG_RUNTIME_DIR/docker.sock" ]]; then
    echo "  Socket exists: $XDG_RUNTIME_DIR/docker.sock"
else
    echo "  Socket missing: $XDG_RUNTIME_DIR/docker.sock"
fi

# Test Docker connection
echo -e "\nDocker Connection Test:"
if docker version &>/dev/null; then
    echo "  Connection: SUCCESS"
    docker version --format "  Client: {{.Client.Version}}, Server: {{.Server.Version}}"
else
    echo "  Connection: FAILED"
fi
```

#### Permission Issues

```bash
#!/bin/bash
# fix-rootless-permissions.sh - Fix common permission issues

# Fix subuid/subgid permissions
sudo chmod 644 /etc/subuid /etc/subgid

# Fix user runtime directory
sudo mkdir -p "/run/user/$(id -u)"
sudo chown "$(id -u):$(id -g)" "/run/user/$(id -u)"
sudo chmod 700 "/run/user/$(id -u)"

# Fix Docker configuration directory
mkdir -p ~/.config/docker
chmod 700 ~/.config/docker

# Restart user systemd session
systemctl --user daemon-reload
systemctl --user restart docker.service

echo "Permissions fixed. Try running docker commands again."
```

## Conclusion

Enterprise Docker security requires comprehensive approaches that eliminate root privileges, implement zero-trust principles, and provide complete audit trails while maintaining operational efficiency. By deploying rootless container runtimes, advanced security policies, and continuous monitoring systems, organizations can significantly reduce the attack surface of containerized applications while enabling secure self-service container operations for developers and operators.

The combination of rootless runtimes, user namespace isolation, comprehensive access controls, and behavioral monitoring provides the foundation for secure container operations in modern enterprise environments, enabling organizations to leverage container technologies while maintaining the highest security standards.