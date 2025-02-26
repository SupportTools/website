---
title: "Managing Nagios Downtime via Command Line Using cURL"
date: 2025-02-20T09:00:00-06:00
draft: false
tags: ["Nagios", "Monitoring", "DevOps", "Automation", "cURL", "CLI", "System Administration"]
categories:
- Monitoring
- DevOps
- Automation
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to efficiently schedule Nagios downtimes using cURL commands, perfect for automation and scripting scenarios. This guide includes practical examples and best practices for system administrators."
more_link: "yes"
url: "/nagios-downtime-command-line-curl/"
---

Discover how to programmatically manage Nagios downtimes using cURL, enabling automated maintenance windows and reducing alert noise during planned system work.

<!--more-->

# Managing Nagios Downtime via Command Line

## The Challenge
During deployments or maintenance tasks, Nagios alerts can become noisy and potentially disruptive. While the web interface provides downtime management capabilities, automation requires a command-line approach.

## The Solution: cURL-based Downtime Management

### Prerequisites
- Access to Nagios web interface
- cURL installed on your system
- Basic bash scripting knowledge

### Implementation
Here's a bash script that automates the process of setting downtime for hosts or services:

```bash
#!/bin/bash

function die {
    echo $1
    exit 1
}

if [[ $# -eq 0 ]]; then
    die "Give hostname and time in minutes as parameter!"
fi

HOST=$1
TIME=$2
NOW=$(date +%s)
END=$((NOW + TIME * 60))

# Nagios credentials and URL
NAGIOS_URL="http://your-nagios-server/nagios"
NAGIOS_USER="your-username"
NAGIOS_PASS="your-password"

# Set downtime using cURL
curl -s -u "${NAGIOS_USER}:${NAGIOS_PASS}" \
    "${NAGIOS_URL}/cmd.cgi" \
    -d "cmd_typ=55" \
    -d "cmd_mod=2" \
    -d "host=${HOST}" \
    -d "com_author=automation" \
    -d "com_data=Automated downtime during maintenance" \
    -d "trigger=0" \
    -d "start_time=${NOW}" \
    -d "end_time=${END}" \
    -d "fixed=1" \
    -d "hours=0" \
    -d "minutes=${TIME}" \
    -d "childoptions=0" \
    -d "btnSubmit=Commit"
```

### How to Use

1. **Save the Script**
   ```bash
   chmod +x nagios_downtime.sh
   ```

2. **Execute for Host Downtime**
   ```bash
   ./nagios_downtime.sh webserver01 60  # Sets 60 minutes downtime
   ```

## Advanced Usage

### Setting Service-Specific Downtime
To set downtime for specific services, modify the script:

```bash
# Add service parameter
SERVICE=$3

# Modify cURL command for service downtime
curl -s -u "${NAGIOS_USER}:${NAGIOS_PASS}" \
    "${NAGIOS_URL}/cmd.cgi" \
    -d "cmd_typ=56" \  # Changed to service downtime command
    -d "cmd_mod=2" \
    -d "host=${HOST}" \
    -d "service=${SERVICE}" \
    ...
```

### Integration with Deployment Scripts
```bash
# Example deployment workflow
pre_deploy() {
    ./nagios_downtime.sh $HOST 30
    sleep 5  # Allow Nagios to process
}

deploy() {
    # Your deployment steps
    echo "Deploying..."
}

main() {
    pre_deploy
    deploy
}
```

## Security Considerations

1. **Credential Management**
   - Store credentials securely (environment variables or secure vault)
   - Use restricted Nagios user accounts
   - Consider using API tokens if available

2. **Access Control**
   - Limit script access to authorized users
   - Implement audit logging for downtime actions
   - Regular review of downtime patterns

## Best Practices

1. **Documentation**
   - Comment your automation scripts
   - Maintain a log of automated downtimes
   - Document the purpose of recurring downtimes

2. **Monitoring**
   - Track frequency of downtime usage
   - Alert on excessive downtimes
   - Regular review of automation effectiveness

3. **Maintenance**
   - Regular testing of scripts
   - Update credentials securely
   - Version control for scripts

Remember to adjust the script parameters according to your Nagios setup and security requirements. This automation can significantly reduce manual intervention during maintenance windows while maintaining proper system monitoring practices.
