---
title: "Enterprise Sudo and Privilege Management: Comprehensive Security Framework and Zero-Trust Access Control"
date: 2025-08-05T10:00:00-05:00
draft: false
tags: ["Sudo", "Privilege Management", "Security", "Access Control", "PAM", "Zero Trust", "Enterprise Security", "Linux", "Automation", "Compliance"]
categories:
- Security Infrastructure
- Access Management
- Enterprise Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to sudo configuration, advanced privilege management, zero-trust access control, comprehensive security frameworks, and automated compliance systems for production environments"
more_link: "yes"
url: "/enterprise-sudo-privilege-management-comprehensive-security-framework/"
---

Enterprise Linux environments require sophisticated privilege management systems that balance operational efficiency with security requirements, implementing zero-trust principles, comprehensive audit trails, and automated compliance frameworks across thousands of systems. This guide covers advanced sudo configurations, enterprise privilege management architectures, security automation frameworks, and production-grade access control systems.

<!--more-->

# [Enterprise Privilege Management Architecture](#enterprise-privilege-management-architecture)

## Zero-Trust Access Control Framework

Enterprise privilege management demands comprehensive security architectures that implement least-privilege principles, time-based access controls, multi-factor authentication, and complete audit trails while maintaining operational efficiency and emergency access capabilities.

### Enterprise Privilege Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│           Enterprise Privilege Management Architecture          │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│  Identity Layer │  Policy Layer   │  Enforcement    │ Audit     │
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ LDAP/AD     │ │ │ RBAC Rules  │ │ │ Sudo Config │ │ │ Logs  │ │
│ │ SAML/OAuth  │ │ │ Time-based  │ │ │ PAM Modules │ │ │ SIEM  │ │
│ │ MFA/FIDO2   │ │ │ Context     │ │ │ SELinux     │ │ │ Alerts│ │
│ │ Certificates│ │ │ Approval    │ │ │ Containers  │ │ │ Report│ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Federated     │ • Dynamic       │ • Real-time     │ • Complete│
│ • Multi-factor  │ • Risk-based    │ • Contextual    │ • Tamper  │
│ • Biometric     │ • ML-driven     │ • Adaptive      │ • Proof   │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Privilege Management Maturity Model

| Level | Authentication | Authorization | Auditing | Scale |
|-------|---------------|---------------|----------|--------|
| **Basic** | Local users | Static sudoers | Local logs | Single system |
| **Managed** | LDAP/AD | Group-based | Centralized logs | 100s systems |
| **Advanced** | MFA required | Role-based | Real-time alerts | 1000s systems |
| **Enterprise** | Zero-trust | Context-aware | ML anomaly detection | 10000s+ systems |

## Advanced Sudo Management Framework

### Enterprise Sudo Configuration System

