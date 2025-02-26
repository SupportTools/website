---
title: "Managing Nagios Downtime via Command Line Using cURL: A Complete Guide"
date: 2026-03-15T09:00:00-06:00
draft: false
tags: ["Nagios", "Monitoring", "cURL", "Automation", "System Administration", "DevOps"]
categories:
- Monitoring
- Automation
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to efficiently manage Nagios downtime using cURL commands. Includes automation scripts, API integration examples, and best practices for system administrators."
more_link: "yes"
url: "/nagios-downtime-curl-command/"
---

Master the art of managing Nagios downtime through the command line using cURL, enabling efficient automation and integration capabilities.

<!--more-->

# Managing Nagios Downtime via cURL

## Understanding Nagios API

### 1. API Endpoints

```bash
# Common Nagios XI API endpoints
NAGIOS_URL="https://nagios.example.com"
ENDPOINTS=(
    "/nagiosxi/api/v1/system/status"
    "/nagiosxi/api/v1/objects/host"
    "/nagiosxi/api/v1/objects/service"
    "/nagiosxi/api/v1/system/scheduledowntime"
)
```

### 2. Authentication

```bash
#!/bin/bash
# nagios-auth.sh

# Nagios API credentials
NAGIOS_USER="admin"
NAGIOS_PASS="your_password"

# Generate authentication token
get_auth_token() {
    curl -s -k -X POST \
        -d "username=$NAGIOS_USER&password=$NAGIOS_PASS" \
        "$NAGIOS_URL/nagiosxi/api/v1/authenticate"
}

# Store token
AUTH_TOKEN=$(get_auth_token | jq -r '.token')
```

## Implementation Guide

### 1. Schedule Downtime

```python
#!/usr/bin/env python3
# schedule_downtime.py

import requests
import json
from datetime import datetime, timedelta

def schedule_host_downtime(host, duration_hours=1, comment="Scheduled maintenance"):
    """Schedule downtime for a host"""
    url = f"{NAGIOS_URL}/nagiosxi/api/v1/system/scheduledowntime"
    
    # Calculate start and end times
    start_time = datetime.now()
    end_time = start_time + timedelta(hours=duration_hours)
    
    payload = {
        'token': AUTH_TOKEN,
        'hostname': host,
        'start_time': start_time.strftime('%Y-%m-%d %H:%M:%S'),
        'end_time': end_time.strftime('%Y-%m-%d %H:%M:%S'),
        'comment': comment,
        'all_services': 1
    }
    
    response = requests.post(url, data=payload, verify=False)
    return response.json()

def schedule_service_downtime(host, service, duration_hours=1, comment="Scheduled maintenance"):
    """Schedule downtime for a specific service"""
    url = f"{NAGIOS_URL}/nagiosxi/api/v1/system/scheduledowntime"
    
    start_time = datetime.now()
    end_time = start_time + timedelta(hours=duration_hours)
    
    payload = {
        'token': AUTH_TOKEN,
        'hostname': host,
        'service_description': service,
        'start_time': start_time.strftime('%Y-%m-%d %H:%M:%S'),
        'end_time': end_time.strftime('%Y-%m-%d %H:%M:%S'),
        'comment': comment
    }
    
    response = requests.post(url, data=payload, verify=False)
    return response.json()
```

### 2. Command Line Interface

```bash
#!/bin/bash
# nagios-downtime.sh

# Function to schedule downtime
schedule_downtime() {
    local host=$1
    local duration=$2
    local comment=$3
    local start_time=$(date +"%Y-%m-%d %H:%M:%S")
    local end_time=$(date -d "+${duration} hours" +"%Y-%m-%d %H:%M:%S")
    
    curl -k -X POST \
        -d "token=$AUTH_TOKEN" \
        -d "hostname=$host" \
        -d "start_time=$start_time" \
        -d "end_time=$end_time" \
        -d "comment=$comment" \
        -d "all_services=1" \
        "$NAGIOS_URL/nagiosxi/api/v1/system/scheduledowntime"
}

# Function to cancel downtime
cancel_downtime() {
    local host=$1
    
    curl -k -X DELETE \
        -d "token=$AUTH_TOKEN" \
        -d "hostname=$host" \
        "$NAGIOS_URL/nagiosxi/api/v1/system/scheduledowntime"
}
```

## Automation Scripts

### 1. Batch Downtime Management

