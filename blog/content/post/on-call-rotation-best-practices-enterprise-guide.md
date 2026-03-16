---
title: "On-Call Rotation Best Practices: Building Sustainable Incident Response Teams"
date: 2026-10-14T00:00:00-05:00
draft: false
tags: ["On-Call", "Incident Response", "SRE", "Team Management", "DevOps", "Burnout Prevention"]
categories: ["DevOps", "Site Reliability", "Team Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to on-call rotation management for enterprise teams, including scheduling strategies, burnout prevention, escalation policies, and production-ready tooling."
more_link: "yes"
url: "/on-call-rotation-best-practices-enterprise-guide/"
---

Effective on-call management is critical for maintaining system reliability while preventing team burnout. This comprehensive guide covers proven strategies for building sustainable on-call rotations, from scheduling and compensation to tooling and escalation policies.

<!--more-->

## Executive Summary

On-call rotations are essential but challenging for modern engineering teams. This guide provides enterprise teams with comprehensive strategies for designing fair, sustainable on-call programs that balance system reliability with engineer well-being. We cover scheduling patterns, compensation models, escalation policies, tooling, and metrics for continuous improvement, with production-ready examples and automation tools.

## On-Call Fundamentals

### Designing Fair Rotation Schedules

```python
# oncall_scheduler.py
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Set
from enum import Enum
import random

class RotationType(Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    FOLLOW_THE_SUN = "follow_the_sun"
    PRIMARY_SECONDARY = "primary_secondary"

class ShiftType(Enum):
    BUSINESS_HOURS = "business_hours"  # 9am-5pm weekdays
    EXTENDED_HOURS = "extended_hours"  # 7am-11pm every day
    FULL_TIME = "full_time"           # 24/7
    NIGHT_SHIFT = "night_shift"       # 11pm-7am
    WEEKEND = "weekend"               # Saturday-Sunday

@dataclass
class Engineer:
    name: str
    email: str
    phone: str
    timezone: str
    skill_level: str  # "junior", "mid", "senior", "staff"
    oncall_preferences: Dict[str, any]
    consecutive_shifts: int = 0
    last_oncall_end: Optional[datetime] = None
    total_oncall_hours_month: float = 0

@dataclass
class OnCallShift:
    engineer: Engineer
    start_time: datetime
    end_time: datetime
    shift_type: ShiftType
    is_primary: bool = True
    backup_engineer: Optional[Engineer] = None

@dataclass
class RotationPolicy:
    name: str
    rotation_type: RotationType
    shift_type: ShiftType
    shift_duration_hours: int
    max_consecutive_shifts: int
    min_rest_period_hours: int
    max_monthly_hours: float
    requires_backup: bool
    weekend_multiplier: float = 1.5
    night_multiplier: float = 1.5

class OnCallScheduler:
    """Manages on-call rotation scheduling"""

    def __init__(self):
        self.engineers: List[Engineer] = []
        self.schedule: List[OnCallShift] = []
        self.policies: Dict[str, RotationPolicy] = {}

    def add_engineer(self, engineer: Engineer):
        """Add engineer to on-call pool"""
        self.engineers.append(engineer)

    def create_policy(
        self,
        name: str,
        rotation_type: RotationType,
        shift_type: ShiftType,
        shift_duration_hours: int
    ) -> RotationPolicy:
        """Create an on-call policy"""

        policy = RotationPolicy(
            name=name,
            rotation_type=rotation_type,
            shift_type=shift_type,
            shift_duration_hours=shift_duration_hours,
            max_consecutive_shifts=3,
            min_rest_period_hours=48,
            max_monthly_hours=168,  # ~1 week per month
            requires_backup=True
        )

        self.policies[name] = policy
        return policy

    def generate_schedule(
        self,
        policy_name: str,
        start_date: datetime,
        duration_days: int
    ) -> List[OnCallShift]:
        """Generate on-call schedule"""

        if policy_name not in self.policies:
            raise ValueError(f"Policy not found: {policy_name}")

        policy = self.policies[policy_name]
        schedule = []

        current_time = start_date
        end_time = start_date + timedelta(days=duration_days)

        # Create pool of eligible engineers
        eligible_pool = self._get_eligible_engineers(policy)

        # Track assignments for fairness
        assignment_count = {eng.name: 0 for eng in eligible_pool}

        while current_time < end_time:
            shift_end = current_time + timedelta(hours=policy.shift_duration_hours)

            # Select primary engineer
            primary = self._select_engineer(
                eligible_pool,
                assignment_count,
                current_time,
                policy
            )

            # Select backup if required
            backup = None
            if policy.requires_backup:
                backup = self._select_engineer(
                    [e for e in eligible_pool if e.name != primary.name],
                    assignment_count,
                    current_time,
                    policy
                )

            # Create shift
            shift = OnCallShift(
                engineer=primary,
                start_time=current_time,
                end_time=shift_end,
                shift_type=policy.shift_type,
                is_primary=True,
                backup_engineer=backup
            )

            schedule.append(shift)

            # Update tracking
            assignment_count[primary.name] += 1
            primary.consecutive_shifts += 1
            primary.last_oncall_end = shift_end

            # Calculate weighted hours
            hours = policy.shift_duration_hours
            if self._is_weekend(current_time):
                hours *= policy.weekend_multiplier
            if policy.shift_type == ShiftType.NIGHT_SHIFT:
                hours *= policy.night_multiplier

            primary.total_oncall_hours_month += hours

            # Move to next shift
            current_time = shift_end

        self.schedule.extend(schedule)
        return schedule

    def _get_eligible_engineers(self, policy: RotationPolicy) -> List[Engineer]:
        """Get engineers eligible for policy"""

        eligible = []
        for engineer in self.engineers:
            # Check skill level requirements
            if policy.shift_type == ShiftType.FULL_TIME:
                if engineer.skill_level in ["junior"]:
                    continue  # Full 24/7 requires more experience

            # Check availability preferences
            prefs = engineer.oncall_preferences
            if policy.shift_type == ShiftType.WEEKEND:
                if not prefs.get('available_weekends', True):
                    continue

            eligible.append(engineer)

        return eligible

    def _select_engineer(
        self,
        pool: List[Engineer],
        assignment_count: Dict[str, int],
        shift_start: datetime,
        policy: RotationPolicy
    ) -> Engineer:
        """Select engineer for shift using fairness algorithm"""

        candidates = []

        for engineer in pool:
            # Check consecutive shift limit
            if engineer.consecutive_shifts >= policy.max_consecutive_shifts:
                continue

            # Check rest period
            if engineer.last_oncall_end:
                rest_hours = (shift_start - engineer.last_oncall_end).total_seconds() / 3600
                if rest_hours < policy.min_rest_period_hours:
                    continue

            # Check monthly hour limit
            if engineer.total_oncall_hours_month >= policy.max_monthly_hours:
                continue

            candidates.append(engineer)

        if not candidates:
            raise ValueError("No eligible engineers available")

        # Select engineer with fewest assignments
        selected = min(candidates, key=lambda e: assignment_count[e.name])
        return selected

    def _is_weekend(self, dt: datetime) -> bool:
        """Check if datetime is weekend"""
        return dt.weekday() >= 5  # Saturday = 5, Sunday = 6

    def generate_rotation_report(self) -> Dict:
        """Generate fairness report for rotation"""

        report = {
            'total_shifts': len(self.schedule),
            'engineers': {},
            'fairness_metrics': {}
        }

        # Calculate per-engineer metrics
        for engineer in self.engineers:
            shifts = [s for s in self.schedule if s.engineer.name == engineer.name]

            report['engineers'][engineer.name] = {
                'total_shifts': len(shifts),
                'total_hours': sum(
                    (s.end_time - s.start_time).total_seconds() / 3600
                    for s in shifts
                ),
                'weekend_shifts': sum(
                    1 for s in shifts if self._is_weekend(s.start_time)
                ),
                'consecutive_max': self._calculate_max_consecutive(shifts)
            }

        # Calculate fairness metrics
        shift_counts = [data['total_shifts'] for data in report['engineers'].values()]
        if shift_counts:
            report['fairness_metrics'] = {
                'min_shifts': min(shift_counts),
                'max_shifts': max(shift_counts),
                'avg_shifts': sum(shift_counts) / len(shift_counts),
                'std_dev': self._calculate_std_dev(shift_counts)
            }

        return report

    def _calculate_max_consecutive(self, shifts: List[OnCallShift]) -> int:
        """Calculate maximum consecutive shifts"""
        if not shifts:
            return 0

        sorted_shifts = sorted(shifts, key=lambda s: s.start_time)
        max_consecutive = 1
        current_consecutive = 1

        for i in range(1, len(sorted_shifts)):
            if sorted_shifts[i].start_time == sorted_shifts[i-1].end_time:
                current_consecutive += 1
                max_consecutive = max(max_consecutive, current_consecutive)
            else:
                current_consecutive = 1

        return max_consecutive

    def _calculate_std_dev(self, values: List[float]) -> float:
        """Calculate standard deviation"""
        if not values:
            return 0

        mean = sum(values) / len(values)
        variance = sum((x - mean) ** 2 for x in values) / len(values)
        return variance ** 0.5

    def export_to_pagerduty(self, schedule: List[OnCallShift]) -> str:
        """Export schedule to PagerDuty format"""
        # Implementation for PagerDuty API integration
        pass

    def export_to_calendar(self, schedule: List[OnCallShift]) -> str:
        """Export schedule to iCal format"""
        # Implementation for iCal export
        pass

# Example usage
scheduler = OnCallScheduler()

# Add engineers
scheduler.add_engineer(Engineer(
    name="Alice Johnson",
    email="alice@company.com",
    phone="+1-555-0101",
    timezone="America/New_York",
    skill_level="senior",
    oncall_preferences={
        'available_weekends': True,
        'available_nights': True,
        'max_consecutive_weeks': 2
    }
))

scheduler.add_engineer(Engineer(
    name="Bob Smith",
    email="bob@company.com",
    phone="+1-555-0102",
    timezone="America/Los_Angeles",
    skill_level="mid",
    oncall_preferences={
        'available_weekends': True,
        'available_nights': False,
        'max_consecutive_weeks': 1
    }
))

scheduler.add_engineer(Engineer(
    name="Carol Williams",
    email="carol@company.com",
    phone="+1-555-0103",
    timezone="America/Chicago",
    skill_level="senior",
    oncall_preferences={
        'available_weekends': True,
        'available_nights': True,
        'max_consecutive_weeks': 2
    }
))

# Create policy
policy = scheduler.create_policy(
    name="Primary On-Call",
    rotation_type=RotationType.WEEKLY,
    shift_type=ShiftType.FULL_TIME,
    shift_duration_hours=168  # 1 week
)

# Generate schedule
schedule = scheduler.generate_schedule(
    policy_name="Primary On-Call",
    start_date=datetime(2026, 2, 1),
    duration_days=90
)

# Generate report
report = scheduler.generate_rotation_report()
print(f"Generated {len(schedule)} shifts")
print(f"Fairness metrics: {report['fairness_metrics']}")
```

### Escalation Policies

```yaml
# pagerduty-escalation-policy.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: escalation-policies
  namespace: sre
data:
  escalation-policy.yaml: |
    # Production Escalation Policy
    policies:
      - name: production-critical
        description: Critical production issues
        num_loops: 3
        escalation_rules:
          - escalation_delay_minutes: 0
            targets:
              - type: user
                id: primary_oncall
                name: "Primary On-Call Engineer"

          - escalation_delay_minutes: 15
            targets:
              - type: user
                id: secondary_oncall
                name: "Secondary On-Call Engineer"
              - type: schedule
                id: sre_manager_schedule
                name: "SRE Manager"

          - escalation_delay_minutes: 30
            targets:
              - type: user
                id: engineering_director
                name: "Director of Engineering"
              - type: user
                id: cto
                name: "CTO"

      - name: production-warning
        description: Non-critical production issues
        num_loops: 2
        escalation_rules:
          - escalation_delay_minutes: 0
            targets:
              - type: user
                id: primary_oncall

          - escalation_delay_minutes: 30
            targets:
              - type: user
                id: secondary_oncall

          - escalation_delay_minutes: 60
            targets:
              - type: schedule
                id: sre_manager_schedule

      - name: staging-issues
        description: Staging environment issues
        num_loops: 1
        escalation_rules:
          - escalation_delay_minutes: 0
            targets:
              - type: schedule
                id: platform_team_schedule

          - escalation_delay_minutes: 60
            targets:
              - type: user
                id: platform_lead

    notification_rules:
      - type: sms
        start_delay_minutes: 0
        urgency: high

      - type: phone_call
        start_delay_minutes: 5
        urgency: high

      - type: email
        start_delay_minutes: 0
        urgency: low

      - type: push_notification
        start_delay_minutes: 0
        urgency: all
```

### On-Call Handoff Process

```python
# oncall_handoff.py
from dataclasses import dataclass
from typing import List, Dict, Optional
from datetime import datetime
import json

@dataclass
class HandoffItem:
    """Item to hand off between on-call shifts"""
    title: str
    description: str
    priority: str  # "low", "medium", "high", "critical"
    status: str    # "monitoring", "investigating", "waiting", "resolved"
    created_at: datetime
    links: List[str]
    action_items: List[str]
    context: Dict[str, any]

@dataclass
class OnCallHandoff:
    """On-call handoff report"""
    outgoing_engineer: str
    incoming_engineer: str
    shift_start: datetime
    shift_end: datetime
    total_incidents: int
    resolved_incidents: int
    ongoing_issues: List[HandoffItem]
    notable_events: List[str]
    system_health: Dict[str, str]
    action_items: List[str]
    notes: str

class HandoffManager:
    """Manages on-call handoff process"""

    def __init__(self):
        self.handoffs: List[OnCallHandoff] = []

    def create_handoff(
        self,
        outgoing: str,
        incoming: str,
        shift_start: datetime,
        shift_end: datetime
    ) -> OnCallHandoff:
        """Create handoff report"""

        handoff = OnCallHandoff(
            outgoing_engineer=outgoing,
            incoming_engineer=incoming,
            shift_start=shift_start,
            shift_end=shift_end,
            total_incidents=0,
            resolved_incidents=0,
            ongoing_issues=[],
            notable_events=[],
            system_health={},
            action_items=[],
            notes=""
        )

        return handoff

    def add_ongoing_issue(
        self,
        handoff: OnCallHandoff,
        title: str,
        description: str,
        priority: str,
        status: str
    ):
        """Add ongoing issue to handoff"""

        issue = HandoffItem(
            title=title,
            description=description,
            priority=priority,
            status=status,
            created_at=datetime.now(),
            links=[],
            action_items=[],
            context={}
        )

        handoff.ongoing_issues.append(issue)

    def generate_handoff_report(self, handoff: OnCallHandoff) -> str:
        """Generate formatted handoff report"""

        report = f"""
# On-Call Handoff Report

**From:** {handoff.outgoing_engineer}
**To:** {handoff.incoming_engineer}
**Shift:** {handoff.shift_start.strftime('%Y-%m-%d %H:%M')} - {handoff.shift_end.strftime('%Y-%m-%d %H:%M')}

## Summary
- Total Incidents: {handoff.total_incidents}
- Resolved: {handoff.resolved_incidents}
- Ongoing Issues: {len(handoff.ongoing_issues)}

## Ongoing Issues
"""

        for issue in sorted(handoff.ongoing_issues, key=lambda x: x.priority, reverse=True):
            report += f"""
### {issue.title} [{issue.priority.upper()}]
**Status:** {issue.status}
**Description:** {issue.description}
"""
            if issue.links:
                report += f"**Links:** {', '.join(issue.links)}\n"

            if issue.action_items:
                report += "**Action Items:**\n"
                for action in issue.action_items:
                    report += f"- {action}\n"

        if handoff.notable_events:
            report += "\n## Notable Events\n"
            for event in handoff.notable_events:
                report += f"- {event}\n"

        if handoff.system_health:
            report += "\n## System Health\n"
            for system, status in handoff.system_health.items():
                report += f"- **{system}:** {status}\n"

        if handoff.action_items:
            report += "\n## Action Items for Incoming On-Call\n"
            for action in handoff.action_items:
                report += f"- [ ] {action}\n"

        if handoff.notes:
            report += f"\n## Additional Notes\n{handoff.notes}\n"

        return report

    def send_handoff_notification(
        self,
        handoff: OnCallHandoff,
        channels: List[str]
    ):
        """Send handoff notification"""

        report = self.generate_handoff_report(handoff)

        # Send to Slack
        if 'slack' in channels:
            self._send_to_slack(handoff, report)

        # Send via email
        if 'email' in channels:
            self._send_via_email(handoff, report)

        # Update wiki/documentation
        if 'wiki' in channels:
            self._update_wiki(handoff, report)

    def _send_to_slack(self, handoff: OnCallHandoff, report: str):
        """Send handoff to Slack"""
        # Implementation for Slack API
        pass

    def _send_via_email(self, handoff: OnCallHandoff, report: str):
        """Send handoff via email"""
        # Implementation for email sending
        pass

    def _update_wiki(self, handoff: OnCallHandoff, report: str):
        """Update wiki with handoff information"""
        # Implementation for wiki update
        pass

# Example usage
manager = HandoffManager()

handoff = manager.create_handoff(
    outgoing="Alice Johnson",
    incoming="Bob Smith",
    shift_start=datetime(2026, 2, 1, 0, 0),
    shift_end=datetime(2026, 2, 8, 0, 0)
)

handoff.total_incidents = 12
handoff.resolved_incidents = 10

manager.add_ongoing_issue(
    handoff,
    title="Database Replication Lag",
    description="Replication lag increased to 30 seconds during peak traffic",
    priority="high",
    status="monitoring"
)

manager.add_ongoing_issue(
    handoff,
    title="Payment API Latency",
    description="95th percentile latency up 20% since deployment",
    priority="medium",
    status="investigating"
)

handoff.notable_events = [
    "Deployed v2.5.0 to production successfully",
    "Handled minor outage in user-service (5 minutes downtime)",
    "Scaled payment-service from 10 to 15 replicas due to traffic"
]

handoff.system_health = {
    "Core Services": "Healthy",
    "Databases": "Degraded (replication lag)",
    "CDN": "Healthy",
    "Message Queue": "Healthy"
}

handoff.action_items = [
    "Monitor database replication lag",
    "Review payment API performance metrics",
    "Follow up on capacity planning discussion"
]

report = manager.generate_handoff_report(handoff)
print(report)
```

## Preventing Burnout

### Measuring On-Call Burden

```python
# oncall_metrics.py
from dataclasses import dataclass
from typing import List, Dict
from datetime import datetime, timedelta
import statistics

@dataclass
class IncidentMetrics:
    """Metrics for an incident"""
    incident_id: str
    severity: str
    duration_minutes: int
    time_to_acknowledge_minutes: int
    time_to_resolve_minutes: int
    occurred_at: datetime
    oncall_engineer: str

@dataclass
class OnCallBurdenMetrics:
    """Metrics for measuring on-call burden"""
    engineer_name: str
    period_start: datetime
    period_end: datetime

    # Volume metrics
    total_incidents: int
    critical_incidents: int
    after_hours_incidents: int

    # Time metrics
    total_incident_duration_hours: float
    avg_incident_duration_minutes: float
    total_time_to_resolve_hours: float

    # Sleep disruption
    sleep_disruptions: int
    avg_hours_between_incidents: float

    # Workload
    incidents_per_day: float
    busiest_day_incidents: int

    # Quality of life
    consecutive_days_with_incidents: int
    longest_incident_free_period_hours: float

    # Calculated score (0-100, higher is worse)
    burden_score: float

class OnCallBurdenAnalyzer:
    """Analyzes on-call burden and identifies at-risk engineers"""

    def __init__(self):
        self.incidents: List[IncidentMetrics] = []

    def add_incident(self, incident: IncidentMetrics):
        """Add incident to analysis"""
        self.incidents.append(incident)

    def calculate_burden(
        self,
        engineer: str,
        start_date: datetime,
        end_date: datetime
    ) -> OnCallBurdenMetrics:
        """Calculate burden metrics for engineer"""

        # Filter incidents for engineer and period
        engineer_incidents = [
            inc for inc in self.incidents
            if inc.oncall_engineer == engineer
            and start_date <= inc.occurred_at <= end_date
        ]

        if not engineer_incidents:
            return self._empty_metrics(engineer, start_date, end_date)

        # Calculate metrics
        total_incidents = len(engineer_incidents)
        critical_incidents = sum(
            1 for inc in engineer_incidents if inc.severity == "critical"
        )

        # After hours incidents (outside 9am-5pm weekdays)
        after_hours = sum(
            1 for inc in engineer_incidents
            if self._is_after_hours(inc.occurred_at)
        )

        # Time metrics
        total_duration = sum(inc.duration_minutes for inc in engineer_incidents) / 60
        avg_duration = statistics.mean([inc.duration_minutes for inc in engineer_incidents])

        total_resolution_time = sum(
            inc.time_to_resolve_minutes for inc in engineer_incidents
        ) / 60

        # Sleep disruption (incidents between 10pm-7am)
        sleep_disruptions = sum(
            1 for inc in engineer_incidents
            if self._is_sleep_hours(inc.occurred_at)
        )

        # Calculate intervals between incidents
        sorted_incidents = sorted(engineer_incidents, key=lambda x: x.occurred_at)
        intervals = []
        for i in range(1, len(sorted_incidents)):
            interval = (sorted_incidents[i].occurred_at - sorted_incidents[i-1].occurred_at).total_seconds() / 3600
            intervals.append(interval)

        avg_hours_between = statistics.mean(intervals) if intervals else 0

        # Calculate incidents per day
        period_days = (end_date - start_date).days
        incidents_per_day = total_incidents / period_days if period_days > 0 else 0

        # Find busiest day
        daily_counts = {}
        for inc in engineer_incidents:
            day = inc.occurred_at.date()
            daily_counts[day] = daily_counts.get(day, 0) + 1

        busiest_day = max(daily_counts.values()) if daily_counts else 0

        # Consecutive days with incidents
        consecutive_days = self._calculate_consecutive_days(engineer_incidents)

        # Longest incident-free period
        longest_free_period = max(intervals) if intervals else 0

        # Calculate burden score (0-100)
        burden_score = self._calculate_burden_score(
            total_incidents=total_incidents,
            critical_incidents=critical_incidents,
            after_hours_incidents=after_hours,
            sleep_disruptions=sleep_disruptions,
            incidents_per_day=incidents_per_day,
            avg_hours_between=avg_hours_between,
            consecutive_days=consecutive_days
        )

        return OnCallBurdenMetrics(
            engineer_name=engineer,
            period_start=start_date,
            period_end=end_date,
            total_incidents=total_incidents,
            critical_incidents=critical_incidents,
            after_hours_incidents=after_hours,
            total_incident_duration_hours=total_duration,
            avg_incident_duration_minutes=avg_duration,
            total_time_to_resolve_hours=total_resolution_time,
            sleep_disruptions=sleep_disruptions,
            avg_hours_between_incidents=avg_hours_between,
            incidents_per_day=incidents_per_day,
            busiest_day_incidents=busiest_day,
            consecutive_days_with_incidents=consecutive_days,
            longest_incident_free_period_hours=longest_free_period,
            burden_score=burden_score
        )

    def _is_after_hours(self, dt: datetime) -> bool:
        """Check if datetime is outside business hours"""
        # Weekend
        if dt.weekday() >= 5:
            return True
        # Outside 9am-5pm
        if dt.hour < 9 or dt.hour >= 17:
            return True
        return False

    def _is_sleep_hours(self, dt: datetime) -> bool:
        """Check if datetime is during typical sleep hours"""
        return dt.hour >= 22 or dt.hour < 7

    def _calculate_consecutive_days(
        self,
        incidents: List[IncidentMetrics]
    ) -> int:
        """Calculate maximum consecutive days with incidents"""
        if not incidents:
            return 0

        days_with_incidents = set(inc.occurred_at.date() for inc in incidents)
        sorted_days = sorted(days_with_incidents)

        max_consecutive = 1
        current_consecutive = 1

        for i in range(1, len(sorted_days)):
            if (sorted_days[i] - sorted_days[i-1]).days == 1:
                current_consecutive += 1
                max_consecutive = max(max_consecutive, current_consecutive)
            else:
                current_consecutive = 1

        return max_consecutive

    def _calculate_burden_score(
        self,
        total_incidents: int,
        critical_incidents: int,
        after_hours_incidents: int,
        sleep_disruptions: int,
        incidents_per_day: float,
        avg_hours_between: float,
        consecutive_days: int
    ) -> float:
        """Calculate overall burden score (0-100)"""

        score = 0

        # Volume component (0-30 points)
        score += min(total_incidents * 2, 20)
        score += min(critical_incidents * 3, 10)

        # Time component (0-30 points)
        score += min(after_hours_incidents * 2, 15)
        score += min(sleep_disruptions * 3, 15)

        # Intensity component (0-25 points)
        if avg_hours_between < 24:
            score += 15
        elif avg_hours_between < 48:
            score += 10
        elif avg_hours_between < 72:
            score += 5

        score += min(incidents_per_day * 5, 10)

        # Sustainability component (0-15 points)
        score += min(consecutive_days * 2, 15)

        return min(score, 100)

    def _empty_metrics(
        self,
        engineer: str,
        start_date: datetime,
        end_date: datetime
    ) -> OnCallBurdenMetrics:
        """Return empty metrics"""
        return OnCallBurdenMetrics(
            engineer_name=engineer,
            period_start=start_date,
            period_end=end_date,
            total_incidents=0,
            critical_incidents=0,
            after_hours_incidents=0,
            total_incident_duration_hours=0,
            avg_incident_duration_minutes=0,
            total_time_to_resolve_hours=0,
            sleep_disruptions=0,
            avg_hours_between_incidents=0,
            incidents_per_day=0,
            busiest_day_incidents=0,
            consecutive_days_with_incidents=0,
            longest_incident_free_period_hours=0,
            burden_score=0
        )

    def identify_at_risk_engineers(
        self,
        threshold_score: float = 60
    ) -> List[OnCallBurdenMetrics]:
        """Identify engineers with high burden scores"""

        # Get unique engineers
        engineers = set(inc.oncall_engineer for inc in self.incidents)

        # Calculate burden for each
        end_date = datetime.now()
        start_date = end_date - timedelta(days=30)

        at_risk = []
        for engineer in engineers:
            metrics = self.calculate_burden(engineer, start_date, end_date)
            if metrics.burden_score >= threshold_score:
                at_risk.append(metrics)

        return sorted(at_risk, key=lambda m: m.burden_score, reverse=True)

    def generate_burden_report(
        self,
        metrics: OnCallBurdenMetrics
    ) -> str:
        """Generate human-readable burden report"""

        # Determine severity level
        if metrics.burden_score >= 75:
            severity = "🔴 CRITICAL"
            recommendation = "Immediate intervention required"
        elif metrics.burden_score >= 60:
            severity = "🟡 WARNING"
            recommendation = "Consider rotation adjustment"
        else:
            severity = "🟢 NORMAL"
            recommendation = "Burden within acceptable range"

        report = f"""
# On-Call Burden Report: {metrics.engineer_name}

**Period:** {metrics.period_start.date()} to {metrics.period_end.date()}
**Burden Score:** {metrics.burden_score:.1f}/100 {severity}
**Recommendation:** {recommendation}

## Volume Metrics
- Total Incidents: {metrics.total_incidents}
- Critical Incidents: {metrics.critical_incidents}
- After-Hours Incidents: {metrics.after_hours_incidents}
- Incidents/Day: {metrics.incidents_per_day:.2f}

## Time Impact
- Total Incident Duration: {metrics.total_incident_duration_hours:.1f} hours
- Avg Incident Duration: {metrics.avg_incident_duration_minutes:.1f} minutes
- Total Time to Resolve: {metrics.total_time_to_resolve_hours:.1f} hours

## Quality of Life
- Sleep Disruptions: {metrics.sleep_disruptions}
- Avg Hours Between Incidents: {metrics.avg_hours_between_incidents:.1f}
- Consecutive Days with Incidents: {metrics.consecutive_days_with_incidents}
- Longest Break: {metrics.longest_incident_free_period_hours:.1f} hours

## Recommendations
"""

        if metrics.burden_score >= 60:
            report += "- Consider rotating off primary on-call\n"
            report += "- Schedule time off for recovery\n"
            report += "- Review system stability issues\n"
            report += "- Consider automation opportunities\n"

        if metrics.sleep_disruptions >= 5:
            report += "- Excessive sleep disruptions detected\n"
            report += "- Consider follow-the-sun rotation model\n"

        if metrics.consecutive_days_with_incidents >= 7:
            report += "- No incident-free days in a week\n"
            report += "- System stability needs attention\n"

        return report
```

## Compensation and Recognition

### Fair Compensation Models

```python
# oncall_compensation.py
from dataclasses import dataclass
from typing import Dict
from datetime import datetime

@dataclass
class CompensationPolicy:
    """On-call compensation policy"""
    base_oncall_pay_per_week: float
    incident_response_hourly_rate: float
    after_hours_multiplier: float
    weekend_multiplier: float
    holiday_multiplier: float
    critical_incident_bonus: float

class OnCallCompensation:
    """Calculate on-call compensation"""

    def __init__(self, policy: CompensationPolicy):
        self.policy = policy

    def calculate_compensation(
        self,
        shift_duration_days: int,
        incident_hours: Dict[str, float],
        has_holiday: bool = False
    ) -> Dict[str, float]:
        """Calculate total compensation"""

        compensation = {
            'base_pay': 0,
            'incident_response': 0,
            'after_hours_premium': 0,
            'weekend_premium': 0,
            'holiday_premium': 0,
            'critical_incident_bonuses': 0,
            'total': 0
        }

        # Base on-call pay
        weeks = shift_duration_days / 7
        compensation['base_pay'] = weeks * self.policy.base_oncall_pay_per_week

        # Incident response pay
        business_hours = incident_hours.get('business', 0)
        after_hours = incident_hours.get('after_hours', 0)
        weekend = incident_hours.get('weekend', 0)

        compensation['incident_response'] = (
            business_hours * self.policy.incident_response_hourly_rate
        )

        compensation['after_hours_premium'] = (
            after_hours *
            self.policy.incident_response_hourly_rate *
            (self.policy.after_hours_multiplier - 1)
        )

        compensation['weekend_premium'] = (
            weekend *
            self.policy.incident_response_hourly_rate *
            (self.policy.weekend_multiplier - 1)
        )

        if has_holiday:
            holiday_hours = incident_hours.get('holiday', 0)
            compensation['holiday_premium'] = (
                holiday_hours *
                self.policy.incident_response_hourly_rate *
                self.policy.holiday_multiplier
            )

        # Critical incident bonuses
        critical_count = incident_hours.get('critical_incidents', 0)
        compensation['critical_incident_bonuses'] = (
            critical_count * self.policy.critical_incident_bonus
        )

        # Total
        compensation['total'] = sum(compensation.values()) - compensation['total']

        return compensation

# Example policy
policy = CompensationPolicy(
    base_oncall_pay_per_week=500,  # $500/week base
    incident_response_hourly_rate=75,  # $75/hour for incident work
    after_hours_multiplier=1.5,  # 1.5x after hours
    weekend_multiplier=2.0,  # 2x weekends
    holiday_multiplier=3.0,  # 3x holidays
    critical_incident_bonus=200  # $200 per critical incident
)

calc = OnCallCompensation(policy)

# Example calculation
compensation = calc.calculate_compensation(
    shift_duration_days=7,
    incident_hours={
        'business': 2,
        'after_hours': 4,
        'weekend': 3,
        'critical_incidents': 1
    }
)

print(f"Total Compensation: ${compensation['total']:.2f}")
```

## Best Practices Summary

### On-Call Excellence Checklist

```yaml
# oncall-excellence-checklist.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: oncall-excellence-checklist
  namespace: sre
data:
  checklist.md: |
    # On-Call Excellence Checklist

    ## Rotation Design
    - [ ] Fair and balanced rotation schedule
    - [ ] Clear escalation policies
    - [ ] Defined shift durations
    - [ ] Backup/secondary coverage
    - [ ] Follow-the-sun for 24/7 if possible
    - [ ] Maximum shift limits enforced
    - [ ] Minimum rest periods defined

    ## Compensation
    - [ ] Competitive on-call pay
    - [ ] Clear compensation policy
    - [ ] Premium for after-hours/weekends
    - [ ] Critical incident bonuses
    - [ ] Time-in-lieu options
    - [ ] Regular compensation reviews

    ## Support Systems
    - [ ] Comprehensive runbooks
    - [ ] Up-to-date documentation
    - [ ] Automated remediation
    - [ ] Effective monitoring/alerting
    - [ ] Easy access to resources
    - [ ] Clear escalation paths

    ## Health & Wellness
    - [ ] Burden metrics tracked
    - [ ] Regular check-ins with team
    - [ ] Mental health resources
    - [ ] Fatigue monitoring
    - [ ] Mandatory breaks enforced
    - [ ] Rotation adjustments as needed

    ## Training
    - [ ] Comprehensive onboarding
    - [ ] Regular game days
    - [ ] Incident simulation exercises
    - [ ] Tool training provided
    - [ ] Knowledge sharing sessions
    - [] Shadowing opportunities

    ## Continuous Improvement
    - [ ] Regular retrospectives
    - [ ] Feedback mechanisms
    - [ ] Process improvements documented
    - [ ] Success metrics tracked
    - [ ] Automation opportunities identified
    - [ ] System reliability improved
```

## Conclusion

Sustainable on-call management requires careful attention to scheduling fairness, burden measurement, adequate compensation, and continuous improvement. By implementing proper rotation strategies, monitoring engineer well-being, providing comprehensive support systems, and fostering a culture of continuous learning, teams can maintain high reliability without sacrificing engineer health and happiness. The key is treating on-call as a critical operational capability that deserves investment and ongoing optimization.