---
title: "Enterprise Linux Server Security: Comprehensive Hardening and Advanced Security Automation for Production Infrastructure"
date: 2025-05-06T10:00:00-05:00
draft: false
tags: ["Linux Security", "Server Hardening", "Enterprise Security", "SSH Security", "Fail2ban", "Firewall", "Security Automation", "Compliance", "SIEM", "Zero Trust"]
categories:
- Security
- Linux Administration
- Enterprise Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to Linux server security hardening, advanced threat protection, automated security frameworks, compliance management, and production-grade security operations for critical infrastructure"
more_link: "yes"
url: "/enterprise-linux-server-security-comprehensive-hardening-guide/"
---

Enterprise Linux server security requires comprehensive hardening strategies, advanced threat detection systems, and automated security frameworks that protect critical infrastructure while maintaining operational efficiency. This guide covers multi-layered security architectures, enterprise-grade hardening procedures, automated threat response systems, and compliance frameworks for production environments.

<!--more-->

# [Enterprise Security Architecture Framework](#enterprise-security-architecture-framework)

## Multi-Layered Security Strategy

Enterprise Linux security implementation demands comprehensive defense-in-depth strategies that address threats at every infrastructure layer while maintaining system performance and operational accessibility.

### Enterprise Security Stack Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Enterprise Security Layers                   │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│  Application    │  Network        │  System         │ Physical  │
│  Security       │  Security       │  Security       │ Security  │
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ WAF/Proxy   │ │ │ Firewalls   │ │ │ OS Hardening│ │ │ HSM   │ │
│ │ Rate Limits │ │ │ IDS/IPS     │ │ │ MAC/RBAC    │ │ │ Secure│ │
│ │ Input Valid │ │ │ VPN/Zero    │ │ │ Audit Trail │ │ │ Boot  │ │
│ │ Auth/AuthZ  │ │ │ Trust       │ │ │ Encryption  │ │ │ TPM   │ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • OWASP Top 10  │ • Zero Trust    │ • CIS Controls  │ • FIPS    │
│ • API Security  │ • Micro-seg     │ • STIGs         │ • CC      │
│ • DevSecOps     │ • SDN Security  │ • Benchmarks    │ • Certs   │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Security Implementation Maturity Model

| Level | Focus | Automation | Compliance | Threat Response |
|-------|-------|------------|------------|-----------------|
| **Basic** | Core hardening | Manual | Minimal | Reactive |
| **Intermediate** | Threat detection | Scripted | Framework | Responsive |
| **Advanced** | Integrated defense | Orchestrated | Continuous | Predictive |
| **Expert** | Zero trust | AI/ML driven | Real-time | Autonomous |

## Enterprise Security Policy Framework

### Comprehensive Security Configuration System