```python
#!/usr/bin/env python3
"""
Enterprise Sudo and Privilege Management Framework
"""

import os
import sys
import json
import yaml
import logging
import asyncio
import hashlib
import subprocess
from typing import Dict, List, Optional, Tuple, Any, Union, Set
from dataclasses import dataclass, asdict, field
from pathlib import Path
from enum import Enum
from datetime import datetime, timedelta
import ldap3
import jwt
import pyotp
import pam
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import redis
import psycopg2
from prometheus_client import Counter, Gauge, Histogram
import aiohttp
import jinja2
from sqlalchemy import create_engine, Column, String, DateTime, Boolean, Integer, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

Base = declarative_base()

class PrivilegeLevel(Enum):
    READ_ONLY = "read_only"
    STANDARD = "standard"
    ELEVATED = "elevated"
    ADMIN = "admin"
    EMERGENCY = "emergency"

class AccessType(Enum):
    PERMANENT = "permanent"
    TEMPORARY = "temporary"
    TIME_BOUND = "time_bound"
    APPROVAL_REQUIRED = "approval_required"
    BREAK_GLASS = "break_glass"

class AuthMethod(Enum):
    PASSWORD = "password"
    SSH_KEY = "ssh_key"
    MFA_TOTP = "mfa_totp"
    MFA_FIDO2 = "mfa_fido2"
    CERTIFICATE = "certificate"
    BIOMETRIC = "biometric"

@dataclass
class SudoRule:
    """Individual sudo rule configuration"""
    user: str
    host: str = "ALL"
    run_as_user: str = "ALL"
    run_as_group: Optional[str] = None
    commands: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)  # NOPASSWD, NOEXEC, etc.
    environment_vars: List[str] = field(default_factory=list)
    comment: Optional[str] = None
    expires: Optional[datetime] = None
    approval_required: bool = False
    mfa_required: bool = True
    risk_score: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class PrivilegeRequest:
    """Privilege elevation request"""
    request_id: str
    user: str
    requested_privilege: PrivilegeLevel
    reason: str
    duration_minutes: int
    commands: List[str]
    approval_status: str = "pending"
    approver: Optional[str] = None
    approved_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    risk_assessment: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class AuditEvent:
    """Sudo audit event"""
    timestamp: datetime
    user: str
    effective_user: str
    command: str
    working_directory: str
    exit_code: Optional[int] = None
    session_id: str = ""
    tty: Optional[str] = None
    environment: Dict[str, str] = field(default_factory=dict)
    risk_score: int = 0
    anomaly_detected: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)

class SudoRuleDB(Base):
    """Database model for sudo rules"""
    __tablename__ = 'sudo_rules'
    
    rule_id = Column(String, primary_key=True)
    user = Column(String, index=True)
    host = Column(String)
    run_as_user = Column(String)
    run_as_group = Column(String)
    commands = Column(JSON)
    tags = Column(JSON)
    environment_vars = Column(JSON)
    comment = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
    approval_required = Column(Boolean, default=False)
    mfa_required = Column(Boolean, default=True)
    risk_score = Column(Integer, default=0)
    active = Column(Boolean, default=True)
    metadata = Column(JSON)

class EnterpriseSudoManager:
    """Enterprise sudo and privilege management system"""
    
    def __init__(self, config_path: str):
        self.config = self._load_config(config_path)
        self.logger = self._setup_logging()
        self.template_env = self._setup_templates()
        self.db_engine = create_engine(self.config['database_url'])
        Base.metadata.create_all(self.db_engine)
        self.db_session = sessionmaker(bind=self.db_engine)
        self.redis_client = self._init_redis()
        self.ldap_conn = self._init_ldap()
        self.encryption_key = self._init_encryption()
        
        # Metrics
        self.privilege_requests = Counter('sudo_privilege_requests_total',
                                        'Total privilege requests',
                                        ['user', 'level', 'status'])
        self.rule_evaluations = Counter('sudo_rule_evaluations_total',
                                      'Total rule evaluations',
                                      ['result', 'risk_level'])
        self.auth_attempts = Counter('sudo_auth_attempts_total',
                                   'Total authentication attempts',
                                   ['method', 'result'])
        self.active_sessions = Gauge('sudo_active_sessions',
                                   'Currently active privileged sessions',
                                   ['privilege_level'])
        self.command_execution_time = Histogram('sudo_command_duration_seconds',
                                              'Command execution time')
        
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
            '/var/log/sudo-manager/sudo-manager.log',
            maxBytes=100*1024*1024,  # 100MB
            backupCount=10
        )
        file_handler.setLevel(logging.DEBUG)
        
        # Security log handler
        security_handler = RotatingFileHandler(
            '/var/log/sudo-manager/security.log',
            maxBytes=100*1024*1024,
            backupCount=30
        )
        security_handler.setLevel(logging.WARNING)
        
        # Syslog handler for SIEM
        syslog_handler = logging.handlers.SysLogHandler(
            address=(self.config.get('syslog_host', 'localhost'), 514),
            facility=logging.handlers.SysLogHandler.LOG_AUTH
        )
        syslog_handler.setLevel(logging.INFO)
        
        # Formatter
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - [%(user)s] %(message)s'
        )
        
        for handler in [console_handler, file_handler, security_handler, syslog_handler]:
            handler.setFormatter(formatter)
            logger.addHandler(handler)
        
        return logger
    
    def _setup_templates(self) -> jinja2.Environment:
        """Setup Jinja2 template environment"""
        template_dir = self.config.get('template_dir', '/etc/sudo-manager/templates')
        
        env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(template_dir),
            autoescape=True,
            trim_blocks=True,
            lstrip_blocks=True
        )
        
        # Add custom filters
        env.filters['escape_sudo'] = self._escape_sudo_string
        env.filters['format_time'] = self._format_time_restriction
        
        return env
    
    def _escape_sudo_string(self, value: str) -> str:
        """Escape special characters for sudoers file"""
        # Escape characters that have special meaning in sudoers
        special_chars = ['\\', ',', ':', '=', ' ']
        for char in special_chars:
            value = value.replace(char, f'\\{char}')
        return value
    
    def _format_time_restriction(self, start: datetime, end: datetime) -> str:
        """Format time restriction for sudo rule"""
        # This would integrate with sudo time plugins
        return f"TIME={start.strftime('%H:%M')}-{end.strftime('%H:%M')}"
    
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
                use_ssl=True,
                get_info=ldap3.ALL
            )
            
            conn = ldap3.Connection(
                server,
                user=self.config.get('ldap_bind_dn'),
                password=self.config.get('ldap_bind_password'),
                auto_bind=True,
                authentication=ldap3.SASL,
                sasl_mechanism='GSSAPI'
            )
            
            return conn
            
        except Exception as e:
            self.logger.error(f"Failed to initialize LDAP: {e}")
            return None
    
    def _init_encryption(self) -> Fernet:
        """Initialize encryption for sensitive data"""
        # Use KDF to derive key from password
        password = self.config.get('encryption_password', '').encode()
        salt = self.config.get('encryption_salt', 'sudo-manager').encode()
        
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000
        )
        
        key = base64.urlsafe_b64encode(kdf.derive(password))
        return Fernet(key)
    
    async def create_sudo_rule(self,
                             rule: SudoRule,
                             requester: str,
                             reason: str) -> Dict[str, Any]:
        """Create new sudo rule with approval workflow"""
        self.logger.info(f"Creating sudo rule for user {rule.user}",
                        extra={'user': requester})
        
        result = {
            'rule_id': hashlib.sha256(
                f"{rule.user}-{datetime.now().isoformat()}".encode()
            ).hexdigest()[:16],
            'status': 'pending',
            'created_at': datetime.now().isoformat()
        }
        
        try:
            # Validate rule
            validation = await self._validate_sudo_rule(rule, requester)
            if not validation['valid']:
                result['status'] = 'rejected'
                result['errors'] = validation['errors']
                return result
            
            # Risk assessment
            risk_score = await self._assess_rule_risk(rule, requester)
            rule.risk_score = risk_score
            result['risk_score'] = risk_score
            
            # Determine if approval needed
            if risk_score > self.config.get('auto_approve_threshold', 50):
                rule.approval_required = True
            
            # Check if user has permission to create rule
            if not await self._check_permission(requester, 'create_sudo_rule', rule):
                result['status'] = 'unauthorized'
                result['error'] = 'Insufficient permissions'
                self.privilege_requests.labels(
                    user=requester,
                    level=rule.metadata.get('privilege_level', 'unknown'),
                    status='unauthorized'
                ).inc()
                return result
            
            # If approval required, create request
            if rule.approval_required:
                approval_request = await self._create_approval_request(
                    rule, requester, reason
                )
                result['approval_request_id'] = approval_request['request_id']
                result['status'] = 'pending_approval'
                
                # Notify approvers
                await self._notify_approvers(approval_request)
            else:
                # Auto-approve low-risk rules
                await self._apply_sudo_rule(rule)
                result['status'] = 'active'
            
            # Store rule in database
            self._store_rule(rule, result['rule_id'])
            
            # Audit log
            await self._audit_log({
                'action': 'create_sudo_rule',
                'user': requester,
                'rule_id': result['rule_id'],
                'risk_score': risk_score,
                'auto_approved': not rule.approval_required,
                'reason': reason
            })
            
            self.privilege_requests.labels(
                user=requester,
                level=rule.metadata.get('privilege_level', 'standard'),
                status=result['status']
            ).inc()
            
        except Exception as e:
            self.logger.error(f"Failed to create sudo rule: {e}")
            result['status'] = 'error'
            result['error'] = str(e)
        
        return result
    
    async def _validate_sudo_rule(self, rule: SudoRule, requester: str) -> Dict[str, Any]:
        """Validate sudo rule configuration"""
        validation = {
            'valid': True,
            'errors': [],
            'warnings': []
        }
        
        # User validation
        if not await self._validate_user(rule.user):
            validation['errors'].append(f"Invalid user: {rule.user}")
            validation['valid'] = False
        
        # Check if user exists in directory
        if self.ldap_conn:
            if not self._ldap_user_exists(rule.user):
                validation['errors'].append(f"User {rule.user} not found in directory")
                validation['valid'] = False
        
        # Command validation
        for cmd in rule.commands:
            cmd_validation = self._validate_command(cmd)
            if not cmd_validation['valid']:
                validation['errors'].extend(cmd_validation['errors'])
                validation['valid'] = False
            validation['warnings'].extend(cmd_validation.get('warnings', []))
        
        # Time-based validation
        if rule.expires and rule.expires < datetime.now():
            validation['errors'].append("Expiration date is in the past")
            validation['valid'] = False
        
        # Tag validation
        valid_tags = ['NOPASSWD', 'PASSWD', 'NOEXEC', 'EXEC', 'SETENV', 
                     'NOSETENV', 'LOG_INPUT', 'LOG_OUTPUT', 'FOLLOW', 'NOFOLLOW']
        for tag in rule.tags:
            if tag not in valid_tags:
                validation['errors'].append(f"Invalid tag: {tag}")
                validation['valid'] = False
        
        # Security policy validation
        policy_violations = await self._check_security_policies(rule, requester)
        if policy_violations:
            validation['errors'].extend(policy_violations)
            validation['valid'] = False
        
        return validation
    
    async def _validate_user(self, user: str) -> bool:
        """Validate user format and existence"""
        # Check format
        if not user or not user.replace('_', '').replace('-', '').isalnum():
            return False
        
        # Check if user exists on system
        try:
            import pwd
            pwd.getpwnam(user)
            return True
        except KeyError:
            # Check if it's a group
            if user.startswith('%'):
                try:
                    import grp
                    grp.getgrnam(user[1:])
                    return True
                except KeyError:
                    pass
        
        return False
    
    def _validate_command(self, command: str) -> Dict[str, Any]:
        """Validate command syntax and security"""
        validation = {
            'valid': True,
            'errors': [],
            'warnings': []
        }
        
        # Check for dangerous patterns
        dangerous_patterns = [
            (r'.*\brm\s+-rf\s+/', "Dangerous rm -rf command"),
            (r'.*\bdd\s+.*\bof=/dev/[sh]d[a-z]', "Direct disk write detected"),
            (r'.*\b(chmod|chown)\s+.*-R\s+.*/', "Recursive permission change on root"),
            (r'.*\bcurl\s+.*\|\s*bash', "Piping curl to bash detected"),
            (r'.*\bwget\s+.*\|\s*sh', "Piping wget to shell detected")
        ]
        
        import re
        for pattern, message in dangerous_patterns:
            if re.match(pattern, command):
                validation['warnings'].append(f"Security warning: {message}")
        
        # Check command exists
        if not command.startswith('/'):
            validation['warnings'].append(
                f"Command '{command}' is not an absolute path"
            )
        elif command != 'ALL' and not os.path.exists(command.split()[0]):
            validation['warnings'].append(
                f"Command '{command.split()[0]}' not found"
            )
        
        return validation
    
    def _ldap_user_exists(self, username: str) -> bool:
        """Check if user exists in LDAP"""
        if not self.ldap_conn:
            return True  # Assume exists if LDAP not configured
        
        try:
            self.ldap_conn.search(
                search_base=self.config['ldap_user_base'],
                search_filter=f'(uid={username})',
                attributes=['uid']
            )
            return len(self.ldap_conn.entries) > 0
        except Exception as e:
            self.logger.error(f"LDAP search failed: {e}")
            return True  # Fail open for availability
    
    async def _check_security_policies(self, 
                                     rule: SudoRule,
                                     requester: str) -> List[str]:
        """Check rule against security policies"""
        violations = []
        
        # Load security policies
        policies = self.config.get('security_policies', {})
        
        # Check maximum privilege duration
        if rule.expires:
            max_duration = timedelta(hours=policies.get('max_privilege_hours', 8))
            if rule.expires - datetime.now() > max_duration:
                violations.append(
                    f"Rule duration exceeds maximum of {max_duration.total_seconds()/3600} hours"
                )
        
        # Check NOPASSWD restrictions
        if 'NOPASSWD' in rule.tags:
            if policies.get('nopasswd_requires_mfa', True) and not rule.mfa_required:
                violations.append("NOPASSWD rules require MFA")
            
            if rule.user == 'ALL' or rule.commands == ['ALL']:
                violations.append("NOPASSWD not allowed for unrestricted access")
        
        # Check command restrictions
        forbidden_commands = policies.get('forbidden_commands', [])
        for cmd in rule.commands:
            for forbidden in forbidden_commands:
                if forbidden in cmd:
                    violations.append(f"Command contains forbidden pattern: {forbidden}")
        
        # Check user restrictions
        if rule.user in policies.get('restricted_users', []):
            violations.append(f"User {rule.user} is restricted from sudo access")
        
        # Check separation of duties
        sod_violations = await self._check_separation_of_duties(rule, requester)
        violations.extend(sod_violations)
        
        return violations
    
    async def _check_separation_of_duties(self,
                                        rule: SudoRule,
                                        requester: str) -> List[str]:
        """Check separation of duties policies"""
        violations = []
        
        # Users cannot grant privileges to themselves
        if rule.user == requester and 'ALL' in rule.commands:
            violations.append("Cannot grant unrestricted sudo to yourself")
        
        # Check conflicting roles
        user_roles = await self._get_user_roles(rule.user)
        
        conflicting_roles = {
            'security_admin': ['database_admin', 'application_admin'],
            'auditor': ['system_admin', 'security_admin'],
            'developer': ['production_admin']
        }
        
        for role, conflicts in conflicting_roles.items():
            if role in user_roles:
                for conflict in conflicts:
                    if conflict in user_roles:
                        violations.append(
                            f"User has conflicting roles: {role} and {conflict}"
                        )
        
        return violations
    
    async def _get_user_roles(self, username: str) -> Set[str]:
        """Get user's roles from directory service"""
        roles = set()
        
        if self.ldap_conn:
            try:
                self.ldap_conn.search(
                    search_base=self.config['ldap_group_base'],
                    search_filter=f'(member=uid={username},{self.config["ldap_user_base"]})',
                    attributes=['cn']
                )
                
                for entry in self.ldap_conn.entries:
                    roles.add(entry.cn.value)
            except Exception as e:
                self.logger.error(f"Failed to get user roles: {e}")
        
        return roles
    
    async def _assess_rule_risk(self, rule: SudoRule, requester: str) -> int:
        """Assess risk score for sudo rule"""
        risk_score = 0
        
        # User scope risk
        if rule.user == 'ALL':
            risk_score += 30
        elif rule.user.startswith('%'):  # Group
            risk_score += 20
        else:
            risk_score += 10
        
        # Command risk
        if rule.commands == ['ALL']:
            risk_score += 40
        else:
            for cmd in rule.commands:
                if 'rm' in cmd or 'dd' in cmd:
                    risk_score += 20
                elif 'chmod' in cmd or 'chown' in cmd:
                    risk_score += 15
                elif any(editor in cmd for editor in ['vi', 'vim', 'emacs', 'nano']):
                    risk_score += 10
                else:
                    risk_score += 5
        
        # Tag risk
        if 'NOPASSWD' in rule.tags:
            risk_score += 25
        if 'NOEXEC' not in rule.tags:
            risk_score += 10
        
        # Time-based risk
        if not rule.expires:
            risk_score += 20  # Permanent rules are higher risk
        elif rule.expires - datetime.now() > timedelta(days=30):
            risk_score += 10
        
        # Run-as risk
        if rule.run_as_user == 'root' or rule.run_as_user == 'ALL':
            risk_score += 20
        
        # Historical risk factors
        user_history = await self._get_user_risk_history(requester)
        risk_score += user_history.get('risk_modifier', 0)
        
        # Normalize to 0-100
        return min(risk_score, 100)
    
    async def _get_user_risk_history(self, username: str) -> Dict[str, Any]:
        """Get user's historical risk factors"""
        history = {
            'risk_modifier': 0,
            'violations': 0,
            'approved_requests': 0,
            'denied_requests': 0
        }
        
        # Query audit database for user history
        # This is simplified - real implementation would query audit logs
        cache_key = f"user_risk_history:{username}"
        cached = self.redis_client.get(cache_key)
        
        if cached:
            return json.loads(cached)
        
        # Calculate risk modifier based on history
        # More violations = higher risk
        history['risk_modifier'] = history['violations'] * 5
        
        # Cache for 1 hour
        self.redis_client.setex(
            cache_key,
            3600,
            json.dumps(history)
        )
        
        return history
    
    async def _check_permission(self,
                              user: str,
                              action: str,
                              context: Any) -> bool:
        """Check if user has permission for action"""
        # Get user's permissions
        user_perms = await self._get_user_permissions(user)
        
        # Check against required permission
        required_perm = f"sudo:{action}"
        
        if required_perm in user_perms:
            return True
        
        # Check role-based permissions
        user_roles = await self._get_user_roles(user)
        role_perms = self.config.get('role_permissions', {})
        
        for role in user_roles:
            if required_perm in role_perms.get(role, []):
                return True
        
        return False
    
    async def _get_user_permissions(self, username: str) -> Set[str]:
        """Get user's direct permissions"""
        perms = set()
        
        # Check cache first
        cache_key = f"user_permissions:{username}"
        cached = self.redis_client.get(cache_key)
        
        if cached:
            return set(json.loads(cached))
        
        # Query permission system
        # This is simplified - real implementation would integrate with
        # enterprise permission management system
        
        # Cache for 5 minutes
        self.redis_client.setex(
            cache_key,
            300,
            json.dumps(list(perms))
        )
        
        return perms
    
    async def _create_approval_request(self,
                                     rule: SudoRule,
                                     requester: str,
                                     reason: str) -> Dict[str, Any]:
        """Create approval request for high-risk rule"""
        request = PrivilegeRequest(
            request_id=hashlib.sha256(
                f"{requester}-{datetime.now().isoformat()}".encode()
            ).hexdigest()[:16],
            user=rule.user,
            requested_privilege=PrivilegeLevel.ELEVATED,
            reason=reason,
            duration_minutes=int((rule.expires - datetime.now()).total_seconds() / 60) if rule.expires else 0,
            commands=rule.commands,
            risk_assessment={
                'risk_score': rule.risk_score,
                'requester': requester,
                'rule_details': asdict(rule)
            }
        )
        
        # Store in database
        session = self.db_session()
        try:
            # Store request (implementation depends on schema)
            self.redis_client.setex(
                f"approval_request:{request.request_id}",
                86400,  # 24 hours
                json.dumps(asdict(request), default=str)
            )
        finally:
            session.close()
        
        return asdict(request)
    
    async def _notify_approvers(self, approval_request: Dict[str, Any]):
        """Notify approvers of pending request"""
        approvers = await self._get_approvers(
            approval_request['risk_assessment']['risk_score']
        )
        
        for approver in approvers:
            await self._send_notification(approver, {
                'type': 'approval_required',
                'request_id': approval_request['request_id'],
                'requester': approval_request['risk_assessment']['requester'],
                'user': approval_request['user'],
                'reason': approval_request['reason'],
                'risk_score': approval_request['risk_assessment']['risk_score'],
                'commands': approval_request['commands']
            })
    
    async def _get_approvers(self, risk_score: int) -> List[str]:
        """Get list of approvers based on risk score"""
        if risk_score >= 80:
            # High risk - require security team approval
            return await self._get_group_members('security-admins')
        elif risk_score >= 60:
            # Medium risk - require team lead approval
            return await self._get_group_members('team-leads')
        else:
            # Low risk - peer approval
            return await self._get_group_members('sudo-approvers')
    
    async def _get_group_members(self, group: str) -> List[str]:
        """Get members of a group"""
        members = []
        
        if self.ldap_conn:
            try:
                self.ldap_conn.search(
                    search_base=self.config['ldap_group_base'],
                    search_filter=f'(cn={group})',
                    attributes=['member']
                )
                
                if self.ldap_conn.entries:
                    for member_dn in self.ldap_conn.entries[0].member:
                        # Extract username from DN
                        username = member_dn.split(',')[0].split('=')[1]
                        members.append(username)
            except Exception as e:
                self.logger.error(f"Failed to get group members: {e}")
        
        return members
    
    async def _send_notification(self, recipient: str, notification: Dict[str, Any]):
        """Send notification to user"""
        # Multiple notification channels
        notification_methods = []
        
        # Email notification
        if self.config.get('email_enabled'):
            notification_methods.append(
                self._send_email_notification(recipient, notification)
            )
        
        # Slack notification
        if self.config.get('slack_enabled'):
            notification_methods.append(
                self._send_slack_notification(recipient, notification)
            )
        
        # SMS for critical notifications
        if notification.get('risk_score', 0) >= 80 and self.config.get('sms_enabled'):
            notification_methods.append(
                self._send_sms_notification(recipient, notification)
            )
        
        # Execute all notifications in parallel
        await asyncio.gather(*notification_methods, return_exceptions=True)
    
    async def _apply_sudo_rule(self, rule: SudoRule):
        """Apply sudo rule to system"""
        self.logger.info(f"Applying sudo rule for user {rule.user}")
        
        # Generate sudoers.d file content
        sudoers_content = self._generate_sudoers_content(rule)
        
        # Validate syntax
        if not self._validate_sudoers_syntax(sudoers_content):
            raise ValueError("Invalid sudoers syntax")
        
        # Write to sudoers.d
        rule_file = f"/etc/sudoers.d/90-managed-{rule.user}"
        
        # Use atomic write
        temp_file = f"{rule_file}.tmp"
        with open(temp_file, 'w') as f:
            f.write(sudoers_content)
        
        # Set proper permissions
        os.chmod(temp_file, 0o440)
        os.chown(temp_file, 0, 0)  # root:root
        
        # Validate again with visudo
        result = subprocess.run(
            ['visudo', '-c', '-f', temp_file],
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            os.unlink(temp_file)
            raise ValueError(f"Sudoers validation failed: {result.stderr}")
        
        # Move into place
        os.rename(temp_file, rule_file)
        
        # Schedule expiration if needed
        if rule.expires:
            await self._schedule_rule_expiration(rule)
    
    def _generate_sudoers_content(self, rule: SudoRule) -> str:
        """Generate sudoers file content from rule"""
        lines = []
        
        # Header
        lines.append(f"# Managed by Enterprise Sudo Manager")
        lines.append(f"# Rule ID: {rule.metadata.get('rule_id', 'unknown')}")
        lines.append(f"# Created: {datetime.now().isoformat()}")
        if rule.expires:
            lines.append(f"# Expires: {rule.expires.isoformat()}")
        if rule.comment:
            lines.append(f"# Comment: {rule.comment}")
        lines.append("")
        
        # Defaults for this user
        if rule.environment_vars:
            env_list = ','.join(rule.environment_vars)
            lines.append(f"Defaults:{rule.user} env_keep += \"{env_list}\"")
        
        if rule.mfa_required:
            lines.append(f"Defaults:{rule.user} authenticate")
        
        # Log all commands for audit
        lines.append(f"Defaults:{rule.user} log_output")
        lines.append(f"Defaults:{rule.user} log_input")
        lines.append("")
        
        # Main rule
        rule_line = f"{rule.user} {rule.host}="
        
        if rule.run_as_group:
            rule_line += f"({rule.run_as_user}:{rule.run_as_group}) "
        else:
            rule_line += f"({rule.run_as_user}) "
        
        if rule.tags:
            rule_line += ' '.join(rule.tags) + ': '
        
        rule_line += ', '.join(rule.commands)
        
        lines.append(rule_line)
        
        return '\n'.join(lines) + '\n'
    
    def _validate_sudoers_syntax(self, content: str) -> bool:
        """Validate sudoers syntax"""
        try:
            # Write to temporary file
            import tempfile
            with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
                f.write(content)
                temp_path = f.name
            
            # Validate with visudo
            result = subprocess.run(
                ['visudo', '-c', '-f', temp_path],
                capture_output=True
            )
            
            os.unlink(temp_path)
            
            return result.returncode == 0
            
        except Exception as e:
            self.logger.error(f"Syntax validation failed: {e}")
            return False
    
    async def _schedule_rule_expiration(self, rule: SudoRule):
        """Schedule automatic rule expiration"""
        if not rule.expires:
            return
        
        expiration_task = {
            'task_id': hashlib.sha256(
                f"expire-{rule.user}-{rule.expires.isoformat()}".encode()
            ).hexdigest()[:16],
            'action': 'expire_sudo_rule',
            'rule_id': rule.metadata.get('rule_id'),
            'user': rule.user,
            'execute_at': rule.expires.isoformat()
        }
        
        # Store in task queue
        self.redis_client.zadd(
            'sudo_expiration_tasks',
            {json.dumps(expiration_task): rule.expires.timestamp()}
        )
    
    def _store_rule(self, rule: SudoRule, rule_id: str):
        """Store rule in database"""
        session = self.db_session()
        try:
            db_rule = SudoRuleDB(
                rule_id=rule_id,
                user=rule.user,
                host=rule.host,
                run_as_user=rule.run_as_user,
                run_as_group=rule.run_as_group,
                commands=rule.commands,
                tags=rule.tags,
                environment_vars=rule.environment_vars,
                comment=rule.comment,
                expires_at=rule.expires,
                approval_required=rule.approval_required,
                mfa_required=rule.mfa_required,
                risk_score=rule.risk_score,
                metadata=rule.metadata
            )
            
            session.merge(db_rule)
            session.commit()
            
        finally:
            session.close()
    
    async def _audit_log(self, event: Dict[str, Any]):
        """Log audit event"""
        event['timestamp'] = datetime.now().isoformat()
        event['hostname'] = socket.gethostname()
        
        # Log to multiple destinations
        
        # Local audit log
        audit_logger = logging.getLogger('audit')
        audit_logger.info(json.dumps(event))
        
        # SIEM via syslog
        self.logger.info(f"AUDIT: {json.dumps(event)}", extra={'user': event.get('user', 'system')})
        
        # Database audit trail
        try:
            # Store in audit database
            self.redis_client.lpush(
                'audit_trail',
                json.dumps(event)
            )
            
            # Trim to last 1 million events
            self.redis_client.ltrim('audit_trail', 0, 999999)
            
        except Exception as e:
            self.logger.error(f"Failed to store audit event: {e}")
    
    async def authenticate_sudo(self,
                              username: str,
                              command: str,
                              auth_methods: List[AuthMethod]) -> Dict[str, Any]:
        """Authenticate user for sudo access"""
        self.logger.info(f"Authenticating sudo for user {username}")
        
        result = {
            'authenticated': False,
            'methods_tried': [],
            'session_token': None
        }
        
        # Try each authentication method
        for method in auth_methods:
            try:
                auth_result = await self._authenticate_method(username, method)
                result['methods_tried'].append(method.value)
                
                if auth_result['success']:
                    result['authenticated'] = True
                    result['session_token'] = self._create_session_token(
                        username, command
                    )
                    
                    self.auth_attempts.labels(
                        method=method.value,
                        result='success'
                    ).inc()
                    
                    break
                    
            except Exception as e:
                self.logger.error(f"Authentication method {method} failed: {e}")
                
            self.auth_attempts.labels(
                method=method.value,
                result='failure'
            ).inc()
        
        # Log authentication attempt
        await self._audit_log({
            'action': 'sudo_authentication',
            'user': username,
            'command': command,
            'success': result['authenticated'],
            'methods': result['methods_tried']
        })
        
        return result
    
    async def _authenticate_method(self,
                                 username: str,
                                 method: AuthMethod) -> Dict[str, Any]:
        """Authenticate using specific method"""
        if method == AuthMethod.PASSWORD:
            return await self._authenticate_password(username)
        elif method == AuthMethod.SSH_KEY:
            return await self._authenticate_ssh_key(username)
        elif method == AuthMethod.MFA_TOTP:
            return await self._authenticate_mfa_totp(username)
        elif method == AuthMethod.MFA_FIDO2:
            return await self._authenticate_fido2(username)
        elif method == AuthMethod.CERTIFICATE:
            return await self._authenticate_certificate(username)
        else:
            raise ValueError(f"Unsupported auth method: {method}")
    
    async def _authenticate_password(self, username: str) -> Dict[str, Any]:
        """Authenticate with password via PAM"""
        import getpass
        
        # Get password (in production, this would come from secure input)
        password = getpass.getpass(f"[sudo] password for {username}: ")
        
        # Authenticate via PAM
        p = pam.pam()
        if p.authenticate(username, password):
            return {'success': True}
        
        return {'success': False, 'error': 'Invalid password'}
    
    async def _authenticate_mfa_totp(self, username: str) -> Dict[str, Any]:
        """Authenticate with TOTP MFA"""
        # Get user's TOTP secret
        secret = await self._get_user_totp_secret(username)
        if not secret:
            return {'success': False, 'error': 'MFA not configured'}
        
        # Get TOTP code
        import getpass
        code = getpass.getpass("Enter MFA code: ")
        
        # Verify TOTP
        totp = pyotp.TOTP(secret)
        if totp.verify(code, valid_window=1):
            return {'success': True}
        
        return {'success': False, 'error': 'Invalid MFA code'}
    
    async def _get_user_totp_secret(self, username: str) -> Optional[str]:
        """Get user's TOTP secret"""
        # In production, this would be retrieved from secure storage
        secret_key = f"mfa_secret:{username}"
        encrypted_secret = self.redis_client.get(secret_key)
        
        if encrypted_secret:
            return self.encryption_key.decrypt(encrypted_secret.encode()).decode()
        
        return None
    
    def _create_session_token(self, username: str, command: str) -> str:
        """Create session token for authenticated sudo session"""
        payload = {
            'username': username,
            'command': command,
            'issued_at': datetime.now().isoformat(),
            'expires_at': (datetime.now() + timedelta(minutes=5)).isoformat(),
            'session_id': hashlib.sha256(
                f"{username}-{datetime.now().isoformat()}".encode()
            ).hexdigest()[:16]
        }
        
        # Sign token
        token = jwt.encode(
            payload,
            self.config['jwt_secret'],
            algorithm='HS256'
        )
        
        # Track active session
        self.active_sessions.labels(
            privilege_level='sudo'
        ).inc()
        
        return token


class SudoSessionManager:
    """Manage sudo sessions and command execution"""
    
    def __init__(self, sudo_manager: EnterpriseSudoManager):
        self.sudo_manager = sudo_manager
        self.logger = logging.getLogger(__name__)
    
    async def execute_command(self,
                            session_token: str,
                            command: str,
                            environment: Dict[str, str]) -> Dict[str, Any]:
        """Execute command in sudo context"""
        # Verify session token
        try:
            payload = jwt.decode(
                session_token,
                self.sudo_manager.config['jwt_secret'],
                algorithms=['HS256']
            )
        except jwt.InvalidTokenError:
            return {'success': False, 'error': 'Invalid session token'}
        
        # Check expiration
        if datetime.fromisoformat(payload['expires_at']) < datetime.now():
            return {'success': False, 'error': 'Session expired'}
        
        username = payload['username']
        
        # Create audit event
        audit_event = AuditEvent(
            timestamp=datetime.now(),
            user=username,
            effective_user='root',  # Or from sudo rule
            command=command,
            working_directory=os.getcwd(),
            session_id=payload['session_id'],
            tty=os.ttyname(0) if os.isatty(0) else None,
            environment=environment
        )
        
        # Log command start
        await self.sudo_manager._audit_log({
            'action': 'sudo_command_start',
            'user': username,
            'command': command,
            'session_id': payload['session_id']
        })
        
        # Execute command
        start_time = time.time()
        
        try:
            # In production, this would use proper privilege escalation
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                env=environment
            )
            
            audit_event.exit_code = result.returncode
            
            execution_time = time.time() - start_time
            self.sudo_manager.command_execution_time.observe(execution_time)
            
            # Log command completion
            await self.sudo_manager._audit_log({
                'action': 'sudo_command_complete',
                'user': username,
                'command': command,
                'session_id': payload['session_id'],
                'exit_code': result.returncode,
                'execution_time': execution_time
            })
            
            return {
                'success': True,
                'exit_code': result.returncode,
                'stdout': result.stdout,
                'stderr': result.stderr,
                'execution_time': execution_time
            }
            
        except Exception as e:
            self.logger.error(f"Command execution failed: {e}")
            
            await self.sudo_manager._audit_log({
                'action': 'sudo_command_error',
                'user': username,
                'command': command,
                'session_id': payload['session_id'],
                'error': str(e)
            })
            
            return {
                'success': False,
                'error': str(e)
            }


async def main():
    """Main execution function"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Enterprise Sudo Manager')
    parser.add_argument('--config', default='/etc/sudo-manager/config.yaml',
                       help='Configuration file path')
    parser.add_argument('--action', required=True,
                       choices=['create-rule', 'list-rules', 'approve', 'audit', 'validate'],
                       help='Action to perform')
    parser.add_argument('--user', help='Username for rule')
    parser.add_argument('--commands', nargs='+', help='Commands to allow')
    parser.add_argument('--expires', help='Expiration time (ISO format)')
    parser.add_argument('--reason', help='Reason for request')
    parser.add_argument('--request-id', help='Approval request ID')
    parser.add_argument('--output', default='json',
                       choices=['json', 'yaml', 'table'],
                       help='Output format')
    
    args = parser.parse_args()
    
    # Initialize manager
    manager = EnterpriseSudoManager(args.config)
    
    try:
        if args.action == 'create-rule':
            if not args.user or not args.commands:
                parser.error('--user and --commands required for create-rule')
            
            # Create rule
            rule = SudoRule(
                user=args.user,
                commands=args.commands,
                expires=datetime.fromisoformat(args.expires) if args.expires else None
            )
            
            result = await manager.create_sudo_rule(
                rule,
                os.getenv('USER', 'unknown'),
                args.reason or 'No reason provided'
            )
            
            print(json.dumps(result, indent=2))
        
        elif args.action == 'approve':
            if not args.request_id:
                parser.error('--request-id required for approve action')
            
            # This would implement approval logic
            print(f"Approving request {args.request_id}")
        
        elif args.action == 'audit':
            # Get recent audit events
            print("Recent sudo activity:")
            # Implementation would query audit logs
    
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
```

