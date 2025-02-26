---
title: "Running Nagios Checks as Root with NRPE"
date: 2025-02-17T01:55:00-06:00
draft: false
tags: ["Nagios", "NRPE", "Monitoring", "Linux", "Security"]
categories:
- Monitoring
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide on how to configure NRPE to run Nagios checks with root privileges securely"
more_link: "yes"
url: "/nagios-run-checks-as-root-with-nrpe/"
---

Learn how to configure NRPE to run Nagios checks with root privileges while maintaining security.

<!--more-->

# Running Nagios Checks as Root with NRPE

## The Challenge
Sometimes you need to run Nagios checks that require root privileges. By default, NRPE runs as the nagios user for security reasons, but there are legitimate cases where root access is necessary for certain monitoring tasks.

## The Solution

### 1. Configure sudo Access
First, we need to configure sudo to allow specific commands to run with root privileges. Edit the sudoers configuration:

```bash
visudo
```

Add the following line to disable the requiretty setting:
```bash
#Defaults    requiretty
```

### 2. Configure NRPE
Next, add the following line to your NRPE configuration (typically in /etc/nagios/nrpe.cfg or similar):

```bash
%nrpe ALL=(ALL) NOPASSWD: /usr/lib64/nagios/plugins/
```

This configuration allows the nrpe group to execute commands in the Nagios plugins directory with root privileges without requiring a password.

## Important Notes

1. **Security Considerations**
   - Only grant root access to specific commands that absolutely require it
   - Keep the list of root-privileged commands as small as possible
   - Regularly audit which commands have root access

2. **Group Configuration**
   - Make sure to use the exact group name that your NRPE process runs as
   - The configuration above uses the 'nrpe' group, but your system might use a different group name

3. **Plugin Directory**
   - The path `/usr/lib64/nagios/plugins/` might be different on your system
   - Verify the correct path before implementing the configuration

## Testing the Configuration

After making these changes:

1. Restart the NRPE service:
```bash
systemctl restart nrpe
```

2. Test a check that requires root privileges:
```bash
sudo -u nagios /usr/lib64/nagios/plugins/your_check_script
```

The check should now execute successfully with root privileges while still maintaining overall system security.

Remember to always follow the principle of least privilege and only grant root access where absolutely necessary.