```python
#!/usr/bin/env python3
# batch_downtime.py

import yaml
import argparse
from datetime import datetime, timedelta

def load_hosts_config(config_file):
    """Load hosts configuration from YAML"""
    with open(config_file, 'r') as f:
        return yaml.safe_load(f)

def schedule_batch_downtime(config):
    """Schedule downtime for multiple hosts"""
    results = []
    
    for group in config['host_groups']:
        start_time = datetime.strptime(
            group['maintenance_window']['start'],
            '%Y-%m-%d %H:%M:%S'
        )
        duration = group['maintenance_window']['duration']
        
        for host in group['hosts']:
            result = schedule_host_downtime(
                host,
                duration_hours=duration,
                comment=group.get('comment', 'Scheduled maintenance')
            )
            results.append({
                'host': host,
                'status': result['status'],
                'message': result.get('message', '')
            })
    
    return results

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config', help='YAML configuration file')
    args = parser.parse_args()
    
    config = load_hosts_config(args.config)
    results = schedule_batch_downtime(config)
    
    for result in results:
        print(f"{result['host']}: {result['status']} - {result['message']}")

if __name__ == "__main__":
    main()
```

### 2. Maintenance Window Management

```python
#!/usr/bin/env python3
# maintenance_windows.py

from datetime import datetime, timedelta
import json
import requests

class MaintenanceWindow:
    def __init__(self, nagios_url, auth_token):
        self.nagios_url = nagios_url
        self.auth_token = auth_token
    
    def schedule_window(self, config_file):
        """Schedule maintenance window from config"""
        with open(config_file, 'r') as f:
            config = json.load(f)
        
        window_start = datetime.strptime(
            config['window_start'],
            '%Y-%m-%d %H:%M:%S'
        )
        window_duration = config['duration_hours']
        
        for host in config['hosts']:
            self._schedule_host(
                host,
                window_start,
                window_duration,
                config.get('comment', 'Maintenance window')
            )
    
    def _schedule_host(self, host, start_time, duration, comment):
        """Schedule downtime for a single host"""
        end_time = start_time + timedelta(hours=duration)
        
        payload = {
            'token': self.auth_token,
            'hostname': host,
            'start_time': start_time.strftime('%Y-%m-%d %H:%M:%S'),
            'end_time': end_time.strftime('%Y-%m-%d %H:%M:%S'),
            'comment': comment,
            'all_services': 1
        }
        
        response = requests.post(
            f"{self.nagios_url}/nagiosxi/api/v1/system/scheduledowntime",
            data=payload,
            verify=False
        )
        
        return response.json()
```

## Monitoring and Verification

### 1. Downtime Status Check

```bash
#!/bin/bash
# check-downtime.sh

# Check current downtime
check_downtime() {
    local host=$1
    
    curl -k -s -G \
        --data-urlencode "token=$AUTH_TOKEN" \
        --data-urlencode "hostname=$host" \
        "$NAGIOS_URL/nagiosxi/api/v1/objects/downtimereport" | \
        jq '.'
}

# Monitor downtime expiration
monitor_downtime() {
    local host=$1
    
    while true; do
        status=$(check_downtime "$host")
        remaining=$(echo "$status" | jq -r '.downtime[0].remaining_time // empty')
        
        if [ -z "$remaining" ]; then
            echo "No active downtime for $host"
            break
        fi
        
        echo "Remaining downtime for $host: $remaining"
        sleep 300  # Check every 5 minutes
    done
}
```

### 2. Reporting

```python
#!/usr/bin/env python3
# downtime_report.py

def generate_downtime_report(start_date, end_date):
    """Generate downtime report for date range"""
    url = f"{NAGIOS_URL}/nagiosxi/api/v1/objects/downtimereport"
    
    params = {
        'token': AUTH_TOKEN,
        'starttime': start_date,
        'endtime': end_date
    }
    
    response = requests.get(url, params=params, verify=False)
    data = response.json()
    
    report = {
        'total_downtime': 0,
        'hosts': {}
    }
    
    for entry in data['downtime']:
        host = entry['hostname']
        duration = entry['duration']
        
        if host not in report['hosts']:
            report['hosts'][host] = {
                'total_duration': 0,
                'events': []
            }
        
        report['hosts'][host]['total_duration'] += duration
        report['hosts'][host]['events'].append({
            'start_time': entry['start_time'],
            'end_time': entry['end_time'],
            'duration': duration,
            'comment': entry['comment']
        })
        
        report['total_downtime'] += duration
    
    return report
```

## Best Practices

1. **Authentication**
   - Secure token storage
   - Regular rotation
   - Access control

2. **Automation**
   - Version control
   - Error handling
   - Logging

3. **Documentation**
   - Track changes
   - Maintenance windows
   - Team communication

Remember to handle authentication tokens securely and implement proper error handling in your scripts.