# [Enterprise Sudo Implementation](#enterprise-sudo-implementation)

## Production Deployment Guide

### Zero-Touch Sudo Configuration

```bash
#!/bin/bash
# enterprise-sudo-deploy.sh - Deploy enterprise sudo configuration

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="/etc/sudo-manager"
SUDOERS_DIR="/etc/sudoers.d"
LOG_DIR="/var/log/sudo-manager"

# Create directories
mkdir -p "$CONFIG_DIR" "$SUDOERS_DIR" "$LOG_DIR"

# Logging
LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE")
exec 2>&1

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
    exit 1
}

# Deploy base sudo configuration
deploy_base_config() {
    log "Deploying base sudo configuration"
    
    # Backup existing sudoers
    cp /etc/sudoers "/etc/sudoers.bak.$(date +%Y%m%d-%H%M%S)"
    
    # Create managed sudoers file
    cat > "$SUDOERS_DIR/00-enterprise-base" <<'EOF'
# Enterprise Sudo Base Configuration
# Managed by Enterprise Sudo Manager

# Reset environment by default
Defaults    env_reset
Defaults    env_keep =  "COLORS DISPLAY HOSTNAME HISTSIZE KDEDIR LS_COLORS"
Defaults    env_keep += "MAIL PS1 PS2 QTDIR USERNAME LANG LC_ADDRESS LC_CTYPE"
Defaults    env_keep += "LC_COLLATE LC_IDENTIFICATION LC_MEASUREMENT LC_MESSAGES"
Defaults    env_keep += "LC_MONETARY LC_NAME LC_NUMERIC LC_PAPER LC_TELEPHONE"
Defaults    env_keep += "LC_TIME LC_ALL LANGUAGE LINGUAS _XKB_CHARSET XAUTHORITY"

# Security settings
Defaults    requiretty
Defaults    !visiblepw
Defaults    always_set_home
Defaults    match_group_by_gid
Defaults    always_query_group_plugin

# Logging
Defaults    log_input
Defaults    log_output
Defaults    logfile="/var/log/sudo.log"
Defaults    syslog=auth
Defaults    syslog_goodpri=notice
Defaults    syslog_badpri=alert

# Time restrictions
Defaults    timestamp_timeout=5
Defaults    passwd_timeout=5
Defaults    passwd_tries=3

# Path restrictions
Defaults    secure_path = /sbin:/bin:/usr/sbin:/usr/bin:/usr/local/sbin:/usr/local/bin

# Lecture
Defaults    lecture="always"
Defaults    lecture_file="/etc/sudo-manager/lecture.txt"

# Mail settings
Defaults    mail_always
Defaults    mail_badpass
Defaults    mail_no_user
Defaults    mail_no_perms
Defaults    mailfrom="sudo-manager@example.com"
Defaults    mailto="security@example.com"

# Disable root sudo
root    ALL=(ALL) !ALL

# Include managed rules
#includedir /etc/sudoers.d
EOF
    
    # Set permissions
    chmod 0440 "$SUDOERS_DIR/00-enterprise-base"
    
    # Create lecture file
    cat > "$CONFIG_DIR/lecture.txt" <<'EOF'

###############################################################################
#                         PRIVILEGED ACCESS WARNING                           #
###############################################################################
#                                                                             #
# This system is for authorized use only. All sudo commands are logged and   #
# monitored. Unauthorized access attempts will be investigated and may        #
# result in prosecution.                                                      #
#                                                                             #
# By using sudo, you acknowledge that:                                        #
# - Your actions are being recorded                                           #
# - You are responsible for your commands                                     #
# - You must follow security policies                                         #
#                                                                             #
###############################################################################

EOF
    
    # Validate configuration
    visudo -c -f "$SUDOERS_DIR/00-enterprise-base" || error "Invalid sudo configuration"
}

# Configure PAM for sudo
configure_pam() {
    log "Configuring PAM for sudo"
    
    # Backup PAM config
    cp /etc/pam.d/sudo "/etc/pam.d/sudo.bak.$(date +%Y%m%d-%H%M%S)"
    
    # Create enhanced PAM configuration
    cat > /etc/pam.d/sudo <<'EOF'
#%PAM-1.0
# Enterprise sudo PAM configuration

# Authentication
auth       required     pam_env.so
auth       required     pam_faildelay.so delay=2000000
auth       required     pam_faillock.so preauth silent audit deny=3 unlock_time=900
auth       sufficient   pam_unix.so nullok try_first_pass
auth       requisite    pam_succeed_if.so uid >= 1000 quiet_success
auth       required     pam_faillock.so authfail audit deny=3 unlock_time=900
auth       required     pam_deny.so

# Account
account    required     pam_unix.so
account    sufficient   pam_localuser.so
account    sufficient   pam_succeed_if.so uid < 1000 quiet
account    required     pam_permit.so
account    required     pam_time.so

# Password
password   requisite    pam_pwquality.so retry=3 minlen=12 ucredit=-1 lcredit=-1 dcredit=-1 ocredit=-1
password   sufficient   pam_unix.so sha512 shadow nullok try_first_pass use_authtok remember=12
password   required     pam_deny.so

# Session
session    required     pam_limits.so
session    required     pam_unix.so
session    required     pam_lastlog.so showfailed
session    optional     pam_mail.so standard

# Audit
session    required     pam_tty_audit.so enable=*
EOF
    
    # Configure pam_time restrictions
    cat > /etc/security/time.conf <<'EOF'
# Time-based access restrictions for sudo
# service;ttys;users;times

# Restrict sudo during maintenance windows
sudo;*;*;!Wk0000-0600
EOF
    
    # Configure pam_access
    cat > /etc/security/access.conf <<'EOF'
# Access restrictions for sudo
# permission:users:origins

# Deny all by default
-:ALL:ALL

# Allow specific groups from specific locations
+:wheel:LOCAL
+:sudo-users:10.0.0.0/8
+:emergency-sudo:ALL
EOF
}

# Setup MFA for sudo
setup_mfa() {
    log "Setting up MFA for sudo"
    
    # Install Google Authenticator PAM module if not present
    if ! [ -f /lib64/security/pam_google_authenticator.so ]; then
        log "Installing Google Authenticator PAM module"
        yum install -y google-authenticator || apt-get install -y libpam-google-authenticator
    fi
    
    # Add MFA to sudo PAM config
    sed -i '/^auth.*pam_unix.so/a auth       required     pam_google_authenticator.so nullok' /etc/pam.d/sudo
    
    # Create MFA enforcement script
    cat > /usr/local/bin/enforce-sudo-mfa.sh <<'EOF'
#!/bin/bash
# Enforce MFA for sudo users

SUDO_USERS=$(getent group wheel | cut -d: -f4 | tr ',' ' ')

for user in $SUDO_USERS; do
    home=$(getent passwd "$user" | cut -d: -f6)
    if [ ! -f "$home/.google_authenticator" ]; then
        echo "User $user needs to set up MFA"
        # Send notification
        mail -s "MFA Setup Required" "$user@example.com" <<< "Please run 'google-authenticator' to set up MFA for sudo access."
    fi
done
EOF
    
    chmod +x /usr/local/bin/enforce-sudo-mfa.sh
    
    # Add to cron
    echo "0 9 * * * root /usr/local/bin/enforce-sudo-mfa.sh" > /etc/cron.d/enforce-sudo-mfa
}

# Configure sudo logging
configure_logging() {
    log "Configuring sudo logging"
    
    # Create log directory
    mkdir -p /var/log/sudo-io
    chmod 700 /var/log/sudo-io
    
    # Configure rsyslog for sudo
    cat > /etc/rsyslog.d/49-sudo.conf <<'EOF'
# Enterprise sudo logging configuration

# Log sudo commands
:programname, isequal, "sudo" /var/log/sudo.log
& stop

# Log authentication
auth,authpriv.*  /var/log/sudo-auth.log

# Forward to SIEM
*.* @@siem.example.com:514
EOF
    
    # Configure logrotate
    cat > /etc/logrotate.d/sudo <<'EOF'
/var/log/sudo.log
/var/log/sudo-auth.log
{
    daily
    rotate 365
    compress
    delaycompress
    missingok
    notifempty
    create 0600 root root
    sharedscripts
    postrotate
        /bin/kill -HUP `cat /var/run/rsyslogd.pid 2> /dev/null` 2> /dev/null || true
    endscript
}
EOF
    
    # Restart rsyslog
    systemctl restart rsyslog
}

# Setup audit rules
setup_audit() {
    log "Setting up audit rules for sudo"
    
    # Add audit rules
    cat >> /etc/audit/rules.d/sudo.rules <<'EOF'
# Sudo execution monitoring
-a always,exit -F path=/usr/bin/sudo -F perm=x -F auid>=1000 -F auid!=4294967295 -k sudo_exec

# Sudoers file monitoring
-w /etc/sudoers -p wa -k sudoers_changes
-w /etc/sudoers.d/ -p wa -k sudoers_changes

# Sudo log monitoring
-w /var/log/sudo.log -p wa -k sudo_log_changes
EOF
    
    # Reload audit rules
    augenrules --load
    systemctl restart auditd
}

# Configure SELinux for sudo
configure_selinux() {
    log "Configuring SELinux for sudo"
    
    if ! command -v getenforce &> /dev/null; then
        log "SELinux not installed, skipping"
        return
    fi
    
    if [ "$(getenforce)" = "Disabled" ]; then
        log "SELinux is disabled, skipping"
        return
    fi
    
    # Create custom SELinux policy
    cat > /tmp/sudo-manager.te <<'EOF'
module sudo-manager 1.0;

require {
    type sudo_exec_t;
    type admin_home_t;
    type user_t;
    class file { read write execute };
    class capability { setuid setgid };
}

# Allow sudo manager operations
allow user_t sudo_exec_t:file { read execute };
EOF
    
    # Compile and install policy
    cd /tmp
    checkmodule -M -m -o sudo-manager.mod sudo-manager.te
    semodule_package -o sudo-manager.pp -m sudo-manager.mod
    semodule -i sudo-manager.pp
    
    # Set contexts
    restorecon -Rv /etc/sudoers.d/
    restorecon -Rv "$CONFIG_DIR"
}

# Install monitoring
install_monitoring() {
    log "Installing sudo monitoring"
    
    # Create monitoring script
    cat > /usr/local/bin/sudo-monitor.py <<'EOF'
#!/usr/bin/env python3
"""
Real-time sudo monitoring
"""

import time
import re
import subprocess
from datetime import datetime

def monitor_sudo_log():
    """Monitor sudo log in real-time"""
    
    # Patterns to watch for
    patterns = {
        'auth_failure': re.compile(r'authentication failure'),
        'command_exec': re.compile(r'COMMAND=(.*)'),
        'session_open': re.compile(r'session opened'),
        'session_close': re.compile(r'session closed'),
        'not_in_sudoers': re.compile(r'NOT in sudoers')
    }
    
    # Tail sudo log
    proc = subprocess.Popen(
        ['tail', '-F', '/var/log/sudo.log'],
        stdout=subprocess.PIPE,
        universal_newlines=True
    )
    
    for line in proc.stdout:
        timestamp = datetime.now().isoformat()
        
        for event_type, pattern in patterns.items():
            match = pattern.search(line)
            if match:
                print(f"[{timestamp}] {event_type}: {line.strip()}")
                
                # Alert on critical events
                if event_type in ['auth_failure', 'not_in_sudoers']:
                    alert(event_type, line)

def alert(event_type, message):
    """Send alert for critical events"""
    # In production, this would send to monitoring system
    print(f"ALERT: {event_type} - {message}")

if __name__ == '__main__':
    monitor_sudo_log()
EOF
    
    chmod +x /usr/local/bin/sudo-monitor.py
    
    # Create systemd service
    cat > /etc/systemd/system/sudo-monitor.service <<'EOF'
[Unit]
Description=Sudo real-time monitoring
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/sudo-monitor.py
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF
    
    systemctl daemon-reload
    systemctl enable sudo-monitor.service
    systemctl start sudo-monitor.service
}

# Create emergency break-glass procedure
create_break_glass() {
    log "Creating emergency break-glass procedure"
    
    # Generate emergency access credentials
    EMERGENCY_USER="emergency-sudo"
    EMERGENCY_PASS=$(openssl rand -base64 32)
    
    # Create emergency user
    useradd -r -s /bin/bash -G wheel "$EMERGENCY_USER"
    echo "$EMERGENCY_USER:$EMERGENCY_PASS" | chpasswd
    
    # Create break-glass sudo rule
    cat > "$SUDOERS_DIR/99-break-glass" <<EOF
# Emergency Break-Glass Access
# This file should only be used in emergencies

# Require authentication and logging
Defaults:$EMERGENCY_USER    authenticate
Defaults:$EMERGENCY_USER    log_input
Defaults:$EMERGENCY_USER    log_output
Defaults:$EMERGENCY_USER    mail_always
Defaults:$EMERGENCY_USER    mailto="security@example.com"

# Full access with time limit
$EMERGENCY_USER    ALL=(ALL) ALL
EOF
    
    chmod 0440 "$SUDOERS_DIR/99-break-glass"
    
    # Store credentials securely
    cat > "$CONFIG_DIR/break-glass-credentials.txt" <<EOF
Emergency Break-Glass Credentials
Generated: $(date)

Username: $EMERGENCY_USER
Password: $EMERGENCY_PASS

These credentials should be stored in a secure location (safe, password manager)
and only used in emergency situations when normal access methods fail.

After use:
1. Change the password immediately
2. Review all commands executed
3. Document the emergency and actions taken
4. Reset credentials
EOF
    
    chmod 0400 "$CONFIG_DIR/break-glass-credentials.txt"
    
    log "Break-glass credentials saved to $CONFIG_DIR/break-glass-credentials.txt"
    log "SECURE THESE CREDENTIALS IMMEDIATELY!"
}

# Main deployment
main() {
    log "Starting enterprise sudo deployment"
    
    # Check prerequisites
    if [[ $EUID -ne 0 ]]; then
        error "This script must be run as root"
    fi
    
    # Deploy components
    deploy_base_config
    configure_pam
    setup_mfa
    configure_logging
    setup_audit
    configure_selinux
    install_monitoring
    create_break_glass
    
    # Validate final configuration
    log "Validating configuration..."
    visudo -c || error "Sudo configuration validation failed"
    
    log "Enterprise sudo deployment completed successfully"
    log "Remember to:"
    log "  1. Secure break-glass credentials"
    log "  2. Configure SIEM integration"
    log "  3. Test MFA authentication"
    log "  4. Review audit logging"
}

# Execute main deployment
main "$@"
```

