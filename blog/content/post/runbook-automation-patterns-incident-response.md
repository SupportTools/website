---
title: "Runbook Automation Patterns: From Manual Procedures to Self-Healing Systems"
date: 2026-11-08T00:00:00-05:00
draft: false
tags: ["Runbooks", "Automation", "Incident Response", "SRE", "DevOps", "Self-Healing"]
categories: ["DevOps", "Site Reliability", "Automation"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to runbook automation patterns for incident response, including automated remediation, self-healing systems, and production-ready implementation examples."
more_link: "yes"
url: "/runbook-automation-patterns-incident-response/"
---

Runbook automation transforms manual incident response procedures into automated, reliable systems that reduce MTTR and human error. This comprehensive guide covers patterns, implementation strategies, and production-ready examples for building automated runbooks.

<!--more-->

## Executive Summary

Manual runbooks are essential but insufficient for modern incident response. This guide provides enterprise teams with comprehensive patterns for automating runbooks, from simple script-based automation to sophisticated self-healing systems. We'll cover decision frameworks for choosing automation strategies, implementation patterns with production code, integration with incident management systems, and best practices for maintaining automated runbooks at scale.

## Runbook Automation Fundamentals

### The Runbook Automation Spectrum

```python
# runbook_automation_levels.py
from enum import Enum
from dataclasses import dataclass
from typing import List, Dict, Optional

class AutomationLevel(Enum):
    """Levels of runbook automation maturity"""
    MANUAL = 1           # Documented procedures, human execution
    ASSISTED = 2         # Scripts available, human decides when to run
    SEMI_AUTOMATED = 3   # Automated detection, human approval needed
    AUTOMATED = 4        # Fully automated with human monitoring
    AUTONOMOUS = 5       # Self-healing, minimal human intervention

@dataclass
class RunbookAutomationStrategy:
    """Strategy for automating a runbook"""
    runbook_name: str
    current_level: AutomationLevel
    target_level: AutomationLevel
    risk_level: str  # "low", "medium", "high", "critical"
    complexity: str  # "simple", "moderate", "complex"
    frequency: str   # "hourly", "daily", "weekly", "monthly", "rare"
    business_impact: str
    automation_approach: str
    prerequisites: List[str]
    success_criteria: List[str]

class RunbookAutomationPlanner:
    """Plans runbook automation strategy"""

    def __init__(self):
        self.runbooks: Dict[str, RunbookAutomationStrategy] = {}

    def assess_runbook(
        self,
        name: str,
        risk_level: str,
        complexity: str,
        frequency: str,
        business_impact: str
    ) -> AutomationLevel:
        """Assess appropriate automation level for runbook"""

        # High-risk procedures should have human oversight
        if risk_level == "critical":
            if complexity == "simple" and frequency in ["hourly", "daily"]:
                return AutomationLevel.SEMI_AUTOMATED
            else:
                return AutomationLevel.ASSISTED

        # Frequent, low-risk procedures are good candidates for full automation
        if frequency in ["hourly", "daily"] and risk_level == "low":
            if complexity == "simple":
                return AutomationLevel.AUTONOMOUS
            else:
                return AutomationLevel.AUTOMATED

        # Medium complexity and risk
        if complexity == "moderate" and risk_level == "medium":
            if frequency in ["daily", "weekly"]:
                return AutomationLevel.SEMI_AUTOMATED
            else:
                return AutomationLevel.ASSISTED

        # Default to assisted automation
        return AutomationLevel.ASSISTED

    def create_strategy(
        self,
        name: str,
        current_level: AutomationLevel,
        risk_level: str,
        complexity: str,
        frequency: str,
        business_impact: str
    ) -> RunbookAutomationStrategy:
        """Create automation strategy for runbook"""

        target_level = self.assess_runbook(
            name, risk_level, complexity, frequency, business_impact
        )

        approach = self._determine_approach(
            current_level, target_level, complexity, risk_level
        )

        prerequisites = self._determine_prerequisites(target_level, complexity)

        success_criteria = self._determine_success_criteria(
            target_level, frequency, business_impact
        )

        strategy = RunbookAutomationStrategy(
            runbook_name=name,
            current_level=current_level,
            target_level=target_level,
            risk_level=risk_level,
            complexity=complexity,
            frequency=frequency,
            business_impact=business_impact,
            automation_approach=approach,
            prerequisites=prerequisites,
            success_criteria=success_criteria
        )

        self.runbooks[name] = strategy
        return strategy

    def _determine_approach(
        self,
        current: AutomationLevel,
        target: AutomationLevel,
        complexity: str,
        risk: str
    ) -> str:
        """Determine automation approach"""

        if target == AutomationLevel.AUTONOMOUS:
            return "Build self-healing automation with monitoring and rollback"

        if target == AutomationLevel.AUTOMATED:
            return "Implement automated workflow with alerting and audit logs"

        if target == AutomationLevel.SEMI_AUTOMATED:
            return "Create approval-based automation with human gate"

        if target == AutomationLevel.ASSISTED:
            return "Develop helper scripts with clear documentation"

        return "Document manual procedures with detailed steps"

    def _determine_prerequisites(
        self,
        target: AutomationLevel,
        complexity: str
    ) -> List[str]:
        """Determine prerequisites for automation level"""

        prereqs = [
            "Well-documented manual procedure",
            "Clear success criteria defined",
            "Rollback procedure documented"
        ]

        if target.value >= AutomationLevel.SEMI_AUTOMATED.value:
            prereqs.extend([
                "Monitoring and alerting in place",
                "Automated testing environment",
                "Code review process established"
            ])

        if target.value >= AutomationLevel.AUTOMATED.value:
            prereqs.extend([
                "Comprehensive observability",
                "Automated rollback capability",
                "Integration with incident management"
            ])

        if target.value == AutomationLevel.AUTONOMOUS.value:
            prereqs.extend([
                "Chaos engineering validation",
                "Safety bounds implemented",
                "Automatic anomaly detection"
            ])

        return prereqs

    def _determine_success_criteria(
        self,
        target: AutomationLevel,
        frequency: str,
        business_impact: str
    ) -> List[str]:
        """Determine success criteria"""

        criteria = [
            "Procedure completes successfully",
            "No manual intervention required",
            "Execution time meets SLA"
        ]

        if target.value >= AutomationLevel.AUTOMATED.value:
            criteria.extend([
                "Zero failures in test environment",
                "Comprehensive logging and audit trail",
                "Automatic detection and execution"
            ])

        if target.value == AutomationLevel.AUTONOMOUS.value:
            criteria.extend([
                "Self-corrects without human intervention",
                "Handles edge cases gracefully",
                "Fails safe with automatic rollback"
            ])

        return criteria

# Example usage
planner = RunbookAutomationPlanner()

# Assess database connection pool restart
db_pool_strategy = planner.create_strategy(
    name="Restart Database Connection Pool",
    current_level=AutomationLevel.MANUAL,
    risk_level="medium",
    complexity="simple",
    frequency="daily",
    business_impact="Service degradation during restart"
)

print(f"Target automation level: {db_pool_strategy.target_level}")
print(f"Approach: {db_pool_strategy.automation_approach}")
print(f"Prerequisites: {db_pool_strategy.prerequisites}")
```

## Implementing Automated Runbooks

### Script-Based Automation

```python
# automated_runbook.py
import os
import sys
import time
import logging
import subprocess
from typing import Dict, List, Optional, Any, Callable
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class StepStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    ROLLED_BACK = "rolled_back"

@dataclass
class RunbookStep:
    """A single step in a runbook"""
    name: str
    description: str
    action: Callable
    rollback: Optional[Callable] = None
    timeout: int = 300
    retries: int = 0
    required: bool = True
    preconditions: List[Callable] = None
    postconditions: List[Callable] = None

    def __post_init__(self):
        if self.preconditions is None:
            self.preconditions = []
        if self.postconditions is None:
            self.postconditions = []

@dataclass
class StepResult:
    """Result of executing a runbook step"""
    step_name: str
    status: StepStatus
    start_time: datetime
    end_time: datetime
    output: Any = None
    error: Optional[str] = None
    duration: Optional[float] = None

    def __post_init__(self):
        if self.duration is None:
            self.duration = (self.end_time - self.start_time).total_seconds()

class AutomatedRunbook:
    """Automated runbook executor with rollback capability"""

    def __init__(self, name: str, description: str):
        self.name = name
        self.description = description
        self.steps: List[RunbookStep] = []
        self.execution_log: List[StepResult] = []
        self.context: Dict[str, Any] = {}

    def add_step(self, step: RunbookStep):
        """Add a step to the runbook"""
        self.steps.append(step)

    def execute(self, dry_run: bool = False) -> bool:
        """Execute the runbook"""
        logger.info(f"Starting runbook: {self.name}")
        logger.info(f"Description: {self.description}")

        if dry_run:
            logger.info("DRY RUN MODE - No actual changes will be made")

        success = True
        completed_steps = []

        for i, step in enumerate(self.steps, 1):
            logger.info(f"Step {i}/{len(self.steps)}: {step.name}")
            logger.info(f"Description: {step.description}")

            # Check preconditions
            if not self._check_preconditions(step):
                logger.warning(f"Preconditions failed for step: {step.name}")
                if step.required:
                    success = False
                    break
                else:
                    self._record_step(step, StepStatus.SKIPPED)
                    continue

            # Execute step
            start_time = datetime.now()
            try:
                if not dry_run:
                    result = self._execute_step(step)
                else:
                    logger.info(f"DRY RUN: Would execute {step.name}")
                    result = {"dry_run": True}

                end_time = datetime.now()

                # Check postconditions
                if not self._check_postconditions(step):
                    raise Exception("Postconditions failed")

                self.execution_log.append(StepResult(
                    step_name=step.name,
                    status=StepStatus.SUCCESS,
                    start_time=start_time,
                    end_time=end_time,
                    output=result
                ))

                completed_steps.append(step)
                logger.info(f"Step completed successfully in {(end_time - start_time).total_seconds():.2f}s")

            except Exception as e:
                end_time = datetime.now()
                logger.error(f"Step failed: {str(e)}")

                self.execution_log.append(StepResult(
                    step_name=step.name,
                    status=StepStatus.FAILED,
                    start_time=start_time,
                    end_time=end_time,
                    error=str(e)
                ))

                if step.required:
                    success = False
                    logger.error("Required step failed, initiating rollback")
                    self._rollback(completed_steps)
                    break

        # Generate report
        self._generate_report()

        return success

    def _check_preconditions(self, step: RunbookStep) -> bool:
        """Check step preconditions"""
        for precondition in step.preconditions:
            try:
                if not precondition(self.context):
                    return False
            except Exception as e:
                logger.error(f"Precondition check failed: {e}")
                return False
        return True

    def _check_postconditions(self, step: RunbookStep) -> bool:
        """Check step postconditions"""
        for postcondition in step.postconditions:
            try:
                if not postcondition(self.context):
                    return False
            except Exception as e:
                logger.error(f"Postcondition check failed: {e}")
                return False
        return True

    def _execute_step(self, step: RunbookStep) -> Any:
        """Execute a single step with retries"""
        attempt = 0
        last_error = None

        while attempt <= step.retries:
            try:
                result = step.action(self.context)
                return result
            except Exception as e:
                last_error = e
                attempt += 1
                if attempt <= step.retries:
                    logger.warning(f"Attempt {attempt} failed, retrying...")
                    time.sleep(2 ** attempt)  # Exponential backoff

        raise last_error

    def _rollback(self, completed_steps: List[RunbookStep]):
        """Rollback completed steps in reverse order"""
        logger.info("Starting rollback procedure")

        for step in reversed(completed_steps):
            if step.rollback is None:
                logger.warning(f"No rollback defined for: {step.name}")
                continue

            logger.info(f"Rolling back: {step.name}")
            start_time = datetime.now()

            try:
                step.rollback(self.context)
                end_time = datetime.now()

                self.execution_log.append(StepResult(
                    step_name=f"ROLLBACK: {step.name}",
                    status=StepStatus.ROLLED_BACK,
                    start_time=start_time,
                    end_time=end_time
                ))

                logger.info("Rollback successful")

            except Exception as e:
                logger.error(f"Rollback failed: {e}")
                end_time = datetime.now()

                self.execution_log.append(StepResult(
                    step_name=f"ROLLBACK: {step.name}",
                    status=StepStatus.FAILED,
                    start_time=start_time,
                    end_time=end_time,
                    error=str(e)
                ))

    def _record_step(self, step: RunbookStep, status: StepStatus):
        """Record a step with given status"""
        now = datetime.now()
        self.execution_log.append(StepResult(
            step_name=step.name,
            status=status,
            start_time=now,
            end_time=now
        ))

    def _generate_report(self):
        """Generate execution report"""
        logger.info("\n" + "="*80)
        logger.info("RUNBOOK EXECUTION REPORT")
        logger.info("="*80)
        logger.info(f"Runbook: {self.name}")
        logger.info(f"Total Steps: {len(self.execution_log)}")

        success_count = sum(1 for r in self.execution_log if r.status == StepStatus.SUCCESS)
        failed_count = sum(1 for r in self.execution_log if r.status == StepStatus.FAILED)

        logger.info(f"Successful: {success_count}")
        logger.info(f"Failed: {failed_count}")

        total_duration = sum(r.duration for r in self.execution_log if r.duration)
        logger.info(f"Total Duration: {total_duration:.2f}s")

        logger.info("\nStep Details:")
        for result in self.execution_log:
            status_symbol = "✓" if result.status == StepStatus.SUCCESS else "✗"
            logger.info(
                f"  {status_symbol} {result.step_name} - "
                f"{result.status.value} ({result.duration:.2f}s)"
            )
            if result.error:
                logger.info(f"    Error: {result.error}")

        logger.info("="*80)

# Example: Automated Database Failover Runbook
def create_database_failover_runbook():
    """Create automated database failover runbook"""

    runbook = AutomatedRunbook(
        name="PostgreSQL Primary Failover",
        description="Automated failover from primary to replica database"
    )

    # Step 1: Verify cluster health
    def verify_cluster_health(context):
        logger.info("Checking cluster health...")
        # Check primary health
        # Check replica health
        # Check replication lag
        context['cluster_healthy'] = True
        return True

    runbook.add_step(RunbookStep(
        name="Verify Cluster Health",
        description="Check primary and replica health before failover",
        action=verify_cluster_health,
        required=True
    ))

    # Step 2: Stop writes to primary
    def stop_writes(context):
        logger.info("Stopping writes to primary...")
        # Set database to read-only
        # Drain connection pool
        context['writes_stopped'] = True
        return True

    def resume_writes(context):
        logger.info("Resuming writes...")
        # Re-enable writes
        return True

    runbook.add_step(RunbookStep(
        name="Stop Writes",
        description="Set primary database to read-only mode",
        action=stop_writes,
        rollback=resume_writes,
        required=True
    ))

    # Step 3: Promote replica
    def promote_replica(context):
        logger.info("Promoting replica to primary...")
        # Execute promotion command
        # Wait for promotion to complete
        context['new_primary'] = 'replica-1'
        return True

    def demote_replica(context):
        logger.info("Demoting replica back to standby...")
        # Reconfigure as replica
        return True

    runbook.add_step(RunbookStep(
        name="Promote Replica",
        description="Promote replica to new primary",
        action=promote_replica,
        rollback=demote_replica,
        required=True,
        timeout=120
    ))

    # Step 4: Update application configuration
    def update_app_config(context):
        logger.info("Updating application configuration...")
        new_primary = context.get('new_primary')
        # Update connection strings
        # Reload application configuration
        return True

    def revert_app_config(context):
        logger.info("Reverting application configuration...")
        # Restore original configuration
        return True

    runbook.add_step(RunbookStep(
        name="Update Application Config",
        description="Update applications to point to new primary",
        action=update_app_config,
        rollback=revert_app_config,
        required=True
    ))

    # Step 5: Verify failover
    def verify_failover(context):
        logger.info("Verifying failover success...")
        # Test write operations
        # Check replication status
        # Verify application connectivity
        return True

    runbook.add_step(RunbookStep(
        name="Verify Failover",
        description="Verify new primary is accepting writes",
        action=verify_failover,
        required=True,
        postconditions=[
            lambda ctx: ctx.get('new_primary') is not None,
            lambda ctx: ctx.get('writes_stopped') is True
        ]
    ))

    return runbook

# Execute runbook
if __name__ == "__main__":
    runbook = create_database_failover_runbook()
    success = runbook.execute(dry_run=False)
    sys.exit(0 if success else 1)
```

### Kubernetes-Native Runbook Automation

```yaml
# automated-runbook-job.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: database-failover-runbook
  namespace: production
data:
  runbook.sh: |
    #!/bin/bash
    set -euo pipefail

    # Runbook: PostgreSQL Database Failover
    # Purpose: Automated failover to replica database
    # Risk Level: High
    # Requires Approval: Yes

    NAMESPACE="production"
    PRIMARY_POD="postgresql-primary-0"
    REPLICA_POD="postgresql-replica-0"
    FAILOVER_TIMEOUT=120

    log() {
        echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
    }

    error() {
        echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
    }

    # Step 1: Verify cluster health
    verify_cluster() {
        log "Step 1: Verifying cluster health"

        # Check primary status
        if ! kubectl exec -n $NAMESPACE $PRIMARY_POD -- pg_isready; then
            log "Primary database is not ready (expected for failover scenario)"
        fi

        # Check replica status
        if ! kubectl exec -n $NAMESPACE $REPLICA_POD -- pg_isready; then
            error "Replica database is not ready"
            return 1
        fi

        # Check replication lag
        local lag=$(kubectl exec -n $NAMESPACE $REPLICA_POD -- \
            psql -U postgres -t -c "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()));" | tr -d ' ')

        if (( $(echo "$lag > 10" | bc -l) )); then
            error "Replication lag is too high: ${lag}s"
            return 1
        fi

        log "Cluster health verified (replication lag: ${lag}s)"
        return 0
    }

    # Step 2: Promote replica to primary
    promote_replica() {
        log "Step 2: Promoting replica to primary"

        kubectl exec -n $NAMESPACE $REPLICA_POD -- \
            su - postgres -c "/usr/lib/postgresql/14/bin/pg_ctl promote -D /var/lib/postgresql/data"

        # Wait for promotion to complete
        local elapsed=0
        while [ $elapsed -lt $FAILOVER_TIMEOUT ]; do
            if kubectl exec -n $NAMESPACE $REPLICA_POD -- \
                psql -U postgres -t -c "SELECT pg_is_in_recovery();" | grep -q "f"; then
                log "Replica promoted successfully"
                return 0
            fi
            sleep 5
            elapsed=$((elapsed + 5))
        done

        error "Replica promotion timed out"
        return 1
    }

    # Step 3: Update service endpoints
    update_service() {
        log "Step 3: Updating service endpoints"

        # Update service selector to point to new primary
        kubectl patch svc -n $NAMESPACE postgresql-primary \
            -p '{"spec":{"selector":{"statefulset.kubernetes.io/pod-name":"postgresql-replica-0"}}}'

        log "Service endpoints updated"
        return 0
    }

    # Step 4: Verify failover
    verify_failover() {
        log "Step 4: Verifying failover"

        # Test write operation
        kubectl exec -n $NAMESPACE $REPLICA_POD -- \
            psql -U postgres -c "CREATE TABLE IF NOT EXISTS failover_test (id serial, test_time timestamp);"

        kubectl exec -n $NAMESPACE $REPLICA_POD -- \
            psql -U postgres -c "INSERT INTO failover_test (test_time) VALUES (now());"

        log "Failover verified - write operations successful"
        return 0
    }

    # Step 5: Notify stakeholders
    notify_completion() {
        log "Step 5: Notifying stakeholders"

        # Send notification (integrate with your notification system)
        curl -X POST https://hooks.slack.com/services/YOUR/WEBHOOK/URL \
            -H 'Content-Type: application/json' \
            -d '{
                "text": "Database failover completed successfully",
                "blocks": [
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": "*Database Failover Completed*\nNew primary: postgresql-replica-0"
                        }
                    }
                ]
            }' || true

        log "Notification sent"
        return 0
    }

    # Main execution
    main() {
        log "Starting database failover runbook"

        if ! verify_cluster; then
            error "Cluster health check failed"
            exit 1
        fi

        if ! promote_replica; then
            error "Replica promotion failed"
            exit 1
        fi

        if ! update_service; then
            error "Service update failed"
            # Attempt rollback
            kubectl patch svc -n $NAMESPACE postgresql-primary \
                -p '{"spec":{"selector":{"statefulset.kubernetes.io/pod-name":"postgresql-primary-0"}}}'
            exit 1
        fi

        if ! verify_failover; then
            error "Failover verification failed"
            exit 1
        fi

        notify_completion

        log "Database failover completed successfully"
        exit 0
    }

    main

---
apiVersion: batch/v1
kind: Job
metadata:
  name: database-failover
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: runbook-automation
      containers:
        - name: failover
          image: bitnami/kubectl:latest
          command: ["/bin/bash"]
          args: ["/scripts/runbook.sh"]
          volumeMounts:
            - name: runbook-script
              mountPath: /scripts
          env:
            - name: KUBECONFIG
              value: /var/run/secrets/kubernetes.io/serviceaccount/token
      volumes:
        - name: runbook-script
          configMap:
            name: database-failover-runbook
            defaultMode: 0755
      restartPolicy: Never
  backoffLimit: 0

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: runbook-automation
  namespace: production

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: runbook-automation-role
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/exec", "services"]
    verbs: ["get", "list", "patch", "update"]
  - apiGroups: ["apps"]
    resources: ["statefulsets"]
    verbs: ["get", "list", "patch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: runbook-automation-rolebinding
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: runbook-automation-role
subjects:
  - kind: ServiceAccount
    name: runbook-automation
    namespace: production
```

## Self-Healing Systems

### Building Autonomous Remediation

```python
# self_healing_system.py
import time
import logging
from typing import Dict, List, Callable, Optional, Any
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
import threading

logger = logging.getLogger(__name__)

class RemediationStatus(Enum):
    PENDING = "pending"
    ANALYZING = "analyzing"
    EXECUTING = "executing"
    SUCCESS = "success"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"

@dataclass
class Symptom:
    """A system symptom that may trigger remediation"""
    name: str
    detected_at: datetime
    severity: str  # "info", "warning", "critical"
    metrics: Dict[str, Any]
    source: str

@dataclass
class RemediationAction:
    """An automated remediation action"""
    name: str
    description: str
    applicable_symptoms: List[str]
    safety_checks: List[Callable]
    action: Callable
    rollback: Optional[Callable]
    cooldown_period: timedelta
    max_attempts_per_hour: int
    risk_level: str

class SelfHealingSystem:
    """Autonomous self-healing system"""

    def __init__(self):
        self.actions: Dict[str, RemediationAction] = {}
        self.execution_history: List[Dict] = []
        self.cooldown_tracker: Dict[str, datetime] = {}
        self.attempt_counter: Dict[str, List[datetime]] = {}
        self.is_running = False

    def register_remediation(self, action: RemediationAction):
        """Register a remediation action"""
        self.actions[action.name] = action
        logger.info(f"Registered remediation: {action.name}")

    def analyze_symptom(self, symptom: Symptom) -> Optional[RemediationAction]:
        """Analyze symptom and select appropriate remediation"""
        logger.info(f"Analyzing symptom: {symptom.name}")

        # Find applicable remediations
        candidates = [
            action for action in self.actions.values()
            if symptom.name in action.applicable_symptoms
        ]

        if not candidates:
            logger.warning(f"No remediation found for symptom: {symptom.name}")
            return None

        # Select based on severity and risk
        for action in sorted(candidates, key=lambda a: a.risk_level):
            # Check cooldown
            if not self._check_cooldown(action.name):
                logger.info(f"Action {action.name} is in cooldown period")
                continue

            # Check attempt limits
            if not self._check_attempt_limit(action.name, action.max_attempts_per_hour):
                logger.warning(f"Action {action.name} has exceeded attempt limit")
                continue

            # Run safety checks
            if self._run_safety_checks(action, symptom):
                return action

        return None

    def remediate(self, symptom: Symptom) -> bool:
        """Execute remediation for symptom"""
        action = self.analyze_symptom(symptom)

        if action is None:
            logger.warning("No suitable remediation action found")
            return False

        logger.info(f"Executing remediation: {action.name}")

        execution_record = {
            'action': action.name,
            'symptom': symptom.name,
            'started_at': datetime.now(),
            'status': RemediationStatus.EXECUTING
        }

        try:
            # Execute remediation
            result = action.action(symptom)

            execution_record['completed_at'] = datetime.now()
            execution_record['status'] = RemediationStatus.SUCCESS
            execution_record['result'] = result

            # Update tracking
            self.cooldown_tracker[action.name] = datetime.now()
            self._record_attempt(action.name)

            logger.info(f"Remediation successful: {action.name}")
            return True

        except Exception as e:
            logger.error(f"Remediation failed: {e}")

            execution_record['completed_at'] = datetime.now()
            execution_record['status'] = RemediationStatus.FAILED
            execution_record['error'] = str(e)

            # Attempt rollback
            if action.rollback:
                try:
                    action.rollback(symptom)
                    execution_record['status'] = RemediationStatus.ROLLED_BACK
                except Exception as rollback_error:
                    logger.error(f"Rollback failed: {rollback_error}")

            return False

        finally:
            self.execution_history.append(execution_record)

    def _check_cooldown(self, action_name: str) -> bool:
        """Check if action is in cooldown period"""
        if action_name not in self.cooldown_tracker:
            return True

        last_execution = self.cooldown_tracker[action_name]
        action = self.actions[action_name]
        cooldown_end = last_execution + action.cooldown_period

        return datetime.now() >= cooldown_end

    def _check_attempt_limit(self, action_name: str, max_attempts: int) -> bool:
        """Check if action has exceeded attempt limit"""
        if action_name not in self.attempt_counter:
            return True

        # Count attempts in last hour
        one_hour_ago = datetime.now() - timedelta(hours=1)
        recent_attempts = [
            ts for ts in self.attempt_counter[action_name]
            if ts > one_hour_ago
        ]

        return len(recent_attempts) < max_attempts

    def _record_attempt(self, action_name: str):
        """Record execution attempt"""
        if action_name not in self.attempt_counter:
            self.attempt_counter[action_name] = []

        self.attempt_counter[action_name].append(datetime.now())

        # Clean old attempts
        one_hour_ago = datetime.now() - timedelta(hours=1)
        self.attempt_counter[action_name] = [
            ts for ts in self.attempt_counter[action_name]
            if ts > one_hour_ago
        ]

    def _run_safety_checks(
        self,
        action: RemediationAction,
        symptom: Symptom
    ) -> bool:
        """Run safety checks before executing action"""
        for check in action.safety_checks:
            try:
                if not check(symptom):
                    logger.warning(f"Safety check failed for {action.name}")
                    return False
            except Exception as e:
                logger.error(f"Safety check error: {e}")
                return False

        return True

    def start(self):
        """Start self-healing system"""
        self.is_running = True
        logger.info("Self-healing system started")

    def stop(self):
        """Stop self-healing system"""
        self.is_running = False
        logger.info("Self-healing system stopped")

# Example: Configure self-healing for common issues
def configure_self_healing():
    """Configure self-healing system with common remediations"""

    system = SelfHealingSystem()

    # Remediation: Restart unresponsive pods
    def restart_pod_action(symptom: Symptom):
        pod_name = symptom.metrics.get('pod_name')
        namespace = symptom.metrics.get('namespace')
        logger.info(f"Restarting pod: {pod_name} in {namespace}")
        # kubectl delete pod {pod_name} -n {namespace}
        return {"restarted": pod_name}

    def check_pod_safety(symptom: Symptom) -> bool:
        # Ensure we're not restarting too many pods
        # Check if deployment has enough replicas
        return True

    restart_pod = RemediationAction(
        name="restart_unresponsive_pod",
        description="Restart pod that is unresponsive",
        applicable_symptoms=["pod_not_ready", "pod_crashloopbackoff"],
        safety_checks=[check_pod_safety],
        action=restart_pod_action,
        rollback=None,
        cooldown_period=timedelta(minutes=15),
        max_attempts_per_hour=3,
        risk_level="low"
    )

    system.register_remediation(restart_pod)

    # Remediation: Scale up under load
    def scale_up_action(symptom: Symptom):
        deployment = symptom.metrics.get('deployment')
        current_replicas = symptom.metrics.get('replicas')
        target_replicas = min(current_replicas + 2, 10)
        logger.info(f"Scaling {deployment} from {current_replicas} to {target_replicas}")
        # kubectl scale deployment {deployment} --replicas={target_replicas}
        return {"scaled_to": target_replicas}

    def check_scale_safety(symptom: Symptom) -> bool:
        # Check cluster resources
        # Ensure we don't exceed limits
        return True

    scale_up = RemediationAction(
        name="scale_up_on_high_load",
        description="Scale up deployment under high load",
        applicable_symptoms=["high_cpu_usage", "high_memory_usage"],
        safety_checks=[check_scale_safety],
        action=scale_up_action,
        rollback=None,
        cooldown_period=timedelta(minutes=30),
        max_attempts_per_hour=2,
        risk_level="medium"
    )

    system.register_remediation(scale_up)

    # Remediation: Clear disk space
    def clear_disk_action(symptom: Symptom):
        pod_name = symptom.metrics.get('pod_name')
        logger.info(f"Clearing temporary files on {pod_name}")
        # kubectl exec {pod_name} -- sh -c "rm -rf /tmp/*"
        return {"disk_cleared": True}

    clear_disk = RemediationAction(
        name="clear_temp_files",
        description="Clear temporary files to free disk space",
        applicable_symptoms=["high_disk_usage"],
        safety_checks=[],
        action=clear_disk_action,
        rollback=None,
        cooldown_period=timedelta(hours=1),
        max_attempts_per_hour=1,
        risk_level="low"
    )

    system.register_remediation(clear_disk)

    return system

# Usage example
if __name__ == "__main__":
    system = configure_self_healing()
    system.start()

    # Simulate symptom detection
    symptom = Symptom(
        name="pod_not_ready",
        detected_at=datetime.now(),
        severity="warning",
        metrics={
            'pod_name': 'payment-service-abc123',
            'namespace': 'production'
        },
        source="kubernetes_monitor"
    )

    # Execute remediation
    success = system.remediate(symptom)
    print(f"Remediation success: {success}")
```

## Best Practices

### Runbook Automation Checklist

```yaml
# runbook-automation-checklist.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: runbook-automation-checklist
  namespace: sre
data:
  checklist.md: |
    # Runbook Automation Checklist

    ## Planning Phase
    - [ ] Document manual procedure completely
    - [ ] Identify automation level (assisted to autonomous)
    - [ ] Assess risk and business impact
    - [ ] Define success criteria
    - [ ] Plan rollback procedures
    - [ ] Get stakeholder approval

    ## Development Phase
    - [ ] Implement with idempotency
    - [ ] Add comprehensive logging
    - [ ] Include error handling
    - [ ] Implement timeout mechanisms
    - [ ] Add retry logic where appropriate
    - [ ] Create rollback functions

    ## Testing Phase
    - [ ] Test in non-production environment
    - [ ] Validate all edge cases
    - [ ] Test rollback procedures
    - [ ] Perform load testing if applicable
    - [ ] Conduct chaos engineering validation
    - [ ] Document test results

    ## Safety Phase
    - [ ] Implement safety checks
    - [ ] Add rate limiting
    - [ ] Configure cooldown periods
    - [ ] Set attempt limits
    - [ ] Define abort criteria
    - [ ] Create monitoring alerts

    ## Deployment Phase
    - [ ] Deploy with feature flags
    - [ ] Start with dry-run mode
    - [ ] Gradual rollout strategy
    - [ ] Monitor execution metrics
    - [ ] Gather team feedback
    - [ ] Document lessons learned

    ## Maintenance Phase
    - [ ] Regular execution review
    - [ ] Update for system changes
    - [ ] Maintain audit logs
    - [ ] Track success/failure rates
    - [ ] Conduct periodic testing
    - [ ] Keep documentation current
```

## Conclusion

Runbook automation is essential for reducing MTTR, improving reliability, and freeing teams to focus on strategic work. By starting with simple script-based automation and progressively moving toward self-healing systems, teams can build robust, automated incident response capabilities. The key is to prioritize based on frequency and risk, implement comprehensive safety measures, and continuously iterate based on real-world execution data.

This guide provides the foundation and production-ready patterns for implementing runbook automation at any maturity level, from basic scripting to fully autonomous self-healing systems.