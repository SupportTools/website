---
title: "Incident Communication Strategies: Enterprise Guide to Crisis Management and Stakeholder Coordination"
date: 2026-08-06T00:00:00-05:00
draft: false
tags: ["Incident Response", "Communication", "Crisis Management", "SRE", "DevOps", "Automation", "Enterprise", "PagerDuty", "StatusPage", "Slack"]
categories: ["Incident Management", "Site Reliability Engineering", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing effective incident communication strategies for enterprise environments, including automated notifications, stakeholder management, status pages, and crisis communication templates."
more_link: "yes"
url: "/incident-communication-strategies-enterprise-guide/"
---

Effective communication during incidents is often the difference between controlled response and organizational chaos. This comprehensive guide provides enterprise-grade strategies, automation tools, and battle-tested templates for managing incident communications across all stakeholders.

In this guide, we'll implement a complete incident communication framework with automated notifications, status pages, stakeholder coordination, and escalation protocols that scale from minor incidents to major outages.

<!--more-->

# Incident Communication Strategies: Enterprise Guide

## Executive Summary

Incident communication is a critical component of incident response that requires careful planning, automation, and clear processes. This guide covers:

- Multi-channel communication architectures
- Automated notification systems with intelligent routing
- Stakeholder management and escalation matrices
- Status page automation and customer communications
- Internal coordination tools and war room management
- Post-incident communication workflows
- Compliance and audit trail requirements

## Understanding Communication Requirements

### Communication Dimensions

**Audience Segmentation:**
```yaml
# Communication Matrix Configuration
communication_matrix:
  audiences:
    technical_responders:
      priority: critical
      channels:
        - pagerduty
        - slack
        - sms
      response_time: immediate
      detail_level: technical

    engineering_leadership:
      priority: high
      channels:
        - slack
        - email
        - phone
      response_time: 5_minutes
      detail_level: executive

    product_management:
      priority: high
      channels:
        - slack
        - email
      response_time: 10_minutes
      detail_level: business_impact

    customer_success:
      priority: medium
      channels:
        - slack
        - email
        - internal_portal
      response_time: 15_minutes
      detail_level: customer_facing

    external_customers:
      priority: critical
      channels:
        - status_page
        - email
        - in_app
      response_time: varies_by_severity
      detail_level: simplified

    executives:
      priority: critical
      channels:
        - phone
        - email
        - executive_dashboard
      response_time: varies_by_severity
      detail_level: business_impact

    compliance_legal:
      priority: high
      channels:
        - email
        - secure_portal
      response_time: severity_dependent
      detail_level: regulatory
```

### Severity-Based Communication Protocols

**Communication Requirements by Severity:**
```python
# incident_communication_matrix.py
from enum import Enum
from dataclasses import dataclass
from typing import List, Dict, Optional
import logging

class IncidentSeverity(Enum):
    """Incident severity levels"""
    SEV1 = "sev1"  # Critical - Complete outage
    SEV2 = "sev2"  # High - Major functionality impaired
    SEV3 = "sev3"  # Medium - Minor functionality impaired
    SEV4 = "sev4"  # Low - Minimal impact
    SEV5 = "sev5"  # Info - No customer impact

class CommunicationChannel(Enum):
    """Available communication channels"""
    PAGERDUTY = "pagerduty"
    SLACK = "slack"
    EMAIL = "email"
    SMS = "sms"
    PHONE = "phone"
    STATUS_PAGE = "status_page"
    IN_APP = "in_app"
    DASHBOARD = "dashboard"

@dataclass
class CommunicationRequirement:
    """Communication requirement definition"""
    audience: str
    channels: List[CommunicationChannel]
    initial_notification_minutes: int
    update_frequency_minutes: int
    detail_level: str
    mandatory: bool
    escalation_if_no_ack_minutes: Optional[int] = None

class IncidentCommunicationMatrix:
    """
    Manages incident communication requirements based on severity
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.matrix = self._build_matrix()

    def _build_matrix(self) -> Dict[IncidentSeverity, List[CommunicationRequirement]]:
        """Build the communication matrix"""
        return {
            IncidentSeverity.SEV1: [
                CommunicationRequirement(
                    audience="on_call_engineers",
                    channels=[
                        CommunicationChannel.PAGERDUTY,
                        CommunicationChannel.SLACK,
                        CommunicationChannel.SMS,
                        CommunicationChannel.PHONE
                    ],
                    initial_notification_minutes=0,
                    update_frequency_minutes=15,
                    detail_level="technical_detailed",
                    mandatory=True,
                    escalation_if_no_ack_minutes=5
                ),
                CommunicationRequirement(
                    audience="engineering_leadership",
                    channels=[
                        CommunicationChannel.SLACK,
                        CommunicationChannel.EMAIL,
                        CommunicationChannel.PHONE
                    ],
                    initial_notification_minutes=0,
                    update_frequency_minutes=30,
                    detail_level="executive_summary",
                    mandatory=True,
                    escalation_if_no_ack_minutes=10
                ),
                CommunicationRequirement(
                    audience="executive_team",
                    channels=[
                        CommunicationChannel.EMAIL,
                        CommunicationChannel.PHONE,
                        CommunicationChannel.DASHBOARD
                    ],
                    initial_notification_minutes=15,
                    update_frequency_minutes=60,
                    detail_level="business_impact",
                    mandatory=True
                ),
                CommunicationRequirement(
                    audience="external_customers",
                    channels=[
                        CommunicationChannel.STATUS_PAGE,
                        CommunicationChannel.EMAIL,
                        CommunicationChannel.IN_APP
                    ],
                    initial_notification_minutes=15,
                    update_frequency_minutes=30,
                    detail_level="customer_friendly",
                    mandatory=True
                ),
                CommunicationRequirement(
                    audience="customer_success",
                    channels=[
                        CommunicationChannel.SLACK,
                        CommunicationChannel.EMAIL
                    ],
                    initial_notification_minutes=10,
                    update_frequency_minutes=30,
                    detail_level="customer_talking_points",
                    mandatory=True
                )
            ],

            IncidentSeverity.SEV2: [
                CommunicationRequirement(
                    audience="on_call_engineers",
                    channels=[
                        CommunicationChannel.PAGERDUTY,
                        CommunicationChannel.SLACK
                    ],
                    initial_notification_minutes=0,
                    update_frequency_minutes=30,
                    detail_level="technical_detailed",
                    mandatory=True,
                    escalation_if_no_ack_minutes=10
                ),
                CommunicationRequirement(
                    audience="engineering_leadership",
                    channels=[
                        CommunicationChannel.SLACK,
                        CommunicationChannel.EMAIL
                    ],
                    initial_notification_minutes=5,
                    update_frequency_minutes=60,
                    detail_level="executive_summary",
                    mandatory=True
                ),
                CommunicationRequirement(
                    audience="external_customers",
                    channels=[
                        CommunicationChannel.STATUS_PAGE,
                        CommunicationChannel.EMAIL
                    ],
                    initial_notification_minutes=30,
                    update_frequency_minutes=60,
                    detail_level="customer_friendly",
                    mandatory=True
                )
            ],

            IncidentSeverity.SEV3: [
                CommunicationRequirement(
                    audience="on_call_engineers",
                    channels=[
                        CommunicationChannel.PAGERDUTY,
                        CommunicationChannel.SLACK
                    ],
                    initial_notification_minutes=0,
                    update_frequency_minutes=60,
                    detail_level="technical_summary",
                    mandatory=True,
                    escalation_if_no_ack_minutes=15
                ),
                CommunicationRequirement(
                    audience="engineering_leadership",
                    channels=[CommunicationChannel.SLACK],
                    initial_notification_minutes=15,
                    update_frequency_minutes=120,
                    detail_level="summary",
                    mandatory=False
                )
            ]
        }

    def get_requirements(self, severity: IncidentSeverity) -> List[CommunicationRequirement]:
        """Get communication requirements for severity level"""
        return self.matrix.get(severity, [])

    def get_initial_notifications(self, severity: IncidentSeverity) -> List[CommunicationRequirement]:
        """Get requirements that need immediate notification"""
        requirements = self.get_requirements(severity)
        return [req for req in requirements if req.initial_notification_minutes == 0]

    def get_delayed_notifications(self, severity: IncidentSeverity,
                                 elapsed_minutes: int) -> List[CommunicationRequirement]:
        """Get requirements that should be notified after elapsed time"""
        requirements = self.get_requirements(severity)
        return [
            req for req in requirements
            if 0 < req.initial_notification_minutes <= elapsed_minutes
        ]

    def should_send_update(self, severity: IncidentSeverity,
                          audience: str,
                          minutes_since_last_update: int) -> bool:
        """Check if an update should be sent to audience"""
        requirements = self.get_requirements(severity)
        for req in requirements:
            if req.audience == audience:
                return minutes_since_last_update >= req.update_frequency_minutes
        return False

# Example usage
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    matrix = IncidentCommunicationMatrix()

    # SEV1 incident - get all requirements
    sev1_reqs = matrix.get_requirements(IncidentSeverity.SEV1)
    print(f"\nSEV1 Communication Requirements: {len(sev1_reqs)} audiences")

    for req in sev1_reqs:
        print(f"\nAudience: {req.audience}")
        print(f"  Channels: {[c.value for c in req.channels]}")
        print(f"  Initial notification: {req.initial_notification_minutes} min")
        print(f"  Update frequency: {req.update_frequency_minutes} min")
        print(f"  Mandatory: {req.mandatory}")

    # Check immediate notifications
    immediate = matrix.get_initial_notifications(IncidentSeverity.SEV1)
    print(f"\n\nImmediate notifications required: {len(immediate)}")
    for req in immediate:
        print(f"  - {req.audience}")
```

## Automated Notification System

### Multi-Channel Notification Engine

**Unified Notification Service:**
```python
# notification_engine.py
import asyncio
import aiohttp
import json
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
from enum import Enum
from datetime import datetime
import logging
from jinja2 import Template

class NotificationPriority(Enum):
    """Notification priority levels"""
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

@dataclass
class NotificationContext:
    """Context for notification templates"""
    incident_id: str
    severity: str
    title: str
    description: str
    impact: str
    status: str
    started_at: datetime
    affected_services: List[str]
    responders: List[str]
    incident_commander: str
    war_room_url: Optional[str] = None
    estimated_resolution: Optional[datetime] = None
    customer_impact: Optional[str] = None
    mitigation_steps: Optional[List[str]] = None
    additional_context: Optional[Dict[str, Any]] = None

@dataclass
class NotificationResult:
    """Result of notification attempt"""
    channel: str
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    timestamp: datetime = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()

class NotificationEngine:
    """
    Multi-channel notification engine for incident communications
    """

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.session: Optional[aiohttp.ClientSession] = None

        # Load templates
        self.templates = self._load_templates()

    def _load_templates(self) -> Dict[str, Dict[str, Template]]:
        """Load notification templates for each channel and audience"""
        return {
            "technical_detailed": {
                "slack": Template("""
🚨 *{{ severity }} Incident #{{ incident_id }}*

*Title:* {{ title }}
*Status:* {{ status }}
*Started:* {{ started_at.strftime('%Y-%m-%d %H:%M:%S UTC') }}
*Incident Commander:* {{ incident_commander }}

*Impact:*
{{ impact }}

*Affected Services:*
{% for service in affected_services %}
• {{ service }}
{% endfor %}

*Description:*
{{ description }}

{% if mitigation_steps %}
*Current Actions:*
{% for step in mitigation_steps %}
{{ loop.index }}. {{ step }}
{% endfor %}
{% endif %}

*War Room:* {{ war_room_url }}
*Responders:* {{ responders|join(', ') }}
                """),

                "email_subject": Template(
                    "[{{ severity }}] Incident #{{ incident_id }}: {{ title }}"
                ),

                "email_body": Template("""
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6;">
    <div style="background-color: #{% if severity == 'SEV1' %}dc3545{% elif severity == 'SEV2' %}fd7e14{% else %}ffc107{% endif %}; color: white; padding: 20px; border-radius: 5px;">
        <h2>{{ severity }} Incident #{{ incident_id }}</h2>
        <h3>{{ title }}</h3>
    </div>

    <div style="padding: 20px;">
        <table style="width: 100%; border-collapse: collapse;">
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Status:</strong></td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">{{ status }}</td>
            </tr>
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Started:</strong></td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">{{ started_at.strftime('%Y-%m-%d %H:%M:%S UTC') }}</td>
            </tr>
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Incident Commander:</strong></td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">{{ incident_commander }}</td>
            </tr>
        </table>

        <h3>Impact</h3>
        <p>{{ impact }}</p>

        <h3>Affected Services</h3>
        <ul>
        {% for service in affected_services %}
            <li>{{ service }}</li>
        {% endfor %}
        </ul>

        <h3>Description</h3>
        <p>{{ description }}</p>

        {% if mitigation_steps %}
        <h3>Current Actions</h3>
        <ol>
        {% for step in mitigation_steps %}
            <li>{{ step }}</li>
        {% endfor %}
        </ol>
        {% endif %}

        <div style="margin-top: 20px; padding: 15px; background-color: #f8f9fa; border-radius: 5px;">
            <p><strong>War Room:</strong> <a href="{{ war_room_url }}">{{ war_room_url }}</a></p>
            <p><strong>Active Responders:</strong> {{ responders|join(', ') }}</p>
        </div>
    </div>
</body>
</html>
                """)
            },

            "executive_summary": {
                "email_subject": Template(
                    "[{{ severity }}] Business Impact Alert: {{ title }}"
                ),

                "email_body": Template("""
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6;">
    <div style="background-color: #{% if severity == 'SEV1' %}dc3545{% elif severity == 'SEV2' %}fd7e14{% else %}ffc107{% endif %}; color: white; padding: 20px;">
        <h2>{{ severity }} Incident - Executive Summary</h2>
    </div>

    <div style="padding: 20px;">
        <h3>{{ title }}</h3>

        <div style="background-color: #fff3cd; padding: 15px; border-left: 5px solid #ffc107; margin: 20px 0;">
            <h4>Business Impact</h4>
            <p>{{ customer_impact or impact }}</p>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Incident Status:</strong></td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">{{ status }}</td>
            </tr>
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Duration:</strong></td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">{{ (datetime.utcnow() - started_at).total_seconds() // 60 }} minutes</td>
            </tr>
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Incident Commander:</strong></td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">{{ incident_commander }}</td>
            </tr>
            {% if estimated_resolution %}
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Estimated Resolution:</strong></td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">{{ estimated_resolution.strftime('%Y-%m-%d %H:%M:%S UTC') }}</td>
            </tr>
            {% endif %}
        </table>

        <h4>Affected Services</h4>
        <ul>
        {% for service in affected_services %}
            <li>{{ service }}</li>
        {% endfor %}
        </ul>

        <p style="margin-top: 30px; padding: 15px; background-color: #f8f9fa; border-radius: 5px;">
            <strong>For additional details or questions, please contact the Incident Commander.</strong>
        </p>
    </div>
</body>
</html>
                """)
            },

            "customer_friendly": {
                "status_page": Template("""
We are currently investigating an issue affecting {{ affected_services|join(', ') }}.

{% if customer_impact %}
{{ customer_impact }}
{% else %}
Some customers may experience {{ impact }}.
{% endif %}

Our engineering team is actively working on resolving this issue. We will provide updates as more information becomes available.

Started: {{ started_at.strftime('%Y-%m-%d %H:%M:%S UTC') }}
Status: {{ status }}
                """)
            }
        }

    async def __aenter__(self):
        """Async context manager entry"""
        self.session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        if self.session:
            await self.session.close()

    async def send_notification(self,
                               channel: str,
                               audience: str,
                               context: NotificationContext,
                               priority: NotificationPriority = NotificationPriority.HIGH) -> NotificationResult:
        """Send notification via specified channel"""
        try:
            if channel == "slack":
                return await self._send_slack(audience, context, priority)
            elif channel == "email":
                return await self._send_email(audience, context, priority)
            elif channel == "pagerduty":
                return await self._send_pagerduty(audience, context, priority)
            elif channel == "sms":
                return await self._send_sms(audience, context, priority)
            elif channel == "status_page":
                return await self._update_status_page(context)
            else:
                return NotificationResult(
                    channel=channel,
                    success=False,
                    error=f"Unknown channel: {channel}"
                )
        except Exception as e:
            self.logger.error(f"Failed to send {channel} notification: {e}")
            return NotificationResult(
                channel=channel,
                success=False,
                error=str(e)
            )

    async def _send_slack(self, audience: str, context: NotificationContext,
                         priority: NotificationPriority) -> NotificationResult:
        """Send Slack notification"""
        webhook_url = self.config.get('slack', {}).get('webhook_url')
        if not webhook_url:
            return NotificationResult(
                channel="slack",
                success=False,
                error="Slack webhook URL not configured"
            )

        # Get audience-specific channel
        channel_map = self.config.get('slack', {}).get('channels', {})
        channel = channel_map.get(audience, '#incidents')

        # Render message
        template = self.templates.get('technical_detailed', {}).get('slack')
        message = template.render(**asdict(context), datetime=datetime)

        payload = {
            "channel": channel,
            "text": message,
            "username": "Incident Bot",
            "icon_emoji": ":rotating_light:"
        }

        async with self.session.post(webhook_url, json=payload) as response:
            if response.status == 200:
                return NotificationResult(
                    channel="slack",
                    success=True,
                    message_id=f"slack-{channel}"
                )
            else:
                return NotificationResult(
                    channel="slack",
                    success=False,
                    error=f"HTTP {response.status}"
                )

    async def _send_email(self, audience: str, context: NotificationContext,
                         priority: NotificationPriority) -> NotificationResult:
        """Send email notification"""
        smtp_config = self.config.get('email', {})

        # Determine template based on audience
        if 'executive' in audience.lower():
            template_key = 'executive_summary'
        else:
            template_key = 'technical_detailed'

        templates = self.templates.get(template_key, {})
        subject = templates.get('email_subject').render(**asdict(context))
        body = templates.get('email_body').render(**asdict(context), datetime=datetime)

        # Get recipient list
        recipients = self.config.get('email', {}).get('recipients', {}).get(audience, [])

        # In production, use actual SMTP sending
        # For now, simulate success
        self.logger.info(f"Sending email to {recipients}: {subject}")

        return NotificationResult(
            channel="email",
            success=True,
            message_id=f"email-{audience}-{datetime.utcnow().isoformat()}"
        )

    async def _send_pagerduty(self, audience: str, context: NotificationContext,
                             priority: NotificationPriority) -> NotificationResult:
        """Send PagerDuty notification"""
        api_key = self.config.get('pagerduty', {}).get('api_key')
        if not api_key:
            return NotificationResult(
                channel="pagerduty",
                success=False,
                error="PagerDuty API key not configured"
            )

        service_key = self.config.get('pagerduty', {}).get('services', {}).get(audience)
        if not service_key:
            return NotificationResult(
                channel="pagerduty",
                success=False,
                error=f"No PagerDuty service configured for {audience}"
            )

        payload = {
            "routing_key": service_key,
            "event_action": "trigger",
            "payload": {
                "summary": f"[{context.severity}] {context.title}",
                "severity": priority.value,
                "source": "incident-management-system",
                "custom_details": {
                    "incident_id": context.incident_id,
                    "description": context.description,
                    "impact": context.impact,
                    "affected_services": context.affected_services,
                    "war_room": context.war_room_url
                }
            }
        }

        headers = {
            "Authorization": f"Token token={api_key}",
            "Content-Type": "application/json"
        }

        async with self.session.post(
            "https://events.pagerduty.com/v2/enqueue",
            json=payload,
            headers=headers
        ) as response:
            if response.status == 202:
                data = await response.json()
                return NotificationResult(
                    channel="pagerduty",
                    success=True,
                    message_id=data.get('dedup_key')
                )
            else:
                return NotificationResult(
                    channel="pagerduty",
                    success=False,
                    error=f"HTTP {response.status}"
                )

    async def _send_sms(self, audience: str, context: NotificationContext,
                       priority: NotificationPriority) -> NotificationResult:
        """Send SMS notification via Twilio"""
        twilio_config = self.config.get('twilio', {})

        # Short message for SMS
        message = (
            f"[{context.severity}] Incident #{context.incident_id}: {context.title}. "
            f"War room: {context.war_room_url}"
        )

        # Get phone numbers for audience
        phone_numbers = self.config.get('twilio', {}).get('phone_numbers', {}).get(audience, [])

        self.logger.info(f"Sending SMS to {phone_numbers}: {message}")

        # In production, use Twilio API
        return NotificationResult(
            channel="sms",
            success=True,
            message_id=f"sms-{audience}"
        )

    async def _update_status_page(self, context: NotificationContext) -> NotificationResult:
        """Update status page (e.g., StatusPage.io, Atlassian Statuspage)"""
        api_key = self.config.get('statuspage', {}).get('api_key')
        page_id = self.config.get('statuspage', {}).get('page_id')

        if not api_key or not page_id:
            return NotificationResult(
                channel="status_page",
                success=False,
                error="StatusPage credentials not configured"
            )

        # Render customer-friendly message
        template = self.templates.get('customer_friendly', {}).get('status_page')
        message = template.render(**asdict(context))

        # Map severity to status page impact
        impact_map = {
            "SEV1": "critical",
            "SEV2": "major",
            "SEV3": "minor",
            "SEV4": "minor",
            "SEV5": "none"
        }

        payload = {
            "incident": {
                "name": context.title,
                "status": "investigating",
                "impact_override": impact_map.get(context.severity, "major"),
                "body": message,
                "component_ids": [],  # Map affected_services to component IDs
                "deliver_notifications": True
            }
        }

        headers = {
            "Authorization": f"OAuth {api_key}",
            "Content-Type": "application/json"
        }

        url = f"https://api.statuspage.io/v1/pages/{page_id}/incidents"

        async with self.session.post(url, json=payload, headers=headers) as response:
            if response.status in [200, 201]:
                data = await response.json()
                return NotificationResult(
                    channel="status_page",
                    success=True,
                    message_id=data.get('id')
                )
            else:
                return NotificationResult(
                    channel="status_page",
                    success=False,
                    error=f"HTTP {response.status}"
                )

    async def broadcast_notification(self,
                                    requirements: List,
                                    context: NotificationContext) -> List[NotificationResult]:
        """Broadcast notification to multiple channels"""
        tasks = []

        for req in requirements:
            for channel in req.channels:
                task = self.send_notification(
                    channel=channel.value,
                    audience=req.audience,
                    context=context,
                    priority=NotificationPriority.CRITICAL if req.mandatory else NotificationPriority.HIGH
                )
                tasks.append(task)

        return await asyncio.gather(*tasks)

# Example usage
async def main():
    config = {
        "slack": {
            "webhook_url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
            "channels": {
                "on_call_engineers": "#incidents",
                "engineering_leadership": "#engineering-leadership",
                "customer_success": "#customer-success"
            }
        },
        "email": {
            "recipients": {
                "engineering_leadership": ["eng-leads@company.com"],
                "executive_team": ["executives@company.com"]
            }
        },
        "pagerduty": {
            "api_key": "YOUR_PAGERDUTY_API_KEY",
            "services": {
                "on_call_engineers": "SERVICE_KEY_HERE"
            }
        },
        "statuspage": {
            "api_key": "YOUR_STATUSPAGE_API_KEY",
            "page_id": "YOUR_PAGE_ID"
        }
    }

    context = NotificationContext(
        incident_id="INC-2026-001",
        severity="SEV1",
        title="Database Cluster Outage",
        description="Primary database cluster is unresponsive",
        impact="All customer-facing services are down",
        status="Investigating",
        started_at=datetime.utcnow(),
        affected_services=["API", "Web App", "Mobile App"],
        responders=["alice@company.com", "bob@company.com"],
        incident_commander="alice@company.com",
        war_room_url="https://zoom.us/j/123456789",
        customer_impact="Customers cannot access the application",
        mitigation_steps=[
            "Investigating database cluster health",
            "Checking network connectivity",
            "Preparing failover to backup cluster"
        ]
    )

    async with NotificationEngine(config) as engine:
        # Send Slack notification
        result = await engine.send_notification(
            channel="slack",
            audience="on_call_engineers",
            context=context
        )
        print(f"Slack notification: {result.success}")

        # Update status page
        result = await engine.send_notification(
            channel="status_page",
            audience="external_customers",
            context=context
        )
        print(f"Status page update: {result.success}")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
```

### Intelligent Notification Routing

**Context-Aware Routing System:**
```python
# intelligent_routing.py
from typing import List, Dict, Optional, Set
from dataclasses import dataclass
from datetime import datetime, timedelta
import logging

@dataclass
class NotificationHistory:
    """Track notification history"""
    audience: str
    channel: str
    timestamp: datetime
    acknowledged: bool = False
    ack_timestamp: Optional[datetime] = None

class IntelligentNotificationRouter:
    """
    Routes notifications intelligently based on context, history, and escalation rules
    """

    def __init__(self, communication_matrix, config: Dict):
        self.matrix = communication_matrix
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.notification_history: Dict[str, List[NotificationHistory]] = {}
        self.suppressed_audiences: Set[str] = set()

    def should_notify(self, incident_id: str, severity: str,
                     audience: str, elapsed_minutes: int) -> bool:
        """Determine if notification should be sent"""

        # Check if audience is suppressed
        if audience in self.suppressed_audiences:
            self.logger.info(f"Skipping notification to suppressed audience: {audience}")
            return False

        # Check notification history
        history = self.notification_history.get(incident_id, [])
        audience_history = [h for h in history if h.audience == audience]

        if not audience_history:
            # First notification to this audience
            return True

        # Get last notification
        last_notification = max(audience_history, key=lambda h: h.timestamp)
        minutes_since_last = (datetime.utcnow() - last_notification.timestamp).total_seconds() / 60

        # Check if update frequency has passed
        from incident_communication_matrix import IncidentSeverity
        sev_enum = IncidentSeverity(severity.lower())

        return self.matrix.should_send_update(sev_enum, audience, int(minutes_since_last))

    def get_escalation_targets(self, incident_id: str, severity: str) -> List[Dict]:
        """Get escalation targets for unacknowledged notifications"""
        escalations = []
        history = self.notification_history.get(incident_id, [])

        for notification in history:
            if notification.acknowledged:
                continue

            minutes_elapsed = (datetime.utcnow() - notification.timestamp).total_seconds() / 60

            # Get escalation requirements
            from incident_communication_matrix import IncidentSeverity
            sev_enum = IncidentSeverity(severity.lower())
            requirements = self.matrix.get_requirements(sev_enum)

            for req in requirements:
                if req.audience == notification.audience and req.escalation_if_no_ack_minutes:
                    if minutes_elapsed >= req.escalation_if_no_ack_minutes:
                        escalations.append({
                            "original_audience": notification.audience,
                            "escalate_to": self._get_escalation_target(notification.audience),
                            "reason": f"No acknowledgment after {minutes_elapsed:.1f} minutes"
                        })

        return escalations

    def _get_escalation_target(self, audience: str) -> str:
        """Get escalation target for audience"""
        escalation_map = {
            "on_call_engineers": "engineering_leadership",
            "engineering_leadership": "executive_team",
            "customer_success": "customer_success_leadership"
        }
        return escalation_map.get(audience, "executive_team")

    def record_notification(self, incident_id: str, audience: str,
                          channel: str, timestamp: Optional[datetime] = None):
        """Record that a notification was sent"""
        if timestamp is None:
            timestamp = datetime.utcnow()

        if incident_id not in self.notification_history:
            self.notification_history[incident_id] = []

        self.notification_history[incident_id].append(
            NotificationHistory(
                audience=audience,
                channel=channel,
                timestamp=timestamp
            )
        )

    def record_acknowledgment(self, incident_id: str, audience: str,
                            timestamp: Optional[datetime] = None):
        """Record that a notification was acknowledged"""
        if timestamp is None:
            timestamp = datetime.utcnow()

        history = self.notification_history.get(incident_id, [])
        for notification in reversed(history):
            if notification.audience == audience and not notification.acknowledged:
                notification.acknowledged = True
                notification.ack_timestamp = timestamp
                self.logger.info(f"Recorded acknowledgment from {audience}")
                break

    def suppress_audience(self, audience: str, reason: str):
        """Temporarily suppress notifications to an audience"""
        self.suppressed_audiences.add(audience)
        self.logger.warning(f"Suppressing notifications to {audience}: {reason}")

    def unsuppress_audience(self, audience: str):
        """Remove suppression for an audience"""
        self.suppressed_audiences.discard(audience)
        self.logger.info(f"Removed suppression for {audience}")

    def get_notification_summary(self, incident_id: str) -> Dict:
        """Get summary of all notifications for an incident"""
        history = self.notification_history.get(incident_id, [])

        summary = {
            "total_notifications": len(history),
            "by_audience": {},
            "acknowledgment_rate": 0.0,
            "average_ack_time_minutes": 0.0
        }

        ack_times = []
        for notification in history:
            audience = notification.audience
            if audience not in summary["by_audience"]:
                summary["by_audience"][audience] = {
                    "total": 0,
                    "acknowledged": 0,
                    "channels": []
                }

            summary["by_audience"][audience]["total"] += 1
            if notification.acknowledged:
                summary["by_audience"][audience]["acknowledged"] += 1
                ack_time = (notification.ack_timestamp - notification.timestamp).total_seconds() / 60
                ack_times.append(ack_time)

            if notification.channel not in summary["by_audience"][audience]["channels"]:
                summary["by_audience"][audience]["channels"].append(notification.channel)

        if history:
            ack_count = sum(1 for n in history if n.acknowledged)
            summary["acknowledgment_rate"] = ack_count / len(history)

        if ack_times:
            summary["average_ack_time_minutes"] = sum(ack_times) / len(ack_times)

        return summary
```

## Status Page Automation

**Comprehensive Status Page Integration:**
```python
# status_page_automation.py
import asyncio
import aiohttp
from typing import Dict, List, Optional
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import logging

class ComponentStatus(Enum):
    """Status page component status values"""
    OPERATIONAL = "operational"
    DEGRADED_PERFORMANCE = "degraded_performance"
    PARTIAL_OUTAGE = "partial_outage"
    MAJOR_OUTAGE = "major_outage"
    UNDER_MAINTENANCE = "under_maintenance"

class IncidentStatus(Enum):
    """Status page incident status values"""
    INVESTIGATING = "investigating"
    IDENTIFIED = "identified"
    MONITORING = "monitoring"
    RESOLVED = "resolved"

class IncidentImpact(Enum):
    """Incident impact levels"""
    NONE = "none"
    MINOR = "minor"
    MAJOR = "major"
    CRITICAL = "critical"

@dataclass
class StatusPageComponent:
    """Represents a component on the status page"""
    id: str
    name: str
    status: ComponentStatus
    description: Optional[str] = None

@dataclass
class StatusPageIncident:
    """Represents an incident on the status page"""
    id: Optional[str]
    name: str
    status: IncidentStatus
    impact: IncidentImpact
    body: str
    component_ids: List[str]
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

class StatusPageAutomation:
    """
    Automates status page updates for incidents
    """

    def __init__(self, api_key: str, page_id: str):
        self.api_key = api_key
        self.page_id = page_id
        self.base_url = "https://api.statuspage.io/v1"
        self.logger = logging.getLogger(__name__)
        self.session: Optional[aiohttp.ClientSession] = None

        # Cache components
        self.components: Dict[str, StatusPageComponent] = {}
        self.service_to_component_map: Dict[str, str] = {}

    async def __aenter__(self):
        """Async context manager entry"""
        self.session = aiohttp.ClientSession()
        await self.load_components()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        if self.session:
            await self.session.close()

    def _get_headers(self) -> Dict[str, str]:
        """Get API request headers"""
        return {
            "Authorization": f"OAuth {self.api_key}",
            "Content-Type": "application/json"
        }

    async def load_components(self):
        """Load all components from status page"""
        url = f"{self.base_url}/pages/{self.page_id}/components"

        async with self.session.get(url, headers=self._get_headers()) as response:
            if response.status == 200:
                data = await response.json()
                for comp_data in data:
                    component = StatusPageComponent(
                        id=comp_data['id'],
                        name=comp_data['name'],
                        status=ComponentStatus(comp_data['status']),
                        description=comp_data.get('description')
                    )
                    self.components[component.id] = component
                    # Map component name to ID for easy lookup
                    self.service_to_component_map[component.name.lower()] = component.id

                self.logger.info(f"Loaded {len(self.components)} components")
            else:
                self.logger.error(f"Failed to load components: HTTP {response.status}")

    def map_services_to_components(self, service_names: List[str]) -> List[str]:
        """Map service names to component IDs"""
        component_ids = []
        for service in service_names:
            service_lower = service.lower()
            if service_lower in self.service_to_component_map:
                component_ids.append(self.service_to_component_map[service_lower])
            else:
                self.logger.warning(f"No component found for service: {service}")
        return component_ids

    def severity_to_impact(self, severity: str) -> IncidentImpact:
        """Map incident severity to status page impact"""
        mapping = {
            "SEV1": IncidentImpact.CRITICAL,
            "SEV2": IncidentImpact.MAJOR,
            "SEV3": IncidentImpact.MINOR,
            "SEV4": IncidentImpact.MINOR,
            "SEV5": IncidentImpact.NONE
        }
        return mapping.get(severity, IncidentImpact.MAJOR)

    def severity_to_component_status(self, severity: str) -> ComponentStatus:
        """Map incident severity to component status"""
        mapping = {
            "SEV1": ComponentStatus.MAJOR_OUTAGE,
            "SEV2": ComponentStatus.PARTIAL_OUTAGE,
            "SEV3": ComponentStatus.DEGRADED_PERFORMANCE,
            "SEV4": ComponentStatus.DEGRADED_PERFORMANCE,
            "SEV5": ComponentStatus.OPERATIONAL
        }
        return mapping.get(severity, ComponentStatus.PARTIAL_OUTAGE)

    async def create_incident(self, incident: StatusPageIncident) -> Optional[str]:
        """Create a new incident on the status page"""
        url = f"{self.base_url}/pages/{self.page_id}/incidents"

        payload = {
            "incident": {
                "name": incident.name,
                "status": incident.status.value,
                "impact_override": incident.impact.value,
                "body": incident.body,
                "component_ids": incident.component_ids,
                "deliver_notifications": True
            }
        }

        async with self.session.post(url, json=payload, headers=self._get_headers()) as response:
            if response.status in [200, 201]:
                data = await response.json()
                incident_id = data['id']
                self.logger.info(f"Created incident: {incident_id}")

                # Update component statuses
                await self.update_component_statuses(
                    incident.component_ids,
                    self.severity_to_component_status("SEV1" if incident.impact == IncidentImpact.CRITICAL else "SEV2")
                )

                return incident_id
            else:
                error_text = await response.text()
                self.logger.error(f"Failed to create incident: HTTP {response.status} - {error_text}")
                return None

    async def update_incident(self, incident_id: str, status: IncidentStatus, body: str):
        """Add an update to an existing incident"""
        url = f"{self.base_url}/pages/{self.page_id}/incidents/{incident_id}/incident_updates"

        payload = {
            "incident_update": {
                "status": status.value,
                "body": body,
                "deliver_notifications": True
            }
        }

        async with self.session.post(url, json=payload, headers=self._get_headers()) as response:
            if response.status in [200, 201]:
                self.logger.info(f"Updated incident {incident_id}")
                return True
            else:
                error_text = await response.text()
                self.logger.error(f"Failed to update incident: HTTP {response.status} - {error_text}")
                return False

    async def resolve_incident(self, incident_id: str, resolution_message: str,
                              component_ids: List[str]):
        """Resolve an incident and restore component statuses"""
        # Update incident status
        await self.update_incident(incident_id, IncidentStatus.RESOLVED, resolution_message)

        # Restore component statuses
        await self.update_component_statuses(component_ids, ComponentStatus.OPERATIONAL)

        self.logger.info(f"Resolved incident {incident_id}")

    async def update_component_statuses(self, component_ids: List[str], status: ComponentStatus):
        """Update status for multiple components"""
        tasks = []
        for component_id in component_ids:
            task = self.update_component_status(component_id, status)
            tasks.append(task)

        await asyncio.gather(*tasks)

    async def update_component_status(self, component_id: str, status: ComponentStatus):
        """Update status for a single component"""
        url = f"{self.base_url}/pages/{self.page_id}/components/{component_id}"

        payload = {
            "component": {
                "status": status.value
            }
        }

        async with self.session.patch(url, json=payload, headers=self._get_headers()) as response:
            if response.status == 200:
                self.logger.info(f"Updated component {component_id} to {status.value}")
                return True
            else:
                self.logger.error(f"Failed to update component: HTTP {response.status}")
                return False

    async def schedule_maintenance(self, name: str, component_ids: List[str],
                                  start_time: datetime, end_time: datetime,
                                  description: str):
        """Schedule maintenance window"""
        url = f"{self.base_url}/pages/{self.page_id}/incidents"

        payload = {
            "incident": {
                "name": name,
                "status": "scheduled",
                "scheduled_for": start_time.isoformat(),
                "scheduled_until": end_time.isoformat(),
                "impact_override": "maintenance",
                "body": description,
                "component_ids": component_ids,
                "deliver_notifications": True
            }
        }

        async with self.session.post(url, json=payload, headers=self._get_headers()) as response:
            if response.status in [200, 201]:
                data = await response.json()
                self.logger.info(f"Scheduled maintenance: {data['id']}")
                return data['id']
            else:
                self.logger.error(f"Failed to schedule maintenance: HTTP {response.status}")
                return None

# Example usage
async def main():
    api_key = "YOUR_STATUSPAGE_API_KEY"
    page_id = "YOUR_PAGE_ID"

    async with StatusPageAutomation(api_key, page_id) as status_page:
        # Create incident
        incident = StatusPageIncident(
            id=None,
            name="Database Performance Degradation",
            status=IncidentStatus.INVESTIGATING,
            impact=IncidentImpact.MAJOR,
            body="We are investigating reports of slow response times affecting our API and web application.",
            component_ids=status_page.map_services_to_components(["API", "Web Application"])
        )

        incident_id = await status_page.create_incident(incident)

        if incident_id:
            # Simulate updates
            await asyncio.sleep(5)
            await status_page.update_incident(
                incident_id,
                IncidentStatus.IDENTIFIED,
                "We have identified the cause as high database load and are implementing mitigation strategies."
            )

            await asyncio.sleep(5)
            await status_page.update_incident(
                incident_id,
                IncidentStatus.MONITORING,
                "Database performance has been restored. We are monitoring the situation."
            )

            await asyncio.sleep(5)
            await status_page.resolve_incident(
                incident_id,
                "The issue has been fully resolved. All systems are operating normally.",
                incident.component_ids
            )

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
```

## War Room Management

**Automated War Room Coordination:**
```bash
#!/bin/bash
# war_room_automation.sh

# War Room Automation Script
# Creates and manages incident war rooms with automated setup

set -euo pipefail

# Configuration
SLACK_TOKEN="${SLACK_TOKEN:-}"
ZOOM_API_KEY="${ZOOM_API_KEY:-}"
ZOOM_API_SECRET="${ZOOM_API_SECRET:-}"
INCIDENT_CHANNEL_PREFIX="incident"
JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"
CONFLUENCE_API_TOKEN="${CONFLUENCE_API_TOKEN:-}"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Create Slack war room channel
create_slack_channel() {
    local incident_id="$1"
    local severity="$2"
    local title="$3"

    local channel_name="${INCIDENT_CHANNEL_PREFIX}-${incident_id,,}"

    log_info "Creating Slack channel: ${channel_name}"

    # Create channel
    local response=$(curl -s -X POST "https://slack.com/api/conversations.create" \
        -H "Authorization: Bearer ${SLACK_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
            \"name\": \"${channel_name}\",
            \"is_private\": false
        }")

    local channel_id=$(echo "$response" | jq -r '.channel.id')

    if [ "$channel_id" != "null" ]; then
        log_info "Created channel: ${channel_name} (${channel_id})"

        # Set channel topic
        curl -s -X POST "https://slack.com/api/conversations.setTopic" \
            -H "Authorization: Bearer ${SLACK_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{
                \"channel\": \"${channel_id}\",
                \"topic\": \"[${severity}] ${title}\"
            }" > /dev/null

        # Set channel purpose
        curl -s -X POST "https://slack.com/api/conversations.setPurpose" \
            -H "Authorization: Bearer ${SLACK_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{
                \"channel\": \"${channel_id}\",
                \"purpose\": \"War room for incident ${incident_id}\"
            }" > /dev/null

        # Pin initial message
        local pin_response=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
            -H "Authorization: Bearer ${SLACK_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{
                \"channel\": \"${channel_id}\",
                \"text\": \":rotating_light: *Incident ${incident_id} War Room* :rotating_light:\n\n*Severity:* ${severity}\n*Title:* ${title}\n\n*Quick Links:*\n• Runbook: <link>\n• Dashboard: <link>\n• Status Page: <link>\n\n*Commands:*\n• \`/incident update <message>\` - Post update\n• \`/incident escalate\` - Escalate incident\n• \`/incident resolve\` - Mark as resolved\"
            }")

        local ts=$(echo "$pin_response" | jq -r '.ts')
        curl -s -X POST "https://slack.com/api/pins.add" \
            -H "Authorization: Bearer ${SLACK_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{
                \"channel\": \"${channel_id}\",
                \"timestamp\": \"${ts}\"
            }" > /dev/null

        echo "$channel_id"
    else
        log_error "Failed to create Slack channel"
        echo ""
    fi
}

# Create Zoom meeting
create_zoom_meeting() {
    local incident_id="$1"
    local title="$2"

    log_info "Creating Zoom meeting for incident ${incident_id}"

    # Generate JWT token (simplified - use proper JWT library in production)
    local jwt_token="YOUR_JWT_TOKEN"

    local response=$(curl -s -X POST "https://api.zoom.us/v2/users/me/meetings" \
        -H "Authorization: Bearer ${jwt_token}" \
        -H "Content-Type: application/json" \
        -d "{
            \"topic\": \"Incident ${incident_id}: ${title}\",
            \"type\": 2,
            \"settings\": {
                \"host_video\": true,
                \"participant_video\": true,
                \"join_before_host\": true,
                \"mute_upon_entry\": false,
                \"auto_recording\": \"cloud\"
            }
        }")

    local join_url=$(echo "$response" | jq -r '.join_url')

    if [ "$join_url" != "null" ]; then
        log_info "Created Zoom meeting: ${join_url}"
        echo "$join_url"
    else
        log_error "Failed to create Zoom meeting"
        echo ""
    fi
}

# Create Jira incident ticket
create_jira_ticket() {
    local incident_id="$1"
    local severity="$2"
    local title="$3"
    local description="$4"

    log_info "Creating Jira ticket for incident ${incident_id}"

    local priority="Highest"
    [ "$severity" = "SEV2" ] && priority="High"
    [ "$severity" = "SEV3" ] && priority="Medium"

    local response=$(curl -s -X POST "https://your-domain.atlassian.net/rest/api/3/issue" \
        -H "Authorization: Bearer ${JIRA_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
            \"fields\": {
                \"project\": {
                    \"key\": \"INC\"
                },
                \"summary\": \"[${severity}] ${title}\",
                \"description\": {
                    \"type\": \"doc\",
                    \"version\": 1,
                    \"content\": [{
                        \"type\": \"paragraph\",
                        \"content\": [{
                            \"type\": \"text\",
                            \"text\": \"${description}\"
                        }]
                    }]
                },
                \"issuetype\": {
                    \"name\": \"Incident\"
                },
                \"priority\": {
                    \"name\": \"${priority}\"
                },
                \"labels\": [\"${incident_id}\", \"${severity}\"]
            }
        }")

    local issue_key=$(echo "$response" | jq -r '.key')

    if [ "$issue_key" != "null" ]; then
        log_info "Created Jira ticket: ${issue_key}"
        echo "$issue_key"
    else
        log_error "Failed to create Jira ticket"
        echo ""
    fi
}

# Create Confluence incident page
create_confluence_page() {
    local incident_id="$1"
    local severity="$2"
    local title="$3"
    local slack_channel="$4"
    local zoom_url="$5"
    local jira_key="$6"

    log_info "Creating Confluence incident page"

    local page_content="<h2>Incident Overview</h2>
<table>
<tr><th>Incident ID</th><td>${incident_id}</td></tr>
<tr><th>Severity</th><td><strong>${severity}</strong></td></tr>
<tr><th>Status</th><td>Investigating</td></tr>
<tr><th>Started</th><td>$(date -u '+%Y-%m-%d %H:%M:%S UTC')</td></tr>
</table>

<h2>Quick Links</h2>
<ul>
<li>Slack Channel: <a href=\"https://yourworkspace.slack.com/archives/${slack_channel}\">#${INCIDENT_CHANNEL_PREFIX}-${incident_id,,}</a></li>
<li>Zoom Meeting: <a href=\"${zoom_url}\">Join War Room</a></li>
<li>Jira Ticket: <a href=\"https://your-domain.atlassian.net/browse/${jira_key}\">${jira_key}</a></li>
</ul>

<h2>Timeline</h2>
<table>
<tr><th>Time</th><th>Event</th><th>By</th></tr>
<tr><td>$(date -u '+%H:%M:%S')</td><td>Incident detected and war room created</td><td>System</td></tr>
</table>

<h2>Impact</h2>
<p><em>To be updated...</em></p>

<h2>Root Cause</h2>
<p><em>Under investigation...</em></p>

<h2>Action Items</h2>
<ul>
<li>[ ] Investigate root cause</li>
<li>[ ] Implement mitigation</li>
<li>[ ] Communicate with customers</li>
<li>[ ] Update status page</li>
</ul>"

    local response=$(curl -s -X POST "https://your-domain.atlassian.net/wiki/rest/api/content" \
        -H "Authorization: Bearer ${CONFLUENCE_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
            \"type\": \"page\",
            \"title\": \"Incident ${incident_id}: ${title}\",
            \"space\": {
                \"key\": \"INCIDENTS\"
            },
            \"body\": {
                \"storage\": {
                    \"value\": \"${page_content}\",
                    \"representation\": \"storage\"
                }
            }
        }")

    local page_id=$(echo "$response" | jq -r '.id')

    if [ "$page_id" != "null" ]; then
        local page_url="https://your-domain.atlassian.net/wiki/spaces/INCIDENTS/pages/${page_id}"
        log_info "Created Confluence page: ${page_url}"
        echo "$page_url"
    else
        log_error "Failed to create Confluence page"
        echo ""
    fi
}

# Invite responders to war room
invite_responders() {
    local channel_id="$1"
    shift
    local responders=("$@")

    log_info "Inviting responders to war room"

    for responder in "${responders[@]}"; do
        # Get user ID from email
        local user_response=$(curl -s -X GET "https://slack.com/api/users.lookupByEmail?email=${responder}" \
            -H "Authorization: Bearer ${SLACK_TOKEN}")

        local user_id=$(echo "$user_response" | jq -r '.user.id')

        if [ "$user_id" != "null" ]; then
            curl -s -X POST "https://slack.com/api/conversations.invite" \
                -H "Authorization: Bearer ${SLACK_TOKEN}" \
                -H "Content-Type: application/json" \
                -d "{
                    \"channel\": \"${channel_id}\",
                    \"users\": \"${user_id}\"
                }" > /dev/null

            log_info "Invited ${responder}"
        fi
    done
}

# Main war room setup
setup_war_room() {
    local incident_id="$1"
    local severity="$2"
    local title="$3"
    local description="$4"
    shift 4
    local responders=("$@")

    log_info "Setting up war room for incident ${incident_id}"

    # Create Slack channel
    local slack_channel=$(create_slack_channel "$incident_id" "$severity" "$title")

    # Create Zoom meeting
    local zoom_url=$(create_zoom_meeting "$incident_id" "$title")

    # Create Jira ticket
    local jira_key=$(create_jira_ticket "$incident_id" "$severity" "$title" "$description")

    # Create Confluence page
    local confluence_url=$(create_confluence_page "$incident_id" "$severity" "$title" "$slack_channel" "$zoom_url" "$jira_key")

    # Invite responders
    if [ -n "$slack_channel" ]; then
        invite_responders "$slack_channel" "${responders[@]}"
    fi

    # Post summary to Slack
    if [ -n "$slack_channel" ]; then
        curl -s -X POST "https://slack.com/api/chat.postMessage" \
            -H "Authorization: Bearer ${SLACK_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{
                \"channel\": \"${slack_channel}\",
                \"text\": \"War room setup complete!\",
                \"blocks\": [{
                    \"type\": \"section\",
                    \"text\": {
                        \"type\": \"mrkdwn\",
                        \"text\": \"*War Room Resources Created:*\n\n• Zoom Meeting: ${zoom_url}\n• Jira Ticket: ${jira_key}\n• Confluence Page: ${confluence_url}\n\n*Responders have been invited to this channel.*\"
                    }
                }]
            }" > /dev/null
    fi

    # Output summary
    cat <<EOF

${GREEN}War Room Setup Complete!${NC}

Incident ID: ${incident_id}
Severity: ${severity}
Title: ${title}

Resources Created:
- Slack Channel: #${INCIDENT_CHANNEL_PREFIX}-${incident_id,,}
- Zoom Meeting: ${zoom_url}
- Jira Ticket: ${jira_key}
- Confluence Page: ${confluence_url}

Responders Invited:
$(printf "  - %s\n" "${responders[@]}")

EOF
}

# Example usage
if [ "$#" -lt 4 ]; then
    echo "Usage: $0 <incident_id> <severity> <title> <description> [responder_emails...]"
    exit 1
fi

INCIDENT_ID="$1"
SEVERITY="$2"
TITLE="$3"
DESCRIPTION="$4"
shift 4
RESPONDERS=("$@")

setup_war_room "$INCIDENT_ID" "$SEVERITY" "$TITLE" "$DESCRIPTION" "${RESPONDERS[@]}"
```

## Communication Templates

**Production-Ready Message Templates:**
```yaml
# communication_templates.yaml
templates:
  initial_notification:
    technical:
      subject: "[{{severity}}] Incident #{{incident_id}}: {{title}}"
      body: |
        We are investigating an incident affecting {{affected_services}}.

        Severity: {{severity}}
        Status: {{status}}
        Impact: {{impact}}
        Started: {{started_at}}

        Affected Services:
        {{#each affected_services}}
        - {{this}}
        {{/each}}

        War Room: {{war_room_url}}
        Incident Commander: {{incident_commander}}

        Technical Details:
        {{description}}

        Current Actions:
        {{#each actions}}
        {{inc @index}}. {{this}}
        {{/each}}

    executive:
      subject: "[{{severity}}] Business Impact Alert: {{title}}"
      body: |
        A {{severity}} incident is currently affecting our services.

        Business Impact:
        {{customer_impact}}

        Status: {{status}}
        Duration: {{duration}}
        Incident Commander: {{incident_commander}}

        We will provide updates every {{update_frequency}} minutes.

    customer:
      subject: "Service Update: {{title}}"
      body: |
        We are currently experiencing an issue that may affect your service.

        {{customer_impact}}

        Our team is actively working to resolve this issue. We will keep you updated on our progress.

        For the latest updates, please visit our status page at {{status_page_url}}

        We apologize for any inconvenience.

  update_notification:
    technical:
      subject: "[{{severity}}] Update: Incident #{{incident_id}}"
      body: |
        Update for incident #{{incident_id}}:

        Status: {{status}}
        Time Elapsed: {{elapsed_time}}

        Latest Update:
        {{update_message}}

        {{#if resolution_eta}}
        Estimated Resolution: {{resolution_eta}}
        {{/if}}

        {{#if actions_completed}}
        Completed Actions:
        {{#each actions_completed}}
        - {{this}}
        {{/each}}
        {{/if}}

        {{#if next_steps}}
        Next Steps:
        {{#each next_steps}}
        - {{this}}
        {{/each}}
        {{/if}}

    customer:
      subject: "Service Update: {{title}}"
      body: |
        Update on the ongoing service issue:

        {{update_message}}

        {{#if resolution_eta}}
        We expect to have this resolved by {{resolution_eta}}.
        {{/if}}

        Thank you for your patience.

  resolution_notification:
    technical:
      subject: "[RESOLVED] Incident #{{incident_id}}: {{title}}"
      body: |
        Incident #{{incident_id}} has been RESOLVED.

        Duration: {{total_duration}}
        Resolution Time: {{resolved_at}}

        Resolution Summary:
        {{resolution_summary}}

        Root Cause:
        {{root_cause}}

        Actions Taken:
        {{#each actions_taken}}
        {{inc @index}}. {{this}}
        {{/each}}

        Follow-up Items:
        {{#each followup_items}}
        - {{this}}
        {{/each}}

        Post-Mortem:
        A detailed post-mortem will be published at {{postmortem_url}}

    customer:
      subject: "[RESOLVED] Service Issue: {{title}}"
      body: |
        The service issue affecting {{affected_services}} has been resolved.

        Impact Duration: {{total_duration}}

        What Happened:
        {{customer_friendly_summary}}

        What We Did:
        {{customer_friendly_resolution}}

        We apologize for any inconvenience this may have caused. If you continue to experience issues, please contact our support team.

        Thank you for your patience.

  escalation_notification:
    subject: "[ESCALATION] Incident #{{incident_id}} requires attention"
    body: |
      Incident #{{incident_id}} is being escalated to you.

      Reason: {{escalation_reason}}
      Original Assignee: {{original_assignee}}
      Time Since Notification: {{time_since_notification}}

      Incident Details:
      Severity: {{severity}}
      Title: {{title}}
      Impact: {{impact}}

      IMMEDIATE ACTION REQUIRED

      War Room: {{war_room_url}}
      Incident Commander: {{incident_commander}}
```

## Compliance and Audit

**Communication Audit Trail:**
```python
# communication_audit.py
from typing import List, Dict, Optional
from dataclasses import dataclass, asdict
from datetime import datetime
import json
import logging
from pathlib import Path

@dataclass
class CommunicationAuditEntry:
    """Audit trail entry for communications"""
    timestamp: datetime
    incident_id: str
    communication_type: str  # notification, update, escalation, resolution
    channel: str
    audience: str
    sender: str
    message_id: Optional[str]
    subject: Optional[str]
    body_hash: str  # SHA256 hash of message body
    recipients_count: int
    delivery_status: str  # sent, delivered, failed
    acknowledgments: List[Dict[str, datetime]]
    metadata: Dict

class CommunicationAuditLogger:
    """
    Maintains comprehensive audit trail of all incident communications
    for compliance and analysis
    """

    def __init__(self, audit_dir: str):
        self.audit_dir = Path(audit_dir)
        self.audit_dir.mkdir(parents=True, exist_ok=True)
        self.logger = logging.getLogger(__name__)

    def log_communication(self, entry: CommunicationAuditEntry):
        """Log communication to audit trail"""
        # Daily audit file
        audit_file = self.audit_dir / f"communications_{entry.timestamp.strftime('%Y-%m-%d')}.jsonl"

        with open(audit_file, 'a') as f:
            entry_dict = asdict(entry)
            entry_dict['timestamp'] = entry.timestamp.isoformat()
            f.write(json.dumps(entry_dict) + '\n')

        self.logger.info(f"Logged communication audit entry: {entry.communication_type} via {entry.channel}")

    def get_incident_communications(self, incident_id: str) -> List[CommunicationAuditEntry]:
        """Retrieve all communications for an incident"""
        entries = []

        for audit_file in self.audit_dir.glob("communications_*.jsonl"):
            with open(audit_file, 'r') as f:
                for line in f:
                    data = json.loads(line)
                    if data['incident_id'] == incident_id:
                        data['timestamp'] = datetime.fromisoformat(data['timestamp'])
                        entries.append(CommunicationAuditEntry(**data))

        return sorted(entries, key=lambda e: e.timestamp)

    def generate_communication_report(self, incident_id: str) -> Dict:
        """Generate comprehensive communication report for incident"""
        communications = self.get_incident_communications(incident_id)

        report = {
            "incident_id": incident_id,
            "total_communications": len(communications),
            "by_channel": {},
            "by_audience": {},
            "timeline": [],
            "response_times": {
                "average_ack_time_minutes": 0,
                "median_ack_time_minutes": 0,
                "fastest_ack_minutes": 0,
                "slowest_ack_minutes": 0
            },
            "delivery_stats": {
                "total_sent": 0,
                "delivered": 0,
                "failed": 0,
                "delivery_rate": 0
            }
        }

        ack_times = []

        for comm in communications:
            # By channel stats
            channel = comm.channel
            if channel not in report["by_channel"]:
                report["by_channel"][channel] = {"count": 0, "failed": 0}
            report["by_channel"][channel]["count"] += 1
            if comm.delivery_status == "failed":
                report["by_channel"][channel]["failed"] += 1

            # By audience stats
            audience = comm.audience
            if audience not in report["by_audience"]:
                report["by_audience"][audience] = {"count": 0, "acks": 0}
            report["by_audience"][audience]["count"] += 1
            report["by_audience"][audience]["acks"] += len(comm.acknowledgments)

            # Timeline
            report["timeline"].append({
                "timestamp": comm.timestamp.isoformat(),
                "type": comm.communication_type,
                "channel": comm.channel,
                "audience": comm.audience
            })

            # Response times
            for ack in comm.acknowledgments:
                ack_time = (ack['timestamp'] - comm.timestamp).total_seconds() / 60
                ack_times.append(ack_time)

            # Delivery stats
            report["delivery_stats"]["total_sent"] += 1
            if comm.delivery_status == "delivered":
                report["delivery_stats"]["delivered"] += 1
            elif comm.delivery_status == "failed":
                report["delivery_stats"]["failed"] += 1

        # Calculate response time stats
        if ack_times:
            ack_times_sorted = sorted(ack_times)
            report["response_times"]["average_ack_time_minutes"] = sum(ack_times) / len(ack_times)
            report["response_times"]["median_ack_time_minutes"] = ack_times_sorted[len(ack_times_sorted) // 2]
            report["response_times"]["fastest_ack_minutes"] = min(ack_times)
            report["response_times"]["slowest_ack_minutes"] = max(ack_times)

        # Calculate delivery rate
        if report["delivery_stats"]["total_sent"] > 0:
            report["delivery_stats"]["delivery_rate"] = (
                report["delivery_stats"]["delivered"] / report["delivery_stats"]["total_sent"]
            )

        return report
```

## Conclusion

Effective incident communication requires:

1. **Clear Protocols**: Well-defined communication matrices
2. **Automation**: Intelligent routing and notification systems
3. **Multi-Channel**: Redundant communication paths
4. **Stakeholder Management**: Appropriate messaging for each audience
5. **Audit Trails**: Complete records for compliance
6. **War Room Coordination**: Centralized incident response
7. **Status Transparency**: Automated customer communications

This comprehensive framework ensures that all stakeholders receive timely, relevant information during incidents while maintaining compliance and enabling effective coordination.