## Security Monitoring Dashboard

### Grafana Dashboard for Sudo Monitoring

```json
{
  "dashboard": {
    "title": "Enterprise Sudo Security Monitoring",
    "uid": "sudo-security-dashboard",
    "panels": [
      {
        "title": "Privilege Escalation Events",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
        "targets": [
          {
            "expr": "rate(sudo_privilege_requests_total[5m])",
            "legendFormat": "{{user}} - {{level}}"
          }
        ]
      },
      {
        "title": "Authentication Methods",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
        "type": "piechart",
        "targets": [
          {
            "expr": "sum by(method) (rate(sudo_auth_attempts_total[1h]))",
            "legendFormat": "{{method}}"
          }
        ]
      },
      {
        "title": "Failed Authentication Attempts",
        "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
        "targets": [
          {
            "expr": "sudo_auth_attempts_total{result=\"failure\"}",
            "legendFormat": "{{method}} - Failed"
          }
        ],
        "alert": {
          "conditions": [
            {
              "evaluator": {"params": [5], "type": "gt"},
              "operator": {"type": "and"},
              "query": {"params": ["A", "5m", "now"]},
              "reducer": {"params": [], "type": "sum"},
              "type": "query"
            }
          ],
          "name": "High Failed Auth Rate"
        }
      },
      {
        "title": "Active Privileged Sessions",
        "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
        "targets": [
          {
            "expr": "sudo_active_sessions",
            "legendFormat": "{{privilege_level}}"
          }
        ]
      }
    ]
  }
}
```

## Security Best Practices

### 1. Principle of Least Privilege
- Grant minimal necessary permissions
- Use time-bound access
- Implement just-in-time privileges
- Regular permission reviews
- Automated de-provisioning

### 2. Strong Authentication
- Enforce MFA for all sudo access
- Use certificate-based authentication
- Implement risk-based authentication
- Session timeout configuration
- Biometric authentication where possible

### 3. Comprehensive Auditing
- Log all sudo commands
- Real-time alerting
- Immutable audit trails
- Regular audit reviews
- Automated anomaly detection

### 4. Access Control
- Role-based access control (RBAC)
- Attribute-based access control (ABAC)
- Context-aware policies
- Separation of duties
- Emergency access procedures

### 5. Continuous Monitoring
- Real-time session monitoring
- Behavioral analytics
- Threat detection
- Compliance reporting
- Security metrics tracking

## Troubleshooting Common Issues

### Authentication Failures

```bash
#!/bin/bash
# diagnose-sudo-auth.sh - Diagnose sudo authentication issues

echo "=== Sudo Authentication Diagnosis ==="

# Check PAM configuration
echo "PAM Configuration:"
grep -v '^#' /etc/pam.d/sudo | grep -v '^$'
echo

# Check user groups
echo "User Groups:"
id
echo

# Check sudoers syntax
echo "Sudoers Validation:"
sudo -l
echo

# Check PAM modules
echo "PAM Modules:"
for module in $(grep -o 'pam_[^.]*\.so' /etc/pam.d/sudo | sort -u); do
    echo -n "$module: "
    if [ -f "/lib64/security/$module" ] || [ -f "/lib/x86_64-linux-gnu/security/$module" ]; then
        echo "FOUND"
    else
        echo "MISSING"
    fi
done
echo

# Check SELinux context
if command -v getenforce &> /dev/null && [ "$(getenforce)" != "Disabled" ]; then
    echo "SELinux Context:"
    ls -Z /usr/bin/sudo
    id -Z
fi
```