```python
#!/usr/bin/env python3
"""
Enterprise Linux Security Configuration and Hardening Framework
"""

import subprocess
import json
import logging
import os
import time
import hashlib
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, asdict
from pathlib import Path
import yaml
import re

@dataclass
class SecurityPolicy:
    name: str
    category: str
    severity: str  # CRITICAL, HIGH, MEDIUM, LOW
    description: str
    implementation: str
    validation: str
    remediation: str
    compliance_frameworks: List[str]
    enabled: bool = True

@dataclass
class ComplianceFramework:
    name: str
    version: str
    controls: List[str]
    description: str
    mandatory_policies: List[str]
    optional_policies: List[str]

@dataclass
class SecurityBaseline:
    name: str
    version: str
    policies: List[str]
    frameworks: List[str]
    environment_type: str  # production, staging, development
    risk_level: str  # high, medium, low

class EnterpriseSecurityManager:
    def __init__(self, config_file: str = "/etc/security/enterprise-config.yaml"):
        self.config_file = Path(config_file)
        self.policies: Dict[str, SecurityPolicy] = {}
        self.frameworks: Dict[str, ComplianceFramework] = {}
        self.baselines: Dict[str, SecurityBaseline] = {}
        
        self.logger = self._setup_logging()
        self.results_cache = {}
        
        self._load_configuration()
        self._load_default_policies()
    
    def _setup_logging(self) -> logging.Logger:
        """Setup comprehensive security logging"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        # Security audit log
        audit_handler = logging.FileHandler('/var/log/security/enterprise-audit.log')
        audit_formatter = logging.Formatter(
            '%(asctime)s - SECURITY-AUDIT - %(levelname)s - %(message)s'
        )
        audit_handler.setFormatter(audit_formatter)
        
        # SIEM-compatible handler
        siem_handler = logging.handlers.SysLogHandler()
        siem_formatter = logging.Formatter(
            'ENTERPRISE-SEC[%(process)d]: %(levelname)s - %(message)s'
        )
        siem_handler.setFormatter(siem_formatter)
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_formatter = logging.Formatter('%(levelname)s: %(message)s')
        console_handler.setFormatter(console_formatter)
        
        logger.addHandler(audit_handler)
        logger.addHandler(siem_handler)
        logger.addHandler(console_handler)
        
        return logger
    
    def _load_configuration(self) -> None:
        """Load enterprise security configuration"""
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r') as f:
                    config = yaml.safe_load(f)
                
                # Load policies
                for policy_data in config.get('policies', []):
                    policy = SecurityPolicy(**policy_data)
                    self.policies[policy.name] = policy
                
                # Load frameworks
                for framework_data in config.get('frameworks', []):
                    framework = ComplianceFramework(**framework_data)
                    self.frameworks[framework.name] = framework
                
                # Load baselines
                for baseline_data in config.get('baselines', []):
                    baseline = SecurityBaseline(**baseline_data)
                    self.baselines[baseline.name] = baseline
                
                self.logger.info(f"Loaded {len(self.policies)} security policies")
                
            except Exception as e:
                self.logger.error(f"Failed to load configuration: {e}")
    
    def _load_default_policies(self) -> None:
        """Load default enterprise security policies"""
        default_policies = [
            SecurityPolicy(
                name="ssh_key_only_auth",
                category="authentication",
                severity="CRITICAL",
                description="Enforce SSH key-only authentication",
                implementation="disable_ssh_password_auth",
                validation="check_ssh_password_disabled",
                remediation="configure_ssh_key_auth",
                compliance_frameworks=["CIS", "NIST", "STIG"]
            ),
            SecurityPolicy(
                name="ssh_protocol_v2",
                category="network",
                severity="HIGH",
                description="Enforce SSH Protocol version 2",
                implementation="set_ssh_protocol_v2",
                validation="check_ssh_protocol",
                remediation="update_ssh_config",
                compliance_frameworks=["CIS", "STIG"]
            ),
            SecurityPolicy(
                name="disable_root_ssh",
                category="authentication",
                severity="CRITICAL",
                description="Disable direct root SSH access",
                implementation="disable_root_ssh_login",
                validation="check_root_ssh_disabled",
                remediation="configure_sudo_access",
                compliance_frameworks=["CIS", "NIST", "STIG", "PCI-DSS"]
            ),
            SecurityPolicy(
                name="fail2ban_protection",
                category="intrusion_prevention",
                severity="HIGH",
                description="Configure fail2ban for brute force protection",
                implementation="install_configure_fail2ban",
                validation="check_fail2ban_status",
                remediation="restart_fail2ban_service",
                compliance_frameworks=["CIS", "NIST"]
            ),
            SecurityPolicy(
                name="firewall_default_deny",
                category="network",
                severity="CRITICAL",
                description="Configure firewall with default deny policy",
                implementation="configure_firewall_deny_default",
                validation="check_firewall_default_policy",
                remediation="reconfigure_firewall",
                compliance_frameworks=["CIS", "NIST", "STIG"]
            ),
            SecurityPolicy(
                name="kernel_hardening",
                category="system",
                severity="HIGH",
                description="Apply kernel security hardening parameters",
                implementation="configure_kernel_hardening",
                validation="check_kernel_parameters",
                remediation="apply_sysctl_hardening",
                compliance_frameworks=["CIS", "STIG"]
            ),
            SecurityPolicy(
                name="audit_logging",
                category="logging",
                severity="CRITICAL",
                description="Configure comprehensive audit logging",
                implementation="configure_auditd",
                validation="check_audit_rules",
                remediation="restart_auditd_service",
                compliance_frameworks=["CIS", "NIST", "STIG", "SOX", "HIPAA"]
            ),
            SecurityPolicy(
                name="file_permissions",
                category="access_control",
                severity="HIGH",
                description="Secure critical system file permissions",
                implementation="secure_file_permissions",
                validation="check_file_permissions",
                remediation="fix_file_permissions",
                compliance_frameworks=["CIS", "STIG"]
            ),
            SecurityPolicy(
                name="remove_unnecessary_services",
                category="attack_surface",
                severity="MEDIUM",
                description="Remove or disable unnecessary services",
                implementation="disable_unnecessary_services",
                validation="check_running_services",
                remediation="stop_disable_services",
                compliance_frameworks=["CIS", "NIST", "STIG"]
            ),
            SecurityPolicy(
                name="password_policy",
                category="authentication",
                severity="HIGH",
                description="Enforce strong password policies",
                implementation="configure_password_policy",
                validation="check_password_requirements",
                remediation="update_pam_configuration",
                compliance_frameworks=["CIS", "NIST", "STIG", "PCI-DSS"]
            )
        ]
        
        for policy in default_policies:
            if policy.name not in self.policies:
                self.policies[policy.name] = policy
    
    def implement_policy(self, policy_name: str) -> bool:
        """Implement a specific security policy"""
        if policy_name not in self.policies:
            self.logger.error(f"Policy {policy_name} not found")
            return False
        
        policy = self.policies[policy_name]
        
        if not policy.enabled:
            self.logger.info(f"Policy {policy_name} is disabled, skipping")
            return True
        
        self.logger.info(f"Implementing security policy: {policy_name}")
        
        try:
            # Execute implementation method
            implementation_method = getattr(self, policy.implementation, None)
            if implementation_method and callable(implementation_method):
                result = implementation_method()
                
                if result:
                    self.logger.info(f"Successfully implemented policy: {policy_name}")
                    
                    # Validate implementation
                    if self.validate_policy(policy_name):
                        self.logger.info(f"Policy validation passed: {policy_name}")
                        return True
                    else:
                        self.logger.warning(f"Policy validation failed: {policy_name}")
                        return False
                else:
                    self.logger.error(f"Failed to implement policy: {policy_name}")
                    return False
            else:
                self.logger.error(f"Implementation method not found: {policy.implementation}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error implementing policy {policy_name}: {e}")
            return False
    
    def validate_policy(self, policy_name: str) -> bool:
        """Validate if a security policy is properly implemented"""
        if policy_name not in self.policies:
            return False
        
        policy = self.policies[policy_name]
        
        try:
            validation_method = getattr(self, policy.validation, None)
            if validation_method and callable(validation_method):
                return validation_method()
            else:
                self.logger.error(f"Validation method not found: {policy.validation}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error validating policy {policy_name}: {e}")
            return False
    
    def remediate_policy(self, policy_name: str) -> bool:
        """Remediate a failed security policy"""
        if policy_name not in self.policies:
            return False
        
        policy = self.policies[policy_name]
        
        try:
            remediation_method = getattr(self, policy.remediation, None)
            if remediation_method and callable(remediation_method):
                result = remediation_method()
                self.logger.info(f"Remediation completed for policy: {policy_name}")
                return result
            else:
                self.logger.error(f"Remediation method not found: {policy.remediation}")
                return False
                
        except Exception as e:
            self.logger.error(f"Error remediating policy {policy_name}: {e}")
            return False
    
    # SSH Security Implementation Methods
    def disable_ssh_password_auth(self) -> bool:
        """Disable SSH password authentication"""
        ssh_config = "/etc/ssh/sshd_config"
        backup_file = f"{ssh_config}.backup.{int(time.time())}"
        
        try:
            # Backup original configuration
            subprocess.run(['cp', ssh_config, backup_file], check=True)
            
            # Read current configuration
            with open(ssh_config, 'r') as f:
                content = f.read()
            
            # Update configuration
            updated_content = self._update_ssh_config(content, {
                'PasswordAuthentication': 'no',
                'ChallengeResponseAuthentication': 'no',
                'PubkeyAuthentication': 'yes',
                'AuthenticationMethods': 'publickey'
            })
            
            # Write updated configuration
            with open(ssh_config, 'w') as f:
                f.write(updated_content)
            
            # Validate configuration
            result = subprocess.run(['sshd', '-t'], capture_output=True, text=True)
            if result.returncode != 0:
                # Restore backup on validation failure
                subprocess.run(['cp', backup_file, ssh_config], check=True)
                self.logger.error(f"SSH configuration validation failed: {result.stderr}")
                return False
            
            # Restart SSH service
            subprocess.run(['systemctl', 'restart', 'sshd'], check=True)
            
            self.logger.info("SSH password authentication disabled successfully")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to disable SSH password authentication: {e}")
            return False
    
    def disable_root_ssh_login(self) -> bool:
        """Disable direct root SSH login"""
        ssh_config = "/etc/ssh/sshd_config"
        backup_file = f"{ssh_config}.backup.{int(time.time())}"
        
        try:
            subprocess.run(['cp', ssh_config, backup_file], check=True)
            
            with open(ssh_config, 'r') as f:
                content = f.read()
            
            updated_content = self._update_ssh_config(content, {
                'PermitRootLogin': 'no',
                'AllowUsers': self._get_non_root_users()
            })
            
            with open(ssh_config, 'w') as f:
                f.write(updated_content)
            
            # Validate and restart
            result = subprocess.run(['sshd', '-t'], capture_output=True, text=True)
            if result.returncode != 0:
                subprocess.run(['cp', backup_file, ssh_config], check=True)
                return False
            
            subprocess.run(['systemctl', 'restart', 'sshd'], check=True)
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to disable root SSH login: {e}")
            return False
    
    def set_ssh_protocol_v2(self) -> bool:
        """Enforce SSH Protocol version 2"""
        ssh_config = "/etc/ssh/sshd_config"
        
        try:
            with open(ssh_config, 'r') as f:
                content = f.read()
            
            updated_content = self._update_ssh_config(content, {
                'Protocol': '2'
            })
            
            with open(ssh_config, 'w') as f:
                f.write(updated_content)
            
            subprocess.run(['systemctl', 'restart', 'sshd'], check=True)
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to set SSH protocol v2: {e}")
            return False
    
    def _update_ssh_config(self, content: str, settings: Dict[str, str]) -> str:
        """Update SSH configuration content with new settings"""
        lines = content.split('\n')
        updated_lines = []
        processed_settings = set()
        
        for line in lines:
            line = line.strip()
            if not line or line.startswith('#'):
                updated_lines.append(line)
                continue
            
            # Check if this line sets one of our target settings
            for setting, value in settings.items():
                if line.lower().startswith(setting.lower()):
                    updated_lines.append(f"{setting} {value}")
                    processed_settings.add(setting)
                    break
            else:
                updated_lines.append(line)
        
        # Add any settings that weren't already in the file
        for setting, value in settings.items():
            if setting not in processed_settings:
                updated_lines.append(f"{setting} {value}")
        
        return '\n'.join(updated_lines)
    
    def _get_non_root_users(self) -> str:
        """Get list of non-root users for SSH AllowUsers"""
        try:
            # Get users with UID >= 1000 (regular users)
            result = subprocess.run(['awk', '-F:', '$3>=1000 {print $1}', '/etc/passwd'], 
                                  capture_output=True, text=True)
            users = result.stdout.strip().split('\n')
            users = [u for u in users if u and u != 'nobody']
            
            if users:
                return ' '.join(users[:5])  # Limit to first 5 users
            else:
                return 'admin'  # Fallback
                
        except Exception:
            return 'admin'
    
    # Fail2ban Implementation
    def install_configure_fail2ban(self) -> bool:
        """Install and configure fail2ban"""
        try:
            # Install fail2ban
            if self._is_debian_based():
                subprocess.run(['apt', 'update'], check=True)
                subprocess.run(['apt', 'install', '-y', 'fail2ban'], check=True)
            elif self._is_rhel_based():
                subprocess.run(['dnf', 'install', '-y', 'epel-release'], check=True)
                subprocess.run(['dnf', 'install', '-y', 'fail2ban'], check=True)
            
            # Configure fail2ban
            self._configure_fail2ban()
            
            # Start and enable service
            subprocess.run(['systemctl', 'enable', 'fail2ban'], check=True)
            subprocess.run(['systemctl', 'start', 'fail2ban'], check=True)
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to install/configure fail2ban: {e}")
            return False
    
    def _configure_fail2ban(self) -> None:
        """Configure fail2ban with enterprise settings"""
        config_dir = Path('/etc/fail2ban')
        
        # Create local configuration
        jail_local = config_dir / 'jail.local'
        
        jail_config = """
[DEFAULT]
# Ban IP for 1 hour
bantime = 3600
# Find failure in 10 minutes
findtime = 600
# Max retries before ban
maxretry = 3
# Ignore local IPs
ignoreip = 127.0.0.1/8 ::1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16

# Email notifications
destemail = security@company.com
sendername = Fail2Ban-Security
mta = sendmail
action = %(action_mwl)s

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600

[sshd-ddos]
enabled = true
port = ssh
filter = sshd-ddos
logpath = /var/log/auth.log
maxretry = 2
bantime = 7200

[apache-auth]
enabled = true
port = http,https
filter = apache-auth
logpath = /var/log/apache*/*error.log
maxretry = 3

[apache-badbots]
enabled = true
port = http,https
filter = apache-badbots
logpath = /var/log/apache*/*access.log
maxretry = 2

[apache-noscript]
enabled = true
port = http,https
filter = apache-noscript
logpath = /var/log/apache*/*access.log
maxretry = 3
"""
        
        with open(jail_local, 'w') as f:
            f.write(jail_config)
    
    # Firewall Configuration
    def configure_firewall_deny_default(self) -> bool:
        """Configure firewall with default deny policy"""
        try:
            if self._command_exists('ufw'):
                return self._configure_ufw()
            elif self._command_exists('firewall-cmd'):
                return self._configure_firewalld()
            else:
                return self._configure_iptables()
                
        except Exception as e:
            self.logger.error(f"Failed to configure firewall: {e}")
            return False
    
    def _configure_ufw(self) -> bool:
        """Configure UFW firewall"""
        try:
            # Reset UFW
            subprocess.run(['ufw', '--force', 'reset'], check=True)
            
            # Set default policies
            subprocess.run(['ufw', 'default', 'deny', 'incoming'], check=True)
            subprocess.run(['ufw', 'default', 'allow', 'outgoing'], check=True)
            
            # Allow SSH
            ssh_port = self._get_ssh_port()
            subprocess.run(['ufw', 'allow', str(ssh_port)], check=True)
            
            # Allow common services
            common_services = ['80', '443']
            for service in common_services:
                subprocess.run(['ufw', 'allow', service], check=True)
            
            # Enable UFW
            subprocess.run(['ufw', '--force', 'enable'], check=True)
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to configure UFW: {e}")
            return False
    
    def _configure_firewalld(self) -> bool:
        """Configure firewalld"""
        try:
            # Start firewalld
            subprocess.run(['systemctl', 'enable', 'firewalld'], check=True)
            subprocess.run(['systemctl', 'start', 'firewalld'], check=True)
            
            # Set default zone
            subprocess.run(['firewall-cmd', '--set-default-zone=public'], check=True)
            
            # Remove all services from public zone
            result = subprocess.run(['firewall-cmd', '--zone=public', '--list-services'], 
                                  capture_output=True, text=True)
            services = result.stdout.strip().split()
            
            for service in services:
                subprocess.run(['firewall-cmd', '--zone=public', '--remove-service', service, '--permanent'], 
                             check=True)
            
            # Add SSH
            ssh_port = self._get_ssh_port()
            subprocess.run(['firewall-cmd', '--zone=public', '--add-port', f'{ssh_port}/tcp', '--permanent'], 
                         check=True)
            
            # Add HTTP/HTTPS
            subprocess.run(['firewall-cmd', '--zone=public', '--add-service', 'http', '--permanent'], 
                         check=True)
            subprocess.run(['firewall-cmd', '--zone=public', '--add-service', 'https', '--permanent'], 
                         check=True)
            
            # Reload configuration
            subprocess.run(['firewall-cmd', '--reload'], check=True)
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to configure firewalld: {e}")
            return False
    
    def _configure_iptables(self) -> bool:
        """Configure iptables"""
        try:
            # Flush existing rules
            subprocess.run(['iptables', '-F'], check=True)
            subprocess.run(['iptables', '-X'], check=True)
            subprocess.run(['iptables', '-t', 'nat', '-F'], check=True)
            subprocess.run(['iptables', '-t', 'nat', '-X'], check=True)
            
            # Set default policies
            subprocess.run(['iptables', '-P', 'INPUT', 'DROP'], check=True)
            subprocess.run(['iptables', '-P', 'FORWARD', 'DROP'], check=True)
            subprocess.run(['iptables', '-P', 'OUTPUT', 'ACCEPT'], check=True)
            
            # Allow loopback
            subprocess.run(['iptables', '-A', 'INPUT', '-i', 'lo', '-j', 'ACCEPT'], check=True)
            
            # Allow established connections
            subprocess.run(['iptables', '-A', 'INPUT', '-m', 'conntrack', '--ctstate', 
                          'ESTABLISHED,RELATED', '-j', 'ACCEPT'], check=True)
            
            # Allow SSH
            ssh_port = self._get_ssh_port()
            subprocess.run(['iptables', '-A', 'INPUT', '-p', 'tcp', '--dport', str(ssh_port), 
                          '-j', 'ACCEPT'], check=True)
            
            # Allow HTTP/HTTPS
            subprocess.run(['iptables', '-A', 'INPUT', '-p', 'tcp', '--dport', '80', '-j', 'ACCEPT'], 
                         check=True)
            subprocess.run(['iptables', '-A', 'INPUT', '-p', 'tcp', '--dport', '443', '-j', 'ACCEPT'], 
                         check=True)
            
            # Save rules
            if self._is_debian_based():
                subprocess.run(['iptables-save'], check=True, 
                             stdout=open('/etc/iptables/rules.v4', 'w'))
            elif self._is_rhel_based():
                subprocess.run(['iptables-save'], check=True, 
                             stdout=open('/etc/sysconfig/iptables', 'w'))
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to configure iptables: {e}")
            return False
    
    # Kernel Hardening
    def configure_kernel_hardening(self) -> bool:
        """Apply kernel security hardening parameters"""
        try:
            sysctl_config = """
# Kernel Security Hardening Configuration
# Disable IP forwarding
net.ipv4.ip_forward = 0
net.ipv6.conf.all.forwarding = 0

# Disable IP source routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0

# Disable ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# Disable secure ICMP redirects
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0

# Disable sending ICMP redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# Enable reverse path filtering
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Disable ping
net.ipv4.icmp_echo_ignore_all = 1

# Ignore broadcast pings
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Ignore bad ICMP error messages
net.ipv4.icmp_ignore_bogus_error_responses = 1

# Enable TCP SYN cookies
net.ipv4.tcp_syncookies = 1

# Disable IPv6 Router Advertisements
net.ipv6.conf.all.accept_ra = 0
net.ipv6.conf.default.accept_ra = 0

# Enable address space layout randomization
kernel.randomize_va_space = 2

# Restrict core dumps
fs.suid_dumpable = 0

# Hide kernel pointers
kernel.kptr_restrict = 2

# Disable magic sysrq key
kernel.sysrq = 0

# Restrict dmesg access
kernel.dmesg_restrict = 1

# Restrict ptrace access
kernel.yama.ptrace_scope = 1

# Increase ASLR entropy
vm.mmap_rnd_bits = 32
vm.mmap_rnd_compat_bits = 16
"""
            
            with open('/etc/sysctl.d/99-security-hardening.conf', 'w') as f:
                f.write(sysctl_config)
            
            # Apply settings
            subprocess.run(['sysctl', '-p', '/etc/sysctl.d/99-security-hardening.conf'], 
                         check=True)
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to configure kernel hardening: {e}")
            return False
    
    # Audit Configuration
    def configure_auditd(self) -> bool:
        """Configure comprehensive audit logging"""
        try:
            # Install auditd if not present
            if self._is_debian_based():
                subprocess.run(['apt', 'install', '-y', 'auditd', 'audispd-plugins'], 
                             check=True)
            elif self._is_rhel_based():
                subprocess.run(['dnf', 'install', '-y', 'audit'], check=True)
            
            # Configure audit rules
            audit_rules = """
# Audit Configuration for Enterprise Security

# Delete all existing rules
-D

# Buffer size
-b 8192

# Failure mode (0=silent, 1=printk, 2=panic)
-f 1

# Monitor changes to audit configuration
-w /etc/audit/ -p wa -k audit_config
-w /etc/libaudit.conf -p wa -k audit_config
-w /etc/audisp/ -p wa -k audit_config

# Monitor system calls for privileged commands
-a always,exit -F arch=b64 -S execve -F euid=0 -k privileged_commands
-a always,exit -F arch=b32 -S execve -F euid=0 -k privileged_commands

# Monitor file system changes
-w /etc/passwd -p wa -k user_modification
-w /etc/group -p wa -k user_modification
-w /etc/shadow -p wa -k user_modification
-w /etc/gshadow -p wa -k user_modification
-w /etc/sudoers -p wa -k privilege_modification
-w /etc/sudoers.d/ -p wa -k privilege_modification

# Monitor SSH configuration
-w /etc/ssh/sshd_config -p wa -k ssh_config

# Monitor login/logout events
-w /var/log/lastlog -p wa -k logins
-w /var/log/faillog -p wa -k logins
-w /var/log/tallylog -p wa -k logins

# Monitor network configuration
-a always,exit -F arch=b64 -S sethostname -S setdomainname -k network_config
-a always,exit -F arch=b32 -S sethostname -S setdomainname -k network_config
-w /etc/hosts -p wa -k network_config
-w /etc/network/ -p wa -k network_config

# Monitor file permission changes
-a always,exit -F arch=b64 -S chmod -S fchmod -S fchmodat -k file_permissions
-a always,exit -F arch=b32 -S chmod -S fchmod -S fchmodat -k file_permissions
-a always,exit -F arch=b64 -S chown -S fchown -S fchownat -S lchown -k file_ownership
-a always,exit -F arch=b32 -S chown -S fchown -S fchownat -S lchown -k file_ownership

# Monitor process execution
-a always,exit -F arch=b64 -S execve -k process_execution
-a always,exit -F arch=b32 -S execve -k process_execution

# Make configuration immutable
-e 2
"""
            
            with open('/etc/audit/rules.d/99-enterprise-security.rules', 'w') as f:
                f.write(audit_rules)
            
            # Configure auditd
            auditd_config = """
# Auditd Configuration
log_file = /var/log/audit/audit.log
log_format = RAW
log_group = adm
priority_boost = 4
flush = INCREMENTAL_ASYNC
freq = 50
num_logs = 5
disp_qos = lossy
dispatcher = /sbin/audispd
name_format = HOSTNAME
max_log_file = 100
max_log_file_action = ROTATE
space_left = 1000
space_left_action = SYSLOG
admin_space_left = 500
admin_space_left_action = SUSPEND
disk_full_action = SUSPEND
disk_error_action = SUSPEND
use_libwrap = yes
tcp_listen_queue = 5
tcp_max_per_addr = 1
tcp_client_max_idle = 0
enable_krb5 = no
krb5_principal = auditd
"""
            
            with open('/etc/audit/auditd.conf', 'w') as f:
                f.write(auditd_config)
            
            # Enable and start auditd
            subprocess.run(['systemctl', 'enable', 'auditd'], check=True)
            subprocess.run(['systemctl', 'restart', 'auditd'], check=True)
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to configure auditd: {e}")
            return False
    
    # File Permissions
    def secure_file_permissions(self) -> bool:
        """Secure critical system file permissions"""
        try:
            critical_files = {
                '/etc/passwd': '644',
                '/etc/shadow': '640',
                '/etc/group': '644',
                '/etc/gshadow': '640',
                '/etc/ssh/sshd_config': '600',
                '/etc/sudoers': '440',
                '/etc/crontab': '600',
                '/var/log/auth.log': '640',
                '/var/log/secure': '640'
            }
            
            for file_path, permissions in critical_files.items():
                if os.path.exists(file_path):
                    subprocess.run(['chmod', permissions, file_path], check=True)
                    self.logger.info(f"Set permissions {permissions} on {file_path}")
            
            # Secure SSH keys
            ssh_dir = Path('/etc/ssh')
            if ssh_dir.exists():
                for key_file in ssh_dir.glob('ssh_host_*_key'):
                    subprocess.run(['chmod', '600', str(key_file)], check=True)
                
                for pub_file in ssh_dir.glob('ssh_host_*_key.pub'):
                    subprocess.run(['chmod', '644', str(pub_file)], check=True)
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to secure file permissions: {e}")
            return False
    
    # Service Management
    def disable_unnecessary_services(self) -> bool:
        """Disable unnecessary services"""
        try:
            # List of potentially unnecessary services
            unnecessary_services = [
                'avahi-daemon',
                'bluetooth',
                'cups',
                'nfs-server',
                'rpcbind',
                'telnet',
                'tftp',
                'xinetd',
                'ypbind',
                'nis',
                'rsh-server',
                'talk',
                'finger'
            ]
            
            for service in unnecessary_services:
                try:
                    # Check if service exists
                    result = subprocess.run(['systemctl', 'list-unit-files', service], 
                                          capture_output=True, text=True)
                    
                    if service in result.stdout:
                        # Stop and disable service
                        subprocess.run(['systemctl', 'stop', service], check=True)
                        subprocess.run(['systemctl', 'disable', service], check=True)
                        self.logger.info(f"Disabled unnecessary service: {service}")
                        
                except subprocess.CalledProcessError:
                    # Service doesn't exist or already disabled
                    pass
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to disable unnecessary services: {e}")
            return False
    
    # Password Policy
    def configure_password_policy(self) -> bool:
        """Configure strong password policies"""
        try:
            # Configure PAM password requirements
            pam_config = """
# Password quality requirements
password required pam_pwquality.so retry=3 minlen=12 difok=3 ucredit=-1 lcredit=-1 dcredit=-1 ocredit=-1 maxrepeat=2 maxclassrepeat=3 enforce_for_root

# Password history
password required pam_unix.so use_authtok sha512 shadow remember=5

# Account lockout
auth required pam_tally2.so deny=3 unlock_time=300 onerr=fail
account required pam_tally2.so
"""
            
            # Update common-password file (Debian/Ubuntu)
            if self._is_debian_based():
                pam_file = '/etc/pam.d/common-password'
                if os.path.exists(pam_file):
                    with open(pam_file, 'a') as f:
                        f.write('\n# Enterprise Password Policy\n')
                        f.write(pam_config)
            
            # Configure password aging
            login_defs_additions = """
# Password aging controls
PASS_MAX_DAYS 90
PASS_MIN_DAYS 7
PASS_WARN_AGE 14
PASS_MIN_LEN 12
"""
            
            with open('/etc/login.defs', 'a') as f:
                f.write('\n# Enterprise Password Policy\n')
                f.write(login_defs_additions)
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to configure password policy: {e}")
            return False
    
    # Validation Methods
    def check_ssh_password_disabled(self) -> bool:
        """Check if SSH password authentication is disabled"""
        try:
            with open('/etc/ssh/sshd_config', 'r') as f:
                content = f.read()
            
            return ('PasswordAuthentication no' in content and 
                   'ChallengeResponseAuthentication no' in content)
                   
        except Exception:
            return False
    
    def check_ssh_protocol(self) -> bool:
        """Check if SSH protocol version 2 is enforced"""
        try:
            with open('/etc/ssh/sshd_config', 'r') as f:
                content = f.read()
            
            return 'Protocol 2' in content
            
        except Exception:
            return False
    
    def check_root_ssh_disabled(self) -> bool:
        """Check if root SSH login is disabled"""
        try:
            with open('/etc/ssh/sshd_config', 'r') as f:
                content = f.read()
            
            return 'PermitRootLogin no' in content
            
        except Exception:
            return False
    
    def check_fail2ban_status(self) -> bool:
        """Check if fail2ban is running"""
        try:
            result = subprocess.run(['systemctl', 'is-active', 'fail2ban'], 
                                  capture_output=True, text=True)
            return result.stdout.strip() == 'active'
            
        except Exception:
            return False
    
    def check_firewall_default_policy(self) -> bool:
        """Check if firewall has default deny policy"""
        try:
            if self._command_exists('ufw'):
                result = subprocess.run(['ufw', 'status', 'verbose'], 
                                      capture_output=True, text=True)
                return 'Default: deny (incoming)' in result.stdout
            
            elif self._command_exists('firewall-cmd'):
                result = subprocess.run(['firewall-cmd', '--get-default-zone'], 
                                      capture_output=True, text=True)
                return result.returncode == 0
            
            else:
                result = subprocess.run(['iptables', '-L', 'INPUT'], 
                                      capture_output=True, text=True)
                return 'policy DROP' in result.stdout
                
        except Exception:
            return False
    
    def check_kernel_parameters(self) -> bool:
        """Check if kernel hardening parameters are applied"""
        try:
            # Check a few critical parameters
            critical_params = {
                'net.ipv4.ip_forward': '0',
                'kernel.randomize_va_space': '2',
                'net.ipv4.tcp_syncookies': '1'
            }
            
            for param, expected_value in critical_params.items():
                result = subprocess.run(['sysctl', param], 
                                      capture_output=True, text=True)
                if expected_value not in result.stdout:
                    return False
            
            return True
            
        except Exception:
            return False
    
    def check_audit_rules(self) -> bool:
        """Check if audit rules are configured"""
        try:
            result = subprocess.run(['auditctl', '-l'], 
                                  capture_output=True, text=True)
            return len(result.stdout.strip().split('\n')) > 5
            
        except Exception:
            return False
    
    def check_file_permissions(self) -> bool:
        """Check if critical file permissions are secure"""
        try:
            critical_files = {
                '/etc/passwd': '644',
                '/etc/shadow': '640',
                '/etc/ssh/sshd_config': '600'
            }
            
            for file_path, expected_perms in critical_files.items():
                if os.path.exists(file_path):
                    stat_info = os.stat(file_path)
                    actual_perms = oct(stat_info.st_mode)[-3:]
                    if actual_perms != expected_perms:
                        return False
            
            return True
            
        except Exception:
            return False
    
    def check_running_services(self) -> bool:
        """Check for unnecessary running services"""
        try:
            result = subprocess.run(['systemctl', 'list-units', '--type=service', '--state=running'], 
                                  capture_output=True, text=True)
            
            unnecessary_services = ['telnet', 'ftp', 'tftp', 'rsh-server']
            for service in unnecessary_services:
                if service in result.stdout:
                    return False
            
            return True
            
        except Exception:
            return False
    
    def check_password_requirements(self) -> bool:
        """Check if password policy is configured"""
        try:
            with open('/etc/login.defs', 'r') as f:
                content = f.read()
            
            return ('PASS_MAX_DAYS' in content and 
                   'PASS_MIN_LEN' in content)
                   
        except Exception:
            return False
    
    # Utility Methods
    def _is_debian_based(self) -> bool:
        """Check if system is Debian-based"""
        return os.path.exists('/etc/debian_version')
    
    def _is_rhel_based(self) -> bool:
        """Check if system is RHEL-based"""
        return os.path.exists('/etc/redhat-release')
    
    def _command_exists(self, command: str) -> bool:
        """Check if command exists"""
        result = subprocess.run(['which', command], 
                              capture_output=True, text=True)
        return result.returncode == 0
    
    def _get_ssh_port(self) -> int:
        """Get configured SSH port"""
        try:
            with open('/etc/ssh/sshd_config', 'r') as f:
                content = f.read()
            
            for line in content.split('\n'):
                if line.strip().startswith('Port '):
                    return int(line.strip().split()[1])
            
            return 22  # Default SSH port
            
        except Exception:
            return 22
    
    # Main execution methods
    def apply_baseline(self, baseline_name: str) -> Dict[str, bool]:
        """Apply a security baseline"""
        if baseline_name not in self.baselines:
            self.logger.error(f"Baseline {baseline_name} not found")
            return {}
        
        baseline = self.baselines[baseline_name]
        results = {}
        
        self.logger.info(f"Applying security baseline: {baseline_name}")
        
        for policy_name in baseline.policies:
            if policy_name in self.policies:
                results[policy_name] = self.implement_policy(policy_name)
            else:
                self.logger.warning(f"Policy {policy_name} not found in baseline {baseline_name}")
                results[policy_name] = False
        
        return results
    
    def validate_baseline(self, baseline_name: str) -> Dict[str, bool]:
        """Validate a security baseline"""
        if baseline_name not in self.baselines:
            return {}
        
        baseline = self.baselines[baseline_name]
        results = {}
        
        for policy_name in baseline.policies:
            if policy_name in self.policies:
                results[policy_name] = self.validate_policy(policy_name)
            else:
                results[policy_name] = False
        
        return results
    
    def generate_compliance_report(self, framework_name: Optional[str] = None) -> str:
        """Generate compliance report"""
        report = []
        report.append("ENTERPRISE SECURITY COMPLIANCE REPORT")
        report.append("=" * 50)
        report.append(f"Generated: {time.ctime()}")
        report.append(f"Hostname: {os.uname().nodename}")
        report.append("")
        
        if framework_name and framework_name in self.frameworks:
            framework = self.frameworks[framework_name]
            report.append(f"Framework: {framework.name} v{framework.version}")
            report.append(f"Description: {framework.description}")
            report.append("")
            
            applicable_policies = [
                p for p in self.policies.values() 
                if framework_name in p.compliance_frameworks
            ]
        else:
            report.append("Framework: All Configured Policies")
            report.append("")
            applicable_policies = list(self.policies.values())
        
        # Group by category
        by_category = {}
        for policy in applicable_policies:
            if policy.category not in by_category:
                by_category[policy.category] = []
            by_category[policy.category].append(policy)
        
        total_policies = 0
        passed_policies = 0
        
        for category, policies in by_category.items():
            report.append(f"Category: {category.upper()}")
            report.append("-" * 30)
            
            for policy in policies:
                total_policies += 1
                status = "PASS" if self.validate_policy(policy.name) else "FAIL"
                if status == "PASS":
                    passed_policies += 1
                
                report.append(f"  {policy.name}: {status} [{policy.severity}]")
                report.append(f"    {policy.description}")
            
            report.append("")
        
        compliance_percentage = (passed_policies / total_policies * 100) if total_policies > 0 else 0
        report.append(f"COMPLIANCE SUMMARY:")
        report.append(f"Total Policies: {total_policies}")
        report.append(f"Passed: {passed_policies}")
        report.append(f"Failed: {total_policies - passed_policies}")
        report.append(f"Compliance Rate: {compliance_percentage:.1f}%")
        
        return "\n".join(report)

# Example enterprise usage
def setup_enterprise_security():
    """Example enterprise security setup"""
    security_manager = EnterpriseSecurityManager()
    
    # Create enterprise baseline
    enterprise_baseline = SecurityBaseline(
        name="enterprise_standard",
        version="1.0",
        policies=[
            "ssh_key_only_auth",
            "disable_root_ssh",
            "ssh_protocol_v2",
            "fail2ban_protection",
            "firewall_default_deny",
            "kernel_hardening",
            "audit_logging",
            "file_permissions",
            "remove_unnecessary_services",
            "password_policy"
        ],
        frameworks=["CIS", "NIST", "STIG"],
        environment_type="production",
        risk_level="high"
    )
    
    security_manager.baselines["enterprise_standard"] = enterprise_baseline
    
    return security_manager

if __name__ == "__main__":
    # Demonstration
    security_manager = setup_enterprise_security()
    
    print("Enterprise Security Manager initialized")
    
    # Apply enterprise baseline
    results = security_manager.apply_baseline("enterprise_standard")
    
    print("\nBaseline Application Results:")
    for policy, success in results.items():
        status = "SUCCESS" if success else "FAILED"
        print(f"  {policy}: {status}")
    
    # Generate compliance report
    print("\n" + security_manager.generate_compliance_report("CIS"))
```

