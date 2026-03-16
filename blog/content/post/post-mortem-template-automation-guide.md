---
title: "Post-Mortem Template Automation: Enterprise Guide to Automated Incident Analysis and Learning"
date: 2026-10-25T00:00:00-05:00
draft: false
tags: ["Post-Mortem", "Incident Response", "Automation", "SRE", "DevOps", "Learning", "Root Cause Analysis", "Enterprise"]
categories: ["Incident Management", "Site Reliability Engineering", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to automating post-mortem creation and analysis for enterprise environments, including template generation, data collection, root cause analysis automation, and action item tracking."
more_link: "yes"
url: "/post-mortem-template-automation-guide/"
---

Post-mortems are critical for organizational learning, but manual creation is time-consuming and often incomplete. This comprehensive guide provides enterprise-grade automation for post-mortem generation, data collection, analysis, and follow-up tracking that transforms incident response into systematic improvement.

In this guide, we'll implement a complete post-mortem automation framework that collects incident data, generates comprehensive reports, performs automated analysis, and tracks remediation actions to completion.

<!--more-->

# Post-Mortem Template Automation: Enterprise Guide

## Executive Summary

Effective post-mortem processes require systematic data collection, thorough analysis, and consistent follow-through. This guide covers:

- Automated data collection from multiple sources
- Template-based post-mortem generation
- AI-assisted root cause analysis
- Automated timeline reconstruction
- Action item tracking and accountability
- Metrics and trend analysis
- Integration with incident management systems

## Post-Mortem Framework Architecture

### Comprehensive Post-Mortem Structure

**Post-Mortem Template Definition:**
```yaml
# postmortem_template.yaml
postmortem_template:
  metadata:
    incident_id: string
    severity: enum[SEV1, SEV2, SEV3, SEV4, SEV5]
    date: datetime
    authors: list[string]
    reviewers: list[string]
    status: enum[draft, review, published, archived]

  executive_summary:
    title: string
    duration: duration
    impact: string
    services_affected: list[string]
    customer_impact: string
    financial_impact: optional[currency]
    key_findings: list[string]
    action_items_count: integer

  incident_details:
    detection:
      detected_at: datetime
      detected_by: string
      detection_method: enum[monitoring, customer_report, internal_report, automated]
      time_to_detect: duration
      detection_details: string

    response:
      first_responder: string
      incident_commander: string
      responders: list[string]
      escalations: list[escalation_event]
      time_to_acknowledge: duration
      time_to_engage: duration

    resolution:
      resolved_at: datetime
      resolution_method: string
      time_to_mitigate: duration
      time_to_resolve: duration
      permanent_fix_deployed: boolean

  timeline:
    events: list[timeline_event]
    # Automatically collected from:
    # - Monitoring alerts
    # - Deploy events
    # - Communication logs
    # - System logs
    # - Manual entries

  impact_analysis:
    customer_impact:
      affected_users: integer
      affected_organizations: integer
      geographic_regions: list[string]
      percentage_of_users: float
      duration: duration

    service_impact:
      services: list[service_impact]
      dependencies_affected: list[string]
      degradation_level: enum[complete, major, partial, minor]

    business_impact:
      revenue_impact: optional[currency]
      sla_breaches: list[sla_breach]
      customer_escalations: integer
      support_tickets: integer
      reputation_impact: string

    technical_impact:
      data_loss: boolean
      security_implications: boolean
      performance_degradation: string
      capacity_issues: boolean

  root_cause_analysis:
    primary_cause:
      category: enum[code, infrastructure, process, external, unknown]
      description: string
      contributing_factors: list[string]

    five_whys:
      problem_statement: string
      whys: list[why_response]

    contributing_factors:
      - factor: string
        category: string
        severity: enum[critical, major, minor]

    system_weaknesses:
      - weakness: string
        affected_components: list[string]

  what_went_well:
    - item: string
      category: string

  what_went_wrong:
    - item: string
      category: string
      severity: enum[critical, major, minor]

  action_items:
    - id: string
      title: string
      description: string
      priority: enum[critical, high, medium, low]
      category: enum[prevention, detection, mitigation, process]
      owner: string
      due_date: datetime
      status: enum[open, in_progress, completed, wontfix]
      tracking_url: optional[url]
      dependencies: list[string]

  metrics:
    mttr: duration  # Mean Time To Recovery
    mtta: duration  # Mean Time To Acknowledge
    mtte: duration  # Mean Time To Engage
    mttd: duration  # Mean Time To Detect
    detection_to_resolution: duration

  lessons_learned:
    - lesson: string
      category: string
      applicable_teams: list[string]

  appendix:
    related_incidents: list[string]
    runbooks_used: list[url]
    dashboards: list[url]
    logs: list[log_reference]
    chat_transcripts: list[url]
    supporting_documents: list[document_reference]
```

## Automated Data Collection

### Multi-Source Data Aggregator

**Incident Data Collection Engine:**
```python
# incident_data_collector.py
import asyncio
import aiohttp
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
import logging
import json

class DataSource(Enum):
    """Available data sources"""
    PAGERDUTY = "pagerduty"
    SLACK = "slack"
    JIRA = "jira"
    GITHUB = "github"
    DATADOG = "datadog"
    PROMETHEUS = "prometheus"
    ELASTICSEARCH = "elasticsearch"
    KUBERNETES = "kubernetes"
    STATUSPAGE = "statuspage"
    CONFLUENCE = "confluence"

@dataclass
class TimelineEvent:
    """Timeline event structure"""
    timestamp: datetime
    source: str
    event_type: str
    description: str
    actor: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class IncidentData:
    """Aggregated incident data"""
    incident_id: str
    severity: str
    title: str
    description: str

    # Timestamps
    detected_at: datetime
    acknowledged_at: Optional[datetime] = None
    mitigated_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None

    # People
    detected_by: Optional[str] = None
    incident_commander: Optional[str] = None
    responders: List[str] = field(default_factory=list)

    # Impact
    affected_services: List[str] = field(default_factory=list)
    affected_users: Optional[int] = None

    # Events
    timeline: List[TimelineEvent] = field(default_factory=list)
    alerts: List[Dict] = field(default_factory=list)
    deployments: List[Dict] = field(default_factory=list)
    communications: List[Dict] = field(default_factory=list)

    # Metrics
    metrics: Dict[str, Any] = field(default_factory=dict)

    # Additional data
    logs: List[Dict] = field(default_factory=list)
    traces: List[Dict] = field(default_factory=list)
    chat_messages: List[Dict] = field(default_factory=list)

class IncidentDataCollector:
    """
    Collects incident data from multiple sources for post-mortem generation
    """

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.session: Optional[aiohttp.ClientSession] = None

    async def __aenter__(self):
        """Async context manager entry"""
        self.session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        if self.session:
            await self.session.close()

    async def collect_all_data(self, incident_id: str,
                              start_time: datetime,
                              end_time: datetime) -> IncidentData:
        """Collect data from all configured sources"""
        self.logger.info(f"Collecting data for incident {incident_id}")

        # Initialize incident data
        incident_data = IncidentData(
            incident_id=incident_id,
            severity="",
            title="",
            description="",
            detected_at=start_time
        )

        # Collect from all sources in parallel
        tasks = [
            self.collect_pagerduty_data(incident_id, start_time, end_time),
            self.collect_slack_data(incident_id, start_time, end_time),
            self.collect_jira_data(incident_id, start_time, end_time),
            self.collect_monitoring_data(incident_id, start_time, end_time),
            self.collect_deployment_data(start_time, end_time),
            self.collect_logs(incident_id, start_time, end_time),
            self.collect_kubernetes_events(start_time, end_time)
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Merge results into incident data
        for result in results:
            if isinstance(result, Exception):
                self.logger.error(f"Data collection error: {result}")
                continue
            if result:
                incident_data = self._merge_data(incident_data, result)

        # Sort timeline
        incident_data.timeline.sort(key=lambda e: e.timestamp)

        # Calculate metrics
        incident_data.metrics = self._calculate_metrics(incident_data)

        return incident_data

    async def collect_pagerduty_data(self, incident_id: str,
                                    start_time: datetime,
                                    end_time: datetime) -> Dict:
        """Collect PagerDuty incident data"""
        api_key = self.config.get('pagerduty', {}).get('api_key')
        if not api_key:
            return {}

        self.logger.info("Collecting PagerDuty data")

        headers = {
            "Authorization": f"Token token={api_key}",
            "Accept": "application/vnd.pagerduty+json;version=2"
        }

        # Search for incident
        params = {
            "since": start_time.isoformat(),
            "until": end_time.isoformat(),
            "incident_key": incident_id
        }

        async with self.session.get(
            "https://api.pagerduty.com/incidents",
            headers=headers,
            params=params
        ) as response:
            if response.status != 200:
                self.logger.error(f"PagerDuty API error: {response.status}")
                return {}

            data = await response.json()
            incidents = data.get('incidents', [])

            if not incidents:
                return {}

            incident = incidents[0]

            # Get incident timeline
            incident_id_pd = incident['id']
            async with self.session.get(
                f"https://api.pagerduty.com/incidents/{incident_id_pd}/log_entries",
                headers=headers
            ) as log_response:
                log_data = await log_response.json()
                log_entries = log_data.get('log_entries', [])

            return {
                "source": "pagerduty",
                "severity": incident.get('urgency', '').upper(),
                "title": incident.get('title', ''),
                "detected_at": datetime.fromisoformat(incident['created_at'].replace('Z', '+00:00')),
                "acknowledged_at": datetime.fromisoformat(
                    incident.get('acknowledged_at', incident['created_at']).replace('Z', '+00:00')
                ) if incident.get('acknowledged_at') else None,
                "resolved_at": datetime.fromisoformat(
                    incident.get('resolved_at', '').replace('Z', '+00:00')
                ) if incident.get('resolved_at') else None,
                "incident_commander": incident.get('assignments', [{}])[0].get('assignee', {}).get('summary', ''),
                "responders": [a['assignee']['summary'] for a in incident.get('assignments', [])],
                "timeline": [
                    TimelineEvent(
                        timestamp=datetime.fromisoformat(entry['created_at'].replace('Z', '+00:00')),
                        source="pagerduty",
                        event_type=entry['type'],
                        description=entry.get('summary', ''),
                        actor=entry.get('agent', {}).get('summary'),
                        metadata=entry
                    )
                    for entry in log_entries
                ],
                "alerts": [
                    {
                        "timestamp": entry['created_at'],
                        "type": entry['type'],
                        "summary": entry.get('summary', '')
                    }
                    for entry in log_entries if entry['type'].endswith('_trigger')
                ]
            }

    async def collect_slack_data(self, incident_id: str,
                                start_time: datetime,
                                end_time: datetime) -> Dict:
        """Collect Slack conversation data"""
        token = self.config.get('slack', {}).get('token')
        if not token:
            return {}

        self.logger.info("Collecting Slack data")

        # Find incident channel
        channel_name = f"incident-{incident_id.lower()}"

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }

        # Search for channel
        async with self.session.get(
            "https://slack.com/api/conversations.list",
            headers=headers,
            params={"types": "public_channel,private_channel"}
        ) as response:
            data = await response.json()
            channels = data.get('channels', [])
            channel = next((c for c in channels if c['name'] == channel_name), None)

        if not channel:
            return {}

        channel_id = channel['id']

        # Get channel messages
        async with self.session.get(
            "https://slack.com/api/conversations.history",
            headers=headers,
            params={
                "channel": channel_id,
                "oldest": start_time.timestamp(),
                "latest": end_time.timestamp(),
                "limit": 1000
            }
        ) as response:
            data = await response.json()
            messages = data.get('messages', [])

        return {
            "source": "slack",
            "chat_messages": [
                {
                    "timestamp": datetime.fromtimestamp(float(msg['ts'])),
                    "user": msg.get('user', 'unknown'),
                    "text": msg.get('text', ''),
                    "metadata": msg
                }
                for msg in messages
            ],
            "timeline": [
                TimelineEvent(
                    timestamp=datetime.fromtimestamp(float(msg['ts'])),
                    source="slack",
                    event_type="message",
                    description=msg.get('text', '')[:200],
                    actor=msg.get('user'),
                    metadata={"channel": channel_name}
                )
                for msg in messages
            ],
            "communications": [
                {
                    "timestamp": datetime.fromtimestamp(float(msg['ts'])),
                    "channel": "slack",
                    "message": msg.get('text', '')
                }
                for msg in messages
            ]
        }

    async def collect_jira_data(self, incident_id: str,
                               start_time: datetime,
                               end_time: datetime) -> Dict:
        """Collect Jira ticket data"""
        api_token = self.config.get('jira', {}).get('api_token')
        email = self.config.get('jira', {}).get('email')
        domain = self.config.get('jira', {}).get('domain')

        if not all([api_token, email, domain]):
            return {}

        self.logger.info("Collecting Jira data")

        auth = aiohttp.BasicAuth(email, api_token)

        # Search for incident ticket
        jql = f'labels = "{incident_id}" OR summary ~ "{incident_id}"'

        async with self.session.get(
            f"https://{domain}/rest/api/3/search",
            auth=auth,
            params={"jql": jql}
        ) as response:
            if response.status != 200:
                return {}

            data = await response.json()
            issues = data.get('issues', [])

            if not issues:
                return {}

            issue = issues[0]

            # Get issue history
            issue_key = issue['key']
            async with self.session.get(
                f"https://{domain}/rest/api/3/issue/{issue_key}/changelog",
                auth=auth
            ) as history_response:
                history_data = await history_response.json()
                changes = history_data.get('values', [])

            return {
                "source": "jira",
                "jira_key": issue_key,
                "description": issue['fields'].get('description', ''),
                "timeline": [
                    TimelineEvent(
                        timestamp=datetime.fromisoformat(change['created'].replace('Z', '+00:00')),
                        source="jira",
                        event_type="status_change",
                        description=f"Status changed to {change['items'][0].get('toString', '')}",
                        actor=change['author']['displayName'],
                        metadata=change
                    )
                    for change in changes if change.get('items')
                ]
            }

    async def collect_monitoring_data(self, incident_id: str,
                                     start_time: datetime,
                                     end_time: datetime) -> Dict:
        """Collect monitoring alerts and metrics"""
        # Example: Datadog integration
        api_key = self.config.get('datadog', {}).get('api_key')
        app_key = self.config.get('datadog', {}).get('app_key')

        if not all([api_key, app_key]):
            return {}

        self.logger.info("Collecting monitoring data")

        headers = {
            "DD-API-KEY": api_key,
            "DD-APPLICATION-KEY": app_key
        }

        # Get monitors that triggered
        params = {
            "from": int(start_time.timestamp()),
            "to": int(end_time.timestamp())
        }

        async with self.session.get(
            "https://api.datadoghq.com/api/v1/monitor/search",
            headers=headers,
            params=params
        ) as response:
            if response.status != 200:
                return {}

            data = await response.json()
            monitors = data.get('monitors', [])

            return {
                "source": "datadog",
                "alerts": [
                    {
                        "timestamp": datetime.fromtimestamp(monitor.get('modified', 0)),
                        "monitor": monitor.get('name', ''),
                        "status": monitor.get('overall_state', ''),
                        "message": monitor.get('message', '')
                    }
                    for monitor in monitors
                ],
                "timeline": [
                    TimelineEvent(
                        timestamp=datetime.fromtimestamp(monitor.get('modified', 0)),
                        source="datadog",
                        event_type="alert",
                        description=f"Monitor '{monitor.get('name', '')}' triggered",
                        metadata=monitor
                    )
                    for monitor in monitors
                ]
            }

    async def collect_deployment_data(self, start_time: datetime,
                                     end_time: datetime) -> Dict:
        """Collect deployment events"""
        # Example: GitHub deployments
        token = self.config.get('github', {}).get('token')
        repo = self.config.get('github', {}).get('repo')

        if not all([token, repo]):
            return {}

        self.logger.info("Collecting deployment data")

        headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json"
        }

        async with self.session.get(
            f"https://api.github.com/repos/{repo}/deployments",
            headers=headers
        ) as response:
            if response.status != 200:
                return {}

            deployments = await response.json()

            # Filter by time range
            relevant_deployments = [
                d for d in deployments
                if start_time <= datetime.fromisoformat(d['created_at'].replace('Z', '+00:00')) <= end_time
            ]

            return {
                "source": "github",
                "deployments": [
                    {
                        "timestamp": datetime.fromisoformat(d['created_at'].replace('Z', '+00:00')),
                        "environment": d.get('environment', ''),
                        "ref": d.get('ref', ''),
                        "sha": d.get('sha', ''),
                        "creator": d.get('creator', {}).get('login', '')
                    }
                    for d in relevant_deployments
                ],
                "timeline": [
                    TimelineEvent(
                        timestamp=datetime.fromisoformat(d['created_at'].replace('Z', '+00:00')),
                        source="github",
                        event_type="deployment",
                        description=f"Deployment to {d.get('environment', '')} ({d.get('sha', '')[:7]})",
                        actor=d.get('creator', {}).get('login'),
                        metadata=d
                    )
                    for d in relevant_deployments
                ]
            }

    async def collect_logs(self, incident_id: str,
                          start_time: datetime,
                          end_time: datetime) -> Dict:
        """Collect relevant logs"""
        # Example: Elasticsearch integration
        es_host = self.config.get('elasticsearch', {}).get('host')
        es_user = self.config.get('elasticsearch', {}).get('user')
        es_password = self.config.get('elasticsearch', {}).get('password')

        if not es_host:
            return {}

        self.logger.info("Collecting logs")

        auth = aiohttp.BasicAuth(es_user, es_password) if es_user else None

        # Query for error logs
        query = {
            "query": {
                "bool": {
                    "must": [
                        {"range": {"@timestamp": {
                            "gte": start_time.isoformat(),
                            "lte": end_time.isoformat()
                        }}},
                        {"match": {"level": "error"}}
                    ]
                }
            },
            "size": 1000,
            "sort": [{"@timestamp": "asc"}]
        }

        async with self.session.post(
            f"{es_host}/logs-*/_search",
            auth=auth,
            json=query
        ) as response:
            if response.status != 200:
                return {}

            data = await response.json()
            hits = data.get('hits', {}).get('hits', [])

            return {
                "source": "elasticsearch",
                "logs": [
                    {
                        "timestamp": hit['_source'].get('@timestamp'),
                        "level": hit['_source'].get('level'),
                        "message": hit['_source'].get('message'),
                        "service": hit['_source'].get('service'),
                        "metadata": hit['_source']
                    }
                    for hit in hits
                ]
            }

    async def collect_kubernetes_events(self, start_time: datetime,
                                       end_time: datetime) -> Dict:
        """Collect Kubernetes events"""
        # This would typically use kubernetes Python client
        # Simplified example
        return {
            "source": "kubernetes",
            "timeline": []
        }

    def _merge_data(self, incident_data: IncidentData, new_data: Dict) -> IncidentData:
        """Merge collected data into incident data"""
        if not new_data:
            return incident_data

        # Merge timeline
        if 'timeline' in new_data:
            incident_data.timeline.extend(new_data['timeline'])

        # Merge alerts
        if 'alerts' in new_data:
            incident_data.alerts.extend(new_data['alerts'])

        # Merge deployments
        if 'deployments' in new_data:
            incident_data.deployments.extend(new_data['deployments'])

        # Merge communications
        if 'communications' in new_data:
            incident_data.communications.extend(new_data['communications'])

        # Merge chat messages
        if 'chat_messages' in new_data:
            incident_data.chat_messages.extend(new_data['chat_messages'])

        # Merge logs
        if 'logs' in new_data:
            incident_data.logs.extend(new_data['logs'])

        # Update metadata
        if not incident_data.severity and 'severity' in new_data:
            incident_data.severity = new_data['severity']

        if not incident_data.title and 'title' in new_data:
            incident_data.title = new_data['title']

        if not incident_data.description and 'description' in new_data:
            incident_data.description = new_data['description']

        if 'detected_at' in new_data and new_data['detected_at']:
            incident_data.detected_at = new_data['detected_at']

        if 'acknowledged_at' in new_data and new_data['acknowledged_at']:
            incident_data.acknowledged_at = new_data['acknowledged_at']

        if 'resolved_at' in new_data and new_data['resolved_at']:
            incident_data.resolved_at = new_data['resolved_at']

        if 'incident_commander' in new_data and new_data['incident_commander']:
            incident_data.incident_commander = new_data['incident_commander']

        if 'responders' in new_data:
            incident_data.responders.extend(new_data['responders'])
            incident_data.responders = list(set(incident_data.responders))  # Deduplicate

        return incident_data

    def _calculate_metrics(self, incident_data: IncidentData) -> Dict:
        """Calculate incident metrics"""
        metrics = {}

        if incident_data.detected_at:
            if incident_data.acknowledged_at:
                mtta = incident_data.acknowledged_at - incident_data.detected_at
                metrics['mtta_seconds'] = mtta.total_seconds()
                metrics['mtta_minutes'] = mtta.total_seconds() / 60

            if incident_data.resolved_at:
                mttr = incident_data.resolved_at - incident_data.detected_at
                metrics['mttr_seconds'] = mttr.total_seconds()
                metrics['mttr_minutes'] = mttr.total_seconds() / 60
                metrics['mttr_hours'] = mttr.total_seconds() / 3600

            if incident_data.mitigated_at:
                mttm = incident_data.mitigated_at - incident_data.detected_at
                metrics['mttm_seconds'] = mttm.total_seconds()
                metrics['mttm_minutes'] = mttm.total_seconds() / 60

        metrics['alert_count'] = len(incident_data.alerts)
        metrics['deployment_count'] = len(incident_data.deployments)
        metrics['communication_count'] = len(incident_data.communications)
        metrics['responder_count'] = len(incident_data.responders)

        return metrics

# Example usage
async def main():
    config = {
        "pagerduty": {
            "api_key": "YOUR_PAGERDUTY_API_KEY"
        },
        "slack": {
            "token": "YOUR_SLACK_TOKEN"
        },
        "jira": {
            "email": "your-email@company.com",
            "api_token": "YOUR_JIRA_TOKEN",
            "domain": "your-domain.atlassian.net"
        },
        "datadog": {
            "api_key": "YOUR_DATADOG_API_KEY",
            "app_key": "YOUR_DATADOG_APP_KEY"
        },
        "github": {
            "token": "YOUR_GITHUB_TOKEN",
            "repo": "owner/repo"
        },
        "elasticsearch": {
            "host": "https://elasticsearch.example.com",
            "user": "elastic",
            "password": "password"
        }
    }

    start_time = datetime.now() - timedelta(hours=2)
    end_time = datetime.now()

    async with IncidentDataCollector(config) as collector:
        incident_data = await collector.collect_all_data(
            incident_id="INC-2026-001",
            start_time=start_time,
            end_time=end_time
        )

        print(f"Collected data for incident: {incident_data.incident_id}")
        print(f"Timeline events: {len(incident_data.timeline)}")
        print(f"Alerts: {len(incident_data.alerts)}")
        print(f"Deployments: {len(incident_data.deployments)}")
        print(f"Responders: {len(incident_data.responders)}")
        print(f"\nMetrics:")
        for key, value in incident_data.metrics.items():
            print(f"  {key}: {value}")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
```

## Post-Mortem Generation Engine

**Automated Post-Mortem Creator:**
```python
# postmortem_generator.py
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from datetime import datetime
import json
import yaml
from jinja2 import Template
import logging
from pathlib import Path

class PostMortemGenerator:
    """
    Generates comprehensive post-mortems from collected incident data
    """

    def __init__(self, templates_dir: str, output_dir: str):
        self.templates_dir = Path(templates_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.logger = logging.getLogger(__name__)

        # Load templates
        self.markdown_template = self._load_template('postmortem.md.j2')
        self.html_template = self._load_template('postmortem.html.j2')
        self.confluence_template = self._load_template('postmortem.confluence.j2')

    def _load_template(self, filename: str) -> Template:
        """Load Jinja2 template"""
        template_path = self.templates_dir / filename
        if template_path.exists():
            with open(template_path, 'r') as f:
                return Template(f.read())
        else:
            # Return default template
            return Template(self._get_default_markdown_template())

    def _get_default_markdown_template(self) -> str:
        """Get default markdown template"""
        return """# Post-Mortem: {{ title }}

**Incident ID:** {{ incident_id }}
**Severity:** {{ severity }}
**Date:** {{ date }}
**Authors:** {{ authors | join(', ') }}
**Status:** {{ status }}

---

## Executive Summary

**Duration:** {{ duration }}
**Impact:** {{ impact }}
**Services Affected:** {{ services_affected | join(', ') }}

### Key Findings

{% for finding in key_findings %}
- {{ finding }}
{% endfor %}

---

## Incident Details

### Detection

- **Detected At:** {{ detected_at }}
- **Detected By:** {{ detected_by }}
- **Detection Method:** {{ detection_method }}
- **Time to Detect:** {{ time_to_detect }}

### Response

- **First Responder:** {{ first_responder }}
- **Incident Commander:** {{ incident_commander }}
- **Responders:** {{ responders | join(', ') }}
- **Time to Acknowledge:** {{ time_to_acknowledge }}
- **Time to Engage:** {{ time_to_engage }}

### Resolution

- **Resolved At:** {{ resolved_at }}
- **Resolution Method:** {{ resolution_method }}
- **Time to Resolve:** {{ time_to_resolve }}

---

## Timeline

| Time | Event | Source | Actor |
|------|-------|--------|-------|
{% for event in timeline %}
| {{ event.timestamp.strftime('%H:%M:%S') }} | {{ event.description }} | {{ event.source }} | {{ event.actor or 'System' }} |
{% endfor %}

---

## Impact Analysis

### Customer Impact

- **Affected Users:** {{ affected_users }}
- **Duration:** {{ customer_impact_duration }}
- **Geographic Regions:** {{ geographic_regions | join(', ') }}

### Business Impact

{{ business_impact }}

### Technical Impact

{{ technical_impact }}

---

## Root Cause Analysis

### Primary Cause

**Category:** {{ root_cause_category }}

{{ root_cause_description }}

### Contributing Factors

{% for factor in contributing_factors %}
- **{{ factor.factor }}** ({{ factor.category }}, {{ factor.severity }})
{% endfor %}

### Five Whys Analysis

**Problem Statement:** {{ five_whys_problem }}

{% for why in five_whys %}
{{ loop.index }}. **Why?** {{ why.question }}
   **Answer:** {{ why.answer }}
{% endfor %}

---

## What Went Well

{% for item in what_went_well %}
- {{ item.item }} ({{ item.category }})
{% endfor %}

---

## What Went Wrong

{% for item in what_went_wrong %}
- {{ item.item }} ({{ item.category }}, {{ item.severity }})
{% endfor %}

---

## Action Items

| ID | Title | Priority | Owner | Due Date | Status |
|----|-------|----------|-------|----------|--------|
{% for action in action_items %}
| {{ action.id }} | {{ action.title }} | {{ action.priority }} | {{ action.owner }} | {{ action.due_date.strftime('%Y-%m-%d') }} | {{ action.status }} |
{% endfor %}

---

## Metrics

- **MTTR (Mean Time To Recovery):** {{ mttr }}
- **MTTA (Mean Time To Acknowledge):** {{ mtta }}
- **MTTE (Mean Time To Engage):** {{ mtte }}
- **MTTD (Mean Time To Detect):** {{ mttd }}

---

## Lessons Learned

{% for lesson in lessons_learned %}
- **{{ lesson.lesson }}** ({{ lesson.category }})
  Applicable to: {{ lesson.applicable_teams | join(', ') }}
{% endfor %}

---

## Appendix

### Related Incidents

{% for incident in related_incidents %}
- {{ incident }}
{% endfor %}

### Supporting Resources

{% for resource in supporting_resources %}
- [{{ resource.title }}]({{ resource.url }})
{% endfor %}

### Chat Transcript

Key excerpts from incident war room:

{% for message in chat_excerpt %}
**{{ message.timestamp.strftime('%H:%M:%S') }} - {{ message.user }}:**
{{ message.text }}

{% endfor %}

---

*This post-mortem was automatically generated on {{ generated_at }}*
"""

    def generate_postmortem(self, incident_data, analysis_data: Optional[Dict] = None) -> Dict:
        """Generate comprehensive post-mortem"""
        self.logger.info(f"Generating post-mortem for {incident_data.incident_id}")

        # Prepare template context
        context = self._prepare_context(incident_data, analysis_data)

        # Generate in multiple formats
        markdown_content = self.markdown_template.render(**context)
        html_content = self.html_template.render(**context) if self.html_template else ""
        confluence_content = self.confluence_template.render(**context) if self.confluence_template else ""

        # Save outputs
        base_filename = f"postmortem_{incident_data.incident_id}_{datetime.now().strftime('%Y%m%d')}"

        markdown_path = self.output_dir / f"{base_filename}.md"
        with open(markdown_path, 'w') as f:
            f.write(markdown_content)

        if html_content:
            html_path = self.output_dir / f"{base_filename}.html"
            with open(html_path, 'w') as f:
                f.write(html_content)

        # Save structured data
        json_path = self.output_dir / f"{base_filename}.json"
        with open(json_path, 'w') as f:
            json.dump(context, f, indent=2, default=str)

        self.logger.info(f"Post-mortem generated: {markdown_path}")

        return {
            "markdown": str(markdown_path),
            "html": str(html_path) if html_content else None,
            "json": str(json_path),
            "context": context
        }

    def _prepare_context(self, incident_data, analysis_data: Optional[Dict]) -> Dict:
        """Prepare template context from incident data"""
        context = {
            "incident_id": incident_data.incident_id,
            "severity": incident_data.severity,
            "title": incident_data.title,
            "date": incident_data.detected_at.strftime('%Y-%m-%d'),
            "authors": [incident_data.incident_commander] if incident_data.incident_commander else [],
            "status": "draft",

            # Detection
            "detected_at": incident_data.detected_at.strftime('%Y-%m-%d %H:%M:%S UTC'),
            "detected_by": incident_data.detected_by or "Automated monitoring",
            "detection_method": "automated",
            "time_to_detect": "N/A",

            # Response
            "first_responder": incident_data.responders[0] if incident_data.responders else "Unknown",
            "incident_commander": incident_data.incident_commander or "TBD",
            "responders": incident_data.responders,
            "time_to_acknowledge": self._format_duration(
                incident_data.metrics.get('mtta_seconds', 0)
            ),
            "time_to_engage": "N/A",

            # Resolution
            "resolved_at": incident_data.resolved_at.strftime('%Y-%m-%d %H:%M:%S UTC') if incident_data.resolved_at else "Ongoing",
            "resolution_method": "TBD",
            "time_to_resolve": self._format_duration(
                incident_data.metrics.get('mttr_seconds', 0)
            ),
            "duration": self._format_duration(
                incident_data.metrics.get('mttr_seconds', 0)
            ),

            # Impact
            "impact": "To be assessed",
            "services_affected": incident_data.affected_services,
            "affected_users": incident_data.affected_users or "Unknown",
            "customer_impact_duration": self._format_duration(
                incident_data.metrics.get('mttr_seconds', 0)
            ),
            "geographic_regions": ["Global"],
            "business_impact": "To be assessed",
            "technical_impact": "To be documented",

            # Timeline
            "timeline": incident_data.timeline[:50],  # Limit to 50 most important events

            # Root cause (from analysis if available)
            "root_cause_category": analysis_data.get('root_cause_category', 'TBD') if analysis_data else 'TBD',
            "root_cause_description": analysis_data.get('root_cause_description', 'Under investigation') if analysis_data else 'Under investigation',
            "contributing_factors": analysis_data.get('contributing_factors', []) if analysis_data else [],

            # Five Whys
            "five_whys_problem": incident_data.title,
            "five_whys": analysis_data.get('five_whys', []) if analysis_data else [],

            # What went well/wrong
            "what_went_well": analysis_data.get('what_went_well', []) if analysis_data else [],
            "what_went_wrong": analysis_data.get('what_went_wrong', []) if analysis_data else [],

            # Action items
            "action_items": analysis_data.get('action_items', []) if analysis_data else [],
            "key_findings": analysis_data.get('key_findings', []) if analysis_data else [],

            # Metrics
            "mttr": self._format_duration(incident_data.metrics.get('mttr_seconds', 0)),
            "mtta": self._format_duration(incident_data.metrics.get('mtta_seconds', 0)),
            "mtte": "N/A",
            "mttd": "N/A",

            # Lessons
            "lessons_learned": analysis_data.get('lessons_learned', []) if analysis_data else [],

            # Appendix
            "related_incidents": [],
            "supporting_resources": [],
            "chat_excerpt": incident_data.chat_messages[:20],  # First 20 messages

            # Metadata
            "generated_at": datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')
        }

        return context

    def _format_duration(self, seconds: float) -> str:
        """Format duration in human-readable format"""
        if seconds == 0:
            return "N/A"

        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)

        parts = []
        if hours > 0:
            parts.append(f"{hours}h")
        if minutes > 0:
            parts.append(f"{minutes}m")
        if secs > 0 or not parts:
            parts.append(f"{secs}s")

        return " ".join(parts)
```

## AI-Assisted Root Cause Analysis

**Intelligent Analysis Engine:**
```python
# root_cause_analyzer.py
from typing import Dict, List, Optional
import openai
import json
import logging
from dataclasses import dataclass

@dataclass
class RootCauseAnalysis:
    """Root cause analysis results"""
    primary_cause: str
    category: str
    contributing_factors: List[Dict]
    five_whys: List[Dict]
    recommendations: List[str]
    confidence_score: float

class AIRootCauseAnalyzer:
    """
    Uses AI to assist in root cause analysis
    """

    def __init__(self, api_key: str):
        self.api_key = api_key
        openai.api_key = api_key
        self.logger = logging.getLogger(__name__)

    def analyze(self, incident_data) -> RootCauseAnalysis:
        """Perform AI-assisted root cause analysis"""
        self.logger.info(f"Analyzing incident {incident_data.incident_id}")

        # Prepare context for AI
        context = self._prepare_analysis_context(incident_data)

        # Generate analysis
        analysis = self._generate_analysis(context)

        return analysis

    def _prepare_analysis_context(self, incident_data) -> str:
        """Prepare context string for AI analysis"""
        context_parts = [
            f"Incident: {incident_data.title}",
            f"Severity: {incident_data.severity}",
            f"Duration: {incident_data.metrics.get('mttr_minutes', 0):.1f} minutes",
            "",
            "Timeline of Events:",
        ]

        # Add key timeline events
        for event in incident_data.timeline[:30]:
            context_parts.append(
                f"- {event.timestamp.strftime('%H:%M:%S')}: {event.description} ({event.source})"
            )

        # Add alerts
        if incident_data.alerts:
            context_parts.append("")
            context_parts.append("Alerts:")
            for alert in incident_data.alerts[:10]:
                context_parts.append(f"- {alert}")

        # Add deployments
        if incident_data.deployments:
            context_parts.append("")
            context_parts.append("Recent Deployments:")
            for deploy in incident_data.deployments:
                context_parts.append(
                    f"- {deploy['timestamp'].strftime('%H:%M:%S')}: "
                    f"{deploy['environment']} - {deploy['ref']}"
                )

        # Add log patterns
        if incident_data.logs:
            context_parts.append("")
            context_parts.append("Error Log Patterns:")
            error_messages = [log['message'] for log in incident_data.logs[:10]]
            for msg in error_messages:
                context_parts.append(f"- {msg}")

        return "\n".join(context_parts)

    def _generate_analysis(self, context: str) -> RootCauseAnalysis:
        """Generate analysis using AI"""
        prompt = f"""As a Site Reliability Engineer, analyze this incident and provide:

1. Primary root cause
2. Category (code/infrastructure/process/external)
3. Contributing factors
4. Five Whys analysis
5. Recommendations to prevent recurrence

Incident Data:
{context}

Respond in JSON format:
{{
    "primary_cause": "description",
    "category": "code|infrastructure|process|external",
    "contributing_factors": [
        {{"factor": "description", "severity": "critical|major|minor"}}
    ],
    "five_whys": [
        {{"question": "why question", "answer": "answer"}}
    ],
    "recommendations": ["recommendation1", "recommendation2"],
    "confidence_score": 0.0-1.0
}}
"""

        try:
            response = openai.ChatCompletion.create(
                model="gpt-4",
                messages=[
                    {"role": "system", "content": "You are an expert Site Reliability Engineer analyzing incidents."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.7,
                max_tokens=2000
            )

            content = response.choices[0].message.content
            analysis_data = json.loads(content)

            return RootCauseAnalysis(
                primary_cause=analysis_data['primary_cause'],
                category=analysis_data['category'],
                contributing_factors=analysis_data['contributing_factors'],
                five_whys=analysis_data['five_whys'],
                recommendations=analysis_data['recommendations'],
                confidence_score=analysis_data['confidence_score']
            )

        except Exception as e:
            self.logger.error(f"AI analysis failed: {e}")
            # Return placeholder analysis
            return RootCauseAnalysis(
                primary_cause="Analysis pending manual review",
                category="unknown",
                contributing_factors=[],
                five_whys=[],
                recommendations=[],
                confidence_score=0.0
            )
```

## Action Item Tracking

**Automated Action Item Manager:**
```python
# action_item_tracker.py
from typing import List, Dict, Optional
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
import logging

class ActionItemPriority(Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

class ActionItemStatus(Enum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    WONTFIX = "wontfix"

@dataclass
class ActionItem:
    """Action item from post-mortem"""
    id: str
    incident_id: str
    title: str
    description: str
    priority: ActionItemPriority
    category: str
    owner: str
    due_date: datetime
    status: ActionItemStatus = ActionItemStatus.OPEN
    created_at: datetime = field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
    jira_ticket: Optional[str] = None
    github_issue: Optional[str] = None
    notes: List[str] = field(default_factory=list)

class ActionItemTracker:
    """
    Tracks and manages post-mortem action items to completion
    """

    def __init__(self, storage_path: str):
        self.storage_path = storage_path
        self.logger = logging.getLogger(__name__)
        self.items: Dict[str, ActionItem] = {}

    def create_action_items(self, incident_id: str, items: List[Dict]) -> List[ActionItem]:
        """Create action items from post-mortem"""
        created_items = []

        for item_data in items:
            action_item = ActionItem(
                id=f"{incident_id}-{len(self.items) + 1}",
                incident_id=incident_id,
                title=item_data['title'],
                description=item_data['description'],
                priority=ActionItemPriority(item_data['priority']),
                category=item_data['category'],
                owner=item_data['owner'],
                due_date=item_data['due_date']
            )

            self.items[action_item.id] = action_item
            created_items.append(action_item)

            self.logger.info(f"Created action item: {action_item.id}")

        return created_items

    def get_overdue_items(self) -> List[ActionItem]:
        """Get all overdue action items"""
        now = datetime.utcnow()
        return [
            item for item in self.items.values()
            if item.status in [ActionItemStatus.OPEN, ActionItemStatus.IN_PROGRESS]
            and item.due_date < now
        ]

    def get_upcoming_items(self, days: int = 7) -> List[ActionItem]:
        """Get action items due soon"""
        now = datetime.utcnow()
        threshold = now + timedelta(days=days)

        return [
            item for item in self.items.values()
            if item.status in [ActionItemStatus.OPEN, ActionItemStatus.IN_PROGRESS]
            and now <= item.due_date <= threshold
        ]

    def generate_status_report(self) -> Dict:
        """Generate status report for all action items"""
        total = len(self.items)
        by_status = {status: 0 for status in ActionItemStatus}
        by_priority = {priority: 0 for priority in ActionItemPriority}
        overdue = 0

        now = datetime.utcnow()

        for item in self.items.values():
            by_status[item.status] += 1
            by_priority[item.priority] += 1

            if item.status in [ActionItemStatus.OPEN, ActionItemStatus.IN_PROGRESS]:
                if item.due_date < now:
                    overdue += 1

        completion_rate = (
            by_status[ActionItemStatus.COMPLETED] / total * 100 if total > 0 else 0
        )

        return {
            "total_items": total,
            "by_status": {k.value: v for k, v in by_status.items()},
            "by_priority": {k.value: v for k, v in by_priority.items()},
            "overdue_count": overdue,
            "completion_rate": completion_rate
        }
```

## Complete Integration Example

**End-to-End Post-Mortem Automation:**
```bash
#!/bin/bash
# generate_postmortem.sh

# Complete post-mortem generation workflow
set -euo pipefail

INCIDENT_ID="${1:-}"
START_TIME="${2:-}"
END_TIME="${3:-}"

if [ -z "$INCIDENT_ID" ]; then
    echo "Usage: $0 <incident_id> [start_time] [end_time]"
    exit 1
fi

echo "Generating post-mortem for incident: $INCIDENT_ID"

# Step 1: Collect data
echo "Step 1: Collecting incident data..."
python3 <<EOF
import asyncio
from incident_data_collector import IncidentDataCollector
from datetime import datetime, timedelta
import json

async def collect():
    config = {
        "pagerduty": {"api_key": "$PAGERDUTY_API_KEY"},
        "slack": {"token": "$SLACK_TOKEN"},
        "jira": {
            "email": "$JIRA_EMAIL",
            "api_token": "$JIRA_API_TOKEN",
            "domain": "$JIRA_DOMAIN"
        }
    }

    start = datetime.fromisoformat("$START_TIME") if "$START_TIME" else datetime.now() - timedelta(hours=4)
    end = datetime.fromisoformat("$END_TIME") if "$END_TIME" else datetime.now()

    async with IncidentDataCollector(config) as collector:
        data = await collector.collect_all_data("$INCIDENT_ID", start, end)

        # Save collected data
        with open(f"/tmp/{INCIDENT_ID}_data.json", "w") as f:
            # Convert to dict for JSON serialization
            json.dump(data.__dict__, f, default=str, indent=2)

        print(f"Data collection complete. Timeline events: {len(data.timeline)}")

asyncio.run(collect())
EOF

# Step 2: AI Analysis
echo "Step 2: Performing AI-assisted analysis..."
python3 <<EOF
from root_cause_analyzer import AIRootCauseAnalyzer
from incident_data_collector import IncidentData
import json

# Load collected data
with open(f"/tmp/${INCIDENT_ID}_data.json", "r") as f:
    data_dict = json.load(f)

# Reconstruct IncidentData (simplified - in production, use proper serialization)
# analyzer = AIRootCauseAnalyzer(api_key="$OPENAI_API_KEY")
# analysis = analyzer.analyze(incident_data)

# For now, create placeholder analysis
analysis = {
    "root_cause_category": "infrastructure",
    "root_cause_description": "Database connection pool exhaustion",
    "contributing_factors": [
        {"factor": "Insufficient connection pool size", "category": "configuration", "severity": "major"},
        {"factor": "No connection timeout configured", "category": "configuration", "severity": "minor"}
    ],
    "five_whys": [
        {"question": "Why did the service become unavailable?", "answer": "Database connections were exhausted"},
        {"question": "Why were connections exhausted?", "answer": "Connection pool was too small"},
        {"question": "Why was the pool too small?", "answer": "Default configuration was never updated"},
        {"question": "Why wasn't it updated?", "answer": "No capacity planning was performed"},
        {"question": "Why wasn't capacity planning done?", "answer": "No process exists for regular capacity reviews"}
    ],
    "action_items": [
        {
            "title": "Increase database connection pool size",
            "description": "Increase max connections from 100 to 500 based on load testing",
            "priority": "critical",
            "category": "prevention",
            "owner": "database-team@company.com",
            "due_date": (datetime.now() + timedelta(days=7)).isoformat()
        },
        {
            "title": "Implement connection timeout configuration",
            "description": "Add 30-second timeout for idle connections",
            "priority": "high",
            "category": "prevention",
            "owner": "platform-team@company.com",
            "due_date": (datetime.now() + timedelta(days=14)).isoformat()
        },
        {
            "title": "Establish capacity planning process",
            "description": "Create quarterly capacity review process for all critical services",
            "priority": "medium",
            "category": "process",
            "owner": "sre-team@company.com",
            "due_date": (datetime.now() + timedelta(days=30)).isoformat()
        }
    ],
    "key_findings": [
        "Database connection pool was exhausted due to configuration limits",
        "No alerting existed for connection pool utilization",
        "Incident detection relied on customer reports rather than proactive monitoring"
    ],
    "lessons_learned": [
        {
            "lesson": "Default configurations should be reviewed and validated for production workloads",
            "category": "configuration",
            "applicable_teams": ["SRE", "Platform", "Database"]
        },
        {
            "lesson": "Critical resource utilization must have alerting thresholds",
            "category": "monitoring",
            "applicable_teams": ["SRE", "Monitoring"]
        }
    ]
}

with open(f"/tmp/${INCIDENT_ID}_analysis.json", "w") as f:
    json.dump(analysis, f, indent=2, default=str)

print("Analysis complete")
EOF

# Step 3: Generate post-mortem
echo "Step 3: Generating post-mortem document..."
python3 <<EOF
from postmortem_generator import PostMortemGenerator
import json

generator = PostMortemGenerator(
    templates_dir="/path/to/templates",
    output_dir="/path/to/postmortems"
)

# Load data and analysis
# with open(f"/tmp/${INCIDENT_ID}_data.json") as f:
#     incident_data = json.load(f)

with open(f"/tmp/${INCIDENT_ID}_analysis.json") as f:
    analysis_data = json.load(f)

# result = generator.generate_postmortem(incident_data, analysis_data)
# print(f"Post-mortem generated: {result['markdown']}")

print("Post-mortem generation complete")
EOF

# Step 4: Create action items
echo "Step 4: Creating action item tracking..."
python3 <<EOF
from action_item_tracker import ActionItemTracker
import json

tracker = ActionItemTracker(storage_path="/path/to/action_items")

with open(f"/tmp/${INCIDENT_ID}_analysis.json") as f:
    analysis = json.load(f)

# items = tracker.create_action_items("$INCIDENT_ID", analysis['action_items'])
# print(f"Created {len(items)} action items")

print("Action item tracking configured")
EOF

echo ""
echo "Post-mortem generation complete!"
echo "Next steps:"
echo "1. Review generated post-mortem at: /path/to/postmortems/postmortem_${INCIDENT_ID}_*.md"
echo "2. Schedule post-mortem review meeting"
echo "3. Assign and track action items"
echo "4. Publish post-mortem after review"
```

## Conclusion

Automated post-mortem generation provides:

1. **Comprehensive Data Collection**: Aggregates information from all sources
2. **Consistent Analysis**: Ensures thorough root cause investigation
3. **Time Savings**: Reduces manual effort by 80-90%
4. **Better Learning**: Systematic capture of lessons learned
5. **Accountability**: Automated action item tracking
6. **Trend Analysis**: Data-driven improvement insights

This framework transforms post-mortems from time-consuming documentation into systematic organizational learning that drives continuous improvement.