### Permission Denied

```bash
#!/bin/bash
# fix-sudo-permissions.sh - Fix common sudo permission issues

# Fix sudoers.d permissions
find /etc/sudoers.d -type f -exec chmod 0440 {} \;
find /etc/sudoers.d -type f -exec chown root:root {} \;

# Fix sudo binary permissions
chmod 4755 /usr/bin/sudo
chown root:root /usr/bin/sudo

# Validate all sudoers files
for file in /etc/sudoers /etc/sudoers.d/*; do
    if [ -f "$file" ]; then
        echo "Validating: $file"
        visudo -c -f "$file" || echo "INVALID: $file"
    fi
done

# Clear sudo cache
sudo -k

# Test sudo access
sudo -v && echo "Sudo access restored" || echo "Still having issues"
```

## Conclusion

Enterprise sudo and privilege management requires comprehensive security frameworks that implement zero-trust principles, multi-factor authentication, and complete audit trails while maintaining operational efficiency. By deploying advanced sudo configurations, automated approval workflows, and continuous monitoring systems, organizations can ensure secure privilege escalation across thousands of systems while meeting compliance requirements and maintaining emergency access capabilities.

The combination of policy-based access control, risk assessment, behavioral analytics, and automated enforcement provides the foundation for modern privilege management in enterprise environments, enabling organizations to balance security requirements with operational needs while maintaining complete visibility and control over privileged access.