# [Advanced Threat Detection and Response](#advanced-threat-detection-response)

## Enterprise SIEM Integration and Automated Response

### Advanced Security Monitoring Framework

```bash
#!/bin/bash
# Enterprise Security Monitoring and Incident Response System

set -euo pipefail

# Configuration
SECURITY_CONFIG="/etc/security/enterprise-monitoring.conf"
LOG_DIR="/var/log/security"
THREAT_INTEL_DIR="/var/lib/security/threat-intel"
RESPONSE_SCRIPTS_DIR="/usr/local/bin/security-response"
QUARANTINE_DIR="/var/quarantine"

# Monitoring settings
CHECK_INTERVAL=30
THREAT_SCORE_THRESHOLD=7
AUTO_RESPONSE_ENABLED=true
NOTIFICATION_WEBHOOK=""
SIEM_ENDPOINT=""

# Detection categories
declare -A THREAT_CATEGORIES=(
    ["brute_force"]="8"
    ["privilege_escalation"]="9"
    ["lateral_movement"]="7"
    ["data_exfiltration"]="10"
    ["malware"]="9"
    ["anomalous_behavior"]="6"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

# Logging
log() { echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*" | tee -a "$LOG_DIR/security-monitor.log"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$LOG_DIR/security-monitor.log"; }
error() { echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_DIR/security-monitor.log"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $*" | tee -a "$LOG_DIR/security-monitor.log"; }
threat() { echo -e "${PURPLE}[THREAT]${NC} $*" | tee -a "$LOG_DIR/security-threats.log"; }

# Setup monitoring environment
setup_monitoring_environment() {
    log "Setting up enterprise security monitoring environment..."
    
    mkdir -p "$LOG_DIR" "$THREAT_INTEL_DIR" "$RESPONSE_SCRIPTS_DIR" "$QUARANTINE_DIR"
    chmod 700 "$THREAT_INTEL_DIR" "$QUARANTINE_DIR"
    chmod 755 "$LOG_DIR" "$RESPONSE_SCRIPTS_DIR"
    
    # Install required tools
    install_security_tools
    
    # Setup threat intelligence feeds
    setup_threat_intelligence
    
    # Create response scripts
    create_response_scripts
    
    success "Monitoring environment setup completed"
}

# Install security monitoring tools
install_security_tools() {
    log "Installing security monitoring tools..."
    
    local tools=(
        "fail2ban"
        "logwatch"
        "rkhunter"
        "chkrootkit"
        "aide"
        "lynis"
        "osquery"
        "auditd"
        "syslog-ng"
        "filebeat"
    )
    
    if command -v apt >/dev/null 2>&1; then
        apt update
        for tool in "${tools[@]}"; do
            if ! dpkg -l | grep -q "^ii.*$tool"; then
                apt install -y "$tool" 2>/dev/null || warn "Failed to install $tool"
            fi
        done
    elif command -v yum >/dev/null 2>&1; then
        for tool in "${tools[@]}"; do
            if ! rpm -q "$tool" >/dev/null 2>&1; then
                yum install -y "$tool" 2>/dev/null || warn "Failed to install $tool"
            fi
        done
    fi
    
    success "Security tools installation completed"
}

# Setup threat intelligence feeds
setup_threat_intelligence() {
    log "Setting up threat intelligence feeds..."
    
    # Create threat intelligence update script
    cat > "/usr/local/bin/update-threat-intel.sh" << 'EOF'
#!/bin/bash
# Threat Intelligence Feed Update Script

THREAT_INTEL_DIR="/var/lib/security/threat-intel"
LOG_FILE="/var/log/security/threat-intel.log"

log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $*" >> "$LOG_FILE"
}

# Download IP reputation lists
download_ip_reputation() {
    local sources=(
        "https://rules.emergingthreats.net/fwrules/emerging-Block-IPs.txt"
        "https://www.spamhaus.org/drop/drop.txt"
        "https://www.spamhaus.org/drop/edrop.txt"
    )
    
    for source in "${sources[@]}"; do
        local filename=$(basename "$source")
        if curl -s -o "$THREAT_INTEL_DIR/$filename.tmp" "$source"; then
            mv "$THREAT_INTEL_DIR/$filename.tmp" "$THREAT_INTEL_DIR/$filename"
            log_message "Updated threat intel: $filename"
        else
            log_message "Failed to update: $filename"
        fi
    done
}

# Download malware hashes
download_malware_hashes() {
    # Example: Download known malware hashes
    if curl -s -o "$THREAT_INTEL_DIR/malware_hashes.txt.tmp" \
       "https://bazaar.abuse.ch/export/txt/md5/recent/"; then
        mv "$THREAT_INTEL_DIR/malware_hashes.txt.tmp" "$THREAT_INTEL_DIR/malware_hashes.txt"
        log_message "Updated malware hashes"
    fi
}

# Main execution
download_ip_reputation
download_malware_hashes

log_message "Threat intelligence update completed"
EOF

    chmod +x "/usr/local/bin/update-threat-intel.sh"
    
    # Create cron job for regular updates
    cat > "/etc/cron.d/threat-intel-update" << EOF
# Update threat intelligence feeds every 4 hours
0 */4 * * * root /usr/local/bin/update-threat-intel.sh
EOF
    
    # Initial update
    /usr/local/bin/update-threat-intel.sh
    
    success "Threat intelligence feeds configured"
}

# Create automated response scripts
create_response_scripts() {
    log "Creating automated response scripts..."
    
    # Create IP blocking script
    cat > "$RESPONSE_SCRIPTS_DIR/block-ip.sh" << 'EOF'
#!/bin/bash
# Automated IP Blocking Response Script

IP_ADDRESS="$1"
REASON="$2"
DURATION="${3:-3600}"  # Default 1 hour

if [[ -z "$IP_ADDRESS" ]]; then
    echo "Usage: $0 <ip_address> <reason> [duration_seconds]"
    exit 1
fi

# Log the action
logger -p security.warn "SECURITY-RESPONSE: Blocking IP $IP_ADDRESS - Reason: $REASON"

# Block IP using available firewall
if command -v ufw >/dev/null 2>&1; then
    ufw insert 1 deny from "$IP_ADDRESS"
elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --add-rich-rule="rule family='ipv4' source address='$IP_ADDRESS' reject" --timeout="$DURATION"
else
    iptables -I INPUT -s "$IP_ADDRESS" -j DROP
fi

# Add to blocked IPs list
echo "$(date '+%Y-%m-%d %H:%M:%S'),$IP_ADDRESS,$REASON,$DURATION" >> /var/log/security/blocked_ips.log

echo "IP $IP_ADDRESS blocked successfully"
EOF

    # Create process termination script
    cat > "$RESPONSE_SCRIPTS_DIR/terminate-process.sh" << 'EOF'
#!/bin/bash
# Automated Process Termination Response Script

PID="$1"
REASON="$2"

if [[ -z "$PID" ]]; then
    echo "Usage: $0 <pid> <reason>"
    exit 1
fi

# Get process information
PROCESS_INFO=$(ps -p "$PID" -o pid,ppid,cmd --no-headers 2>/dev/null)

if [[ -z "$PROCESS_INFO" ]]; then
    echo "Process $PID not found"
    exit 1
fi

# Log the action
logger -p security.warn "SECURITY-RESPONSE: Terminating process $PID - Reason: $REASON - Info: $PROCESS_INFO"

# Terminate process gracefully, then forcefully if needed
kill -TERM "$PID" 2>/dev/null
sleep 5

if kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$PID" 2>/dev/null
    echo "Process $PID forcefully terminated"
else
    echo "Process $PID terminated gracefully"
fi

# Log termination
echo "$(date '+%Y-%m-%d %H:%M:%S'),$PID,$REASON,terminated" >> /var/log/security/terminated_processes.log
EOF

    # Create user account lockout script
    cat > "$RESPONSE_SCRIPTS_DIR/lockout-user.sh" << 'EOF'
#!/bin/bash
# Automated User Account Lockout Response Script

USERNAME="$1"
REASON="$2"
DURATION="${3:-3600}"  # Default 1 hour

if [[ -z "$USERNAME" ]]; then
    echo "Usage: $0 <username> <reason> [duration_seconds]"
    exit 1
fi

# Log the action
logger -p security.warn "SECURITY-RESPONSE: Locking out user $USERNAME - Reason: $REASON"

# Lock user account
usermod -L "$USERNAME"

# Kill all user sessions
pkill -u "$USERNAME" 2>/dev/null || true

# Schedule unlock if duration specified
if [[ "$DURATION" -gt 0 ]]; then
    echo "usermod -U $USERNAME" | at "now + $DURATION seconds" 2>/dev/null || true
fi

# Log lockout
echo "$(date '+%Y-%m-%d %H:%M:%S'),$USERNAME,$REASON,$DURATION" >> /var/log/security/locked_users.log

echo "User $USERNAME locked out successfully"
EOF

    # Create file quarantine script
    cat > "$RESPONSE_SCRIPTS_DIR/quarantine-file.sh" << 'EOF'
#!/bin/bash
# Automated File Quarantine Response Script

FILE_PATH="$1"
REASON="$2"

if [[ -z "$FILE_PATH" ]]; then
    echo "Usage: $0 <file_path> <reason>"
    exit 1
fi

if [[ ! -f "$FILE_PATH" ]]; then
    echo "File $FILE_PATH not found"
    exit 1
fi

QUARANTINE_DIR="/var/quarantine"
QUARANTINE_FILE="$QUARANTINE_DIR/$(basename "$FILE_PATH").$(date +%s)"

# Log the action
logger -p security.warn "SECURITY-RESPONSE: Quarantining file $FILE_PATH - Reason: $REASON"

# Move file to quarantine
mkdir -p "$QUARANTINE_DIR"
mv "$FILE_PATH" "$QUARANTINE_FILE"
chmod 000 "$QUARANTINE_FILE"

# Log quarantine action
echo "$(date '+%Y-%m-%d %H:%M:%S'),$FILE_PATH,$QUARANTINE_FILE,$REASON" >> /var/log/security/quarantined_files.log

echo "File $FILE_PATH quarantined as $QUARANTINE_FILE"
EOF

    # Make scripts executable
    chmod +x "$RESPONSE_SCRIPTS_DIR"/*.sh
    
    success "Automated response scripts created"
}

# Advanced threat detection functions
detect_brute_force_attacks() {
    local threat_score=0
    local source_ips=()
    
    # Check authentication logs for failed attempts
    local failed_attempts=$(grep "Failed password" /var/log/auth.log 2>/dev/null | \
                           grep "$(date '+%b %d')" | wc -l)
    
    if [[ $failed_attempts -gt 50 ]]; then
        threat_score=$((threat_score + 8))
        threat "High number of failed authentication attempts detected: $failed_attempts"
        
        # Extract source IPs with high failure rates
        source_ips=($(grep "Failed password" /var/log/auth.log 2>/dev/null | \
                     grep "$(date '+%b %d')" | \
                     awk '{print $(NF-3)}' | sort | uniq -c | \
                     awk '$1 > 10 {print $2}'))
        
        # Auto-block persistent attackers
        for ip in "${source_ips[@]}"; do
            if [[ "$AUTO_RESPONSE_ENABLED" == "true" ]]; then
                "$RESPONSE_SCRIPTS_DIR/block-ip.sh" "$ip" "brute_force_attack" 7200
            fi
        done
    fi
    
    echo "$threat_score"
}

detect_privilege_escalation() {
    local threat_score=0
    
    # Check for suspicious sudo activity
    local sudo_failures=$(grep "sudo.*FAILED" /var/log/auth.log 2>/dev/null | \
                         grep "$(date '+%b %d')" | wc -l)
    
    if [[ $sudo_failures -gt 5 ]]; then
        threat_score=$((threat_score + 6))
        threat "Suspicious sudo failures detected: $sudo_failures"
    fi
    
    # Check for unusual SUID/SGID file execution
    if command -v auditctl >/dev/null 2>&1; then
        local suid_exec=$(ausearch -k privileged_commands -ts today 2>/dev/null | \
                         grep -c "type=EXECVE" || echo "0")
        
        if [[ $suid_exec -gt 100 ]]; then
            threat_score=$((threat_score + 4))
            threat "High privileged command execution detected: $suid_exec"
        fi
    fi
    
    echo "$threat_score"
}

detect_lateral_movement() {
    local threat_score=0
    
    # Check for unusual SSH connections
    local ssh_connections=$(grep "Accepted" /var/log/auth.log 2>/dev/null | \
                           grep "$(date '+%b %d')" | wc -l)
    
    # Baseline: normal SSH connections per day
    local baseline_ssh=20
    
    if [[ $ssh_connections -gt $((baseline_ssh * 3)) ]]; then
        threat_score=$((threat_score + 5))
        threat "Unusual SSH connection pattern detected: $ssh_connections connections"
    fi
    
    # Check for internal network scanning
    local scan_attempts=$(netstat -an | grep ":22.*SYN_RECV" | wc -l)
    
    if [[ $scan_attempts -gt 10 ]]; then
        threat_score=$((threat_score + 6))
        threat "Potential internal network scanning detected"
    fi
    
    echo "$threat_score"
}

detect_data_exfiltration() {
    local threat_score=0
    
    # Monitor for large data transfers
    local large_transfers=$(grep "$(date '+%b %d')" /var/log/syslog 2>/dev/null | \
                           grep -E "(scp|rsync|curl|wget)" | \
                           grep -E "([0-9]+[MG]B|[0-9]{4,})" | wc -l)
    
    if [[ $large_transfers -gt 5 ]]; then
        threat_score=$((threat_score + 7))
        threat "Suspicious large data transfers detected: $large_transfers"
    fi
    
    # Check for database dumps
    local db_dumps=$(ps aux | grep -E "(mysqldump|pg_dump|sqlite)" | \
                    grep -v grep | wc -l)
    
    if [[ $db_dumps -gt 0 ]]; then
        threat_score=$((threat_score + 8))
        threat "Database dump processes detected: $db_dumps"
    fi
    
    echo "$threat_score"
}

detect_malware() {
    local threat_score=0
    
    # Check for suspicious processes
    local suspicious_processes=$(ps aux | \
                               grep -E "(nc|netcat|socat).*-[le]" | \
                               grep -v grep | wc -l)
    
    if [[ $suspicious_processes -gt 0 ]]; then
        threat_score=$((threat_score + 8))
        threat "Suspicious network processes detected: $suspicious_processes"
        
        # Terminate suspicious processes if auto-response enabled
        if [[ "$AUTO_RESPONSE_ENABLED" == "true" ]]; then
            ps aux | grep -E "(nc|netcat|socat).*-[le]" | grep -v grep | \
            awk '{print $2}' | while read -r pid; do
                "$RESPONSE_SCRIPTS_DIR/terminate-process.sh" "$pid" "suspicious_network_tool"
            done
        fi
    fi
    
    # Check for known malware signatures in memory
    if command -v rkhunter >/dev/null 2>&1; then
        local rkhunter_warnings=$(rkhunter --check --sk --rwo 2>/dev/null | \
                                 grep "Warning" | wc -l)
        
        if [[ $rkhunter_warnings -gt 0 ]]; then
            threat_score=$((threat_score + 6))
            threat "Rootkit hunter warnings: $rkhunter_warnings"
        fi
    fi
    
    echo "$threat_score"
}

detect_anomalous_behavior() {
    local threat_score=0
    
    # Check for unusual login times
    local night_logins=$(last | grep "$(date '+%b %d')" | \
                        awk '$7 ~ /^(0[0-6]|2[2-3]):/ {count++} END {print count+0}')
    
    if [[ $night_logins -gt 2 ]]; then
        threat_score=$((threat_score + 3))
        threat "Unusual login times detected: $night_logins night logins"
    fi
    
    # Check for rapid-fire commands
    local rapid_commands=$(history | tail -100 | \
                          awk '{if(NR>1 && $2==prev) count++; prev=$2} END {print count+0}')
    
    if [[ $rapid_commands -gt 20 ]]; then
        threat_score=$((threat_score + 4))
        threat "Rapid command execution pattern detected"
    fi
    
    echo "$threat_score"
}

# Main threat detection engine
run_threat_detection() {
    log "Running comprehensive threat detection scan..."
    
    local total_threat_score=0
    local detection_results=()
    
    # Run all detection modules
    local brute_force_score=$(detect_brute_force_attacks)
    local privilege_escalation_score=$(detect_privilege_escalation)
    local lateral_movement_score=$(detect_lateral_movement)
    local data_exfiltration_score=$(detect_data_exfiltration)
    local malware_score=$(detect_malware)
    local anomalous_behavior_score=$(detect_anomalous_behavior)
    
    # Calculate total threat score
    total_threat_score=$((brute_force_score + privilege_escalation_score + 
                        lateral_movement_score + data_exfiltration_score + 
                        malware_score + anomalous_behavior_score))
    
    # Store results
    detection_results=(
        "brute_force:$brute_force_score"
        "privilege_escalation:$privilege_escalation_score"
        "lateral_movement:$lateral_movement_score"
        "data_exfiltration:$data_exfiltration_score"
        "malware:$malware_score"
        "anomalous_behavior:$anomalous_behavior_score"
        "total:$total_threat_score"
    )
    
    # Log results
    log "Threat detection completed - Total score: $total_threat_score"
    
    # Send to SIEM if configured
    if [[ -n "$SIEM_ENDPOINT" ]]; then
        send_to_siem "${detection_results[@]}"
    fi
    
    # Trigger high-level response if threshold exceeded
    if [[ $total_threat_score -ge $THREAT_SCORE_THRESHOLD ]]; then
        threat "HIGH THREAT LEVEL DETECTED - Score: $total_threat_score (Threshold: $THREAT_SCORE_THRESHOLD)"
        trigger_incident_response "$total_threat_score" "${detection_results[@]}"
    fi
    
    # Generate detection report
    generate_detection_report "${detection_results[@]}"
}

# Incident response trigger
trigger_incident_response() {
    local threat_score="$1"
    shift
    local detection_results=("$@")
    
    threat "INCIDENT RESPONSE TRIGGERED - Threat Score: $threat_score"
    
    # Create incident report
    local incident_id="INC_$(date +%Y%m%d_%H%M%S)_$$"
    local incident_file="$LOG_DIR/incidents/$incident_id.json"
    
    mkdir -p "$(dirname "$incident_file")"
    
    cat > "$incident_file" << EOF
{
  "incident_id": "$incident_id",
  "timestamp": "$(date -Iseconds)",
  "hostname": "$(hostname)",
  "threat_score": $threat_score,
  "threshold": $THREAT_SCORE_THRESHOLD,
  "detection_results": {
EOF

    # Add detection results to JSON
    local first=true
    for result in "${detection_results[@]}"; do
        local category=$(echo "$result" | cut -d: -f1)
        local score=$(echo "$result" | cut -d: -f2)
        
        if [[ "$first" == "true" ]]; then
            first=false
        else
            echo "," >> "$incident_file"
        fi
        
        echo "    \"$category\": $score" >> "$incident_file"
    done
    
    cat >> "$incident_file" << EOF
  },
  "system_info": {
    "uptime": "$(uptime)",
    "load_average": "$(cat /proc/loadavg)",
    "memory_usage": "$(free -m | grep '^Mem' | awk '{print $3/$2*100}')",
    "disk_usage": "$(df / | tail -1 | awk '{print $5}')"
  },
  "network_connections": [
EOF

    # Add active network connections
    netstat -an | grep ESTABLISHED | head -20 | while read -r line; do
        echo "    \"$line\"," >> "$incident_file"
    done
    
    cat >> "$incident_file" << EOF
  ],
  "recent_logins": [
EOF

    # Add recent login information
    last | head -10 | while read -r line; do
        echo "    \"$line\"," >> "$incident_file"
    done
    
    cat >> "$incident_file" << EOF
  ]
}
EOF

    # Send notifications
    send_incident_notification "$incident_id" "$threat_score"
    
    # Auto-escalate if score is very high
    if [[ $threat_score -ge 15 ]]; then
        escalate_incident "$incident_id" "$threat_score"
    fi
}

# Send to SIEM
send_to_siem() {
    local detection_results=("$@")
    
    if [[ -z "$SIEM_ENDPOINT" ]]; then
        return
    fi
    
    local siem_payload=$(cat << EOF
{
  "timestamp": "$(date -Iseconds)",
  "hostname": "$(hostname)",
  "source": "enterprise-security-monitor",
  "detection_results": {
EOF

    for result in "${detection_results[@]}"; do
        local category=$(echo "$result" | cut -d: -f1)
        local score=$(echo "$result" | cut -d: -f2)
        echo "    \"$category\": $score," >> /tmp/siem_payload.json
    done
    
    echo "  }" >> /tmp/siem_payload.json
    echo "}" >> /tmp/siem_payload.json
    
    # Send to SIEM endpoint
    curl -X POST "$SIEM_ENDPOINT" \
         -H "Content-Type: application/json" \
         -d @/tmp/siem_payload.json \
         --max-time 10 \
         --silent 2>/dev/null || warn "Failed to send data to SIEM"
    
    rm -f /tmp/siem_payload.json
}

# Send incident notification
send_incident_notification() {
    local incident_id="$1"
    local threat_score="$2"
    
    local message="SECURITY INCIDENT DETECTED\nID: $incident_id\nThreat Score: $threat_score\nHost: $(hostname)\nTime: $(date)"
    
    # Send to webhook if configured
    if [[ -n "$NOTIFICATION_WEBHOOK" ]]; then
        curl -X POST "$NOTIFICATION_WEBHOOK" \
             -H "Content-Type: application/json" \
             -d "{\"text\":\"$message\"}" \
             --max-time 10 \
             --silent 2>/dev/null || warn "Failed to send webhook notification"
    fi
    
    # Send email if configured
    if command -v mail >/dev/null 2>&1 && [[ -n "${SECURITY_EMAIL:-}" ]]; then
        echo -e "$message" | mail -s "Security Incident: $incident_id" "$SECURITY_EMAIL"
    fi
    
    # Log to syslog
    logger -p security.crit "SECURITY-INCIDENT: $incident_id - Threat Score: $threat_score"
}

# Generate detection report
generate_detection_report() {
    local detection_results=("$@")
    local report_file="$LOG_DIR/detection_report_$(date +%Y%m%d_%H%M%S).txt"
    
    {
        echo "ENTERPRISE SECURITY DETECTION REPORT"
        echo "===================================="
        echo "Generated: $(date)"
        echo "Hostname: $(hostname)"
        echo ""
        
        echo "THREAT DETECTION RESULTS:"
        echo "------------------------"
        
        for result in "${detection_results[@]}"; do
            local category=$(echo "$result" | cut -d: -f1)
            local score=$(echo "$result" | cut -d: -f2)
            local category_threshold=${THREAT_CATEGORIES[$category]:-5}
            
            local status="LOW"
            if [[ $score -ge $category_threshold ]]; then
                status="HIGH"
            elif [[ $score -ge $((category_threshold / 2)) ]]; then
                status="MEDIUM"
            fi
            
            printf "%-20s: %2d (%s)\n" "$category" "$score" "$status"
        done
        
        echo ""
        echo "SYSTEM STATUS:"
        echo "-------------"
        echo "Uptime: $(uptime)"
        echo "Load: $(cat /proc/loadavg)"
        echo "Memory: $(free -h | grep Mem)"
        echo "Disk: $(df -h / | tail -1)"
        
        echo ""
        echo "ACTIVE CONNECTIONS:"
        echo "------------------"
        netstat -an | grep ESTABLISHED | head -10
        
        echo ""
        echo "RECENT AUTHENTICATION:"
        echo "---------------------"
        last | head -10
        
    } > "$report_file"
    
    log "Detection report generated: $report_file"
}

# Main monitoring loop
run_continuous_monitoring() {
    log "Starting continuous security monitoring..."
    
    while true; do
        local start_time=$(date +%s)
        
        # Run threat detection
        run_threat_detection
        
        # Calculate sleep time
        local end_time=$(date +%s)
        local elapsed=$((end_time - start_time))
        local sleep_time=$((CHECK_INTERVAL - elapsed))
        
        if [[ $sleep_time -gt 0 ]]; then
            sleep "$sleep_time"
        fi
    done
}

# Service management
install_monitoring_service() {
    log "Installing security monitoring service..."
    
    # Create systemd service
    cat > "/etc/systemd/system/enterprise-security-monitor.service" << EOF
[Unit]
Description=Enterprise Security Monitoring Service
After=network.target syslog.target
Wants=network.target

[Service]
Type=simple
ExecStart=$0 monitor
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=10
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable enterprise-security-monitor.service
    
    success "Security monitoring service installed"
}

# Main execution
main() {
    case "${1:-help}" in
        "setup")
            setup_monitoring_environment
            install_monitoring_service
            ;;
        "monitor")
            setup_monitoring_environment 2>/dev/null || true
            run_continuous_monitoring
            ;;
        "scan")
            setup_monitoring_environment 2>/dev/null || true
            run_threat_detection
            ;;
        "install")
            install_monitoring_service
            ;;
        *)
            echo "Usage: $0 {setup|monitor|scan|install}"
            echo ""
            echo "Commands:"
            echo "  setup   - Setup monitoring environment"
            echo "  monitor - Run continuous monitoring"
            echo "  scan    - Run single threat detection scan"
            echo "  install - Install monitoring service"
            exit 1
            ;;
    esac
}

# Load configuration if available
if [[ -f "$SECURITY_CONFIG" ]]; then
    source "$SECURITY_CONFIG"
fi

# Check for root privileges
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
    exit 1
fi

main "$@"
```

This comprehensive enterprise Linux security guide provides production-ready frameworks for multi-layered security hardening, advanced threat detection, and automated incident response. The included tools support large-scale security operations, compliance management, and sophisticated threat hunting capabilities essential for protecting critical infrastructure in modern enterprise environments.