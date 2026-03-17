---
title: "Linux SELinux Administration: Policy Modules, audit2allow Workflow, Booleans, File Contexts, and MLS/MCS"
date: 2032-02-25T00:00:00-05:00
draft: false
tags: ["SELinux", "Linux", "Security", "RHEL", "Policy", "Compliance"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to SELinux administration covering custom policy module development, the audit2allow workflow, boolean tuning, file context management, and Multi-Level Security with MCS categories."
more_link: "yes"
url: "/linux-selinux-administration-policy-modules-audit2allow-mls/"
---

SELinux is the most powerful mandatory access control system available on Linux, and it is also one of the most frequently disabled out of frustration with unexplained denials. That frustration is almost always a tooling and workflow problem rather than a policy design problem. With the right approach - reading audit logs, building narrowly scoped policy modules, and understanding how type enforcement interacts with file contexts - SELinux becomes a precise security instrument rather than an obstacle. This guide covers the complete operational picture for RHEL/CentOS/Fedora environments.

<!--more-->

# Linux SELinux Administration

## Conceptual Foundation

SELinux implements Mandatory Access Control (MAC) on top of the Linux discretionary access control (DAC) model. Where DAC uses user/group/other permissions, SELinux uses security contexts consisting of four components:

```
user:role:type:level
system_u:system_r:httpd_t:s0
│          │       │       │
│          │       │       └── MLS/MCS sensitivity level
│          │       └────────── Type (most commonly tuned)
│          └────────────────── Role
└───────────────────────────── SELinux user
```

The type field is the component administrators interact with most. Type enforcement rules define which types can access which resources and through which operations.

## Section 1: Diagnosing Denials

### Reading AVC Messages

All SELinux denials are written to the audit log at `/var/log/audit/audit.log`. The `avc:` prefix identifies SELinux Access Vector Cache denials.

```bash
# View recent denials
ausearch -m AVC,USER_AVC,SELINUX_ERR -ts recent

# Denials for a specific process
ausearch -m AVC -c nginx -ts today

# Format denials for human reading
ausearch -m AVC -ts today | audit2why

# Count denials by type
ausearch -m AVC -ts today | \
  grep "scontext=" | \
  sed 's/.*scontext=\([^ ]*\).*/\1/' | \
  sort | uniq -c | sort -rn
```

A typical AVC denial looks like:

```
type=AVC msg=audit(1740000000.123:456): avc:  denied  { read } for
  pid=12345 comm="nginx" name="app.conf" dev="sda1" ino=789012
  scontext=system_u:system_r:httpd_t:s0
  tcontext=unconfined_u:object_r:admin_home_t:s0
  tclass=file permissive=0
```

Breaking this down:
- `denied { read }` - the operation that was blocked
- `comm="nginx"` - the process name
- `scontext=...httpd_t` - the source type (nginx running as httpd_t)
- `tcontext=...admin_home_t` - the target type (the file)
- `tclass=file` - the object class

### setroubleshoot for Automated Analysis

```bash
# Install setroubleshoot-server
dnf install setroubleshoot-server setools-console

# Analyze AVC messages automatically
sealert -a /var/log/audit/audit.log

# Analyze a specific denial
ausearch -m AVC -ts recent | sealert -a /dev/stdin
```

### Checking Current Enforcement Status

```bash
# Current mode
getenforce
# Enforcing | Permissive | Disabled

# Detailed status including policy version
sestatus -v

# Per-domain permissive status
semanage permissive -l
```

## Section 2: SELinux Booleans

Booleans are named switches that toggle predefined policy behaviors without requiring a custom module. They are the first tool to reach for when enabling common service behaviors.

### Discovering Relevant Booleans

```bash
# List all booleans with descriptions
semanage boolean -l

# Filter for relevant booleans
semanage boolean -l | grep httpd

# Get a boolean's current state and meaning
getsebool -a | grep httpd_can_network_connect

# More detail
semanage boolean -l | grep "httpd_can_network_connect"
```

### Common Boolean Operations

```bash
# Allow httpd to connect to the network (for reverse proxies)
setsebool -P httpd_can_network_connect on

# Allow httpd to connect to databases
setsebool -P httpd_can_network_connect_db on

# Allow NGINX/Apache to read home directories
setsebool -P httpd_read_user_content on

# Allow NFS home directories for users
setsebool -P use_nfs_home_dirs on

# Allow rsync to read all files on the system
setsebool -P rsync_full_access on

# Enable FTP passive mode
setsebool -P ftp_home_dir on

# Allow Samba to share home directories
setsebool -P samba_enable_home_dirs on
setsebool -P samba_export_all_rw on
```

The `-P` flag makes the change persistent across reboots by writing to `/etc/selinux/targeted/active/booleans.local`.

### Container-Specific Booleans

```bash
# Allow containers to use shared memory (often needed for JVM)
setsebool -P container_use_cephfs on

# Allow containers to read/write the host /tmp
setsebool -P container_manage_cgroup on

# Allow containers to connect to the host network
setsebool -P container_connect_any on

# Verify current state
getsebool container_connect_any
```

## Section 3: File Context Management

Incorrect file contexts are the most common cause of SELinux denials in production. When files are created in the wrong location or copied without context preservation, they inherit the wrong label.

### Checking and Restoring File Contexts

```bash
# View file contexts
ls -Z /etc/nginx/
ls -Z /var/www/html/

# Check what context a path should have
matchpathcon /etc/nginx/nginx.conf
matchpathcon /var/www/html/

# Restore contexts to their correct policy-defined values
restorecon -Rv /etc/nginx/
restorecon -Rv /var/www/html/
restorecon -Rv /home/

# Dry-run to see what would change
restorecon -Rvn /var/log/
```

### Adding Custom File Context Mappings

When you install software outside standard paths or use non-standard directories, you must add explicit context mappings.

```bash
# Show existing custom mappings
semanage fcontext -l | grep local

# Map a custom web root to the httpd content type
semanage fcontext -a -t httpd_sys_content_t "/opt/webapp/public(/.*)?"

# Map a custom log directory
semanage fcontext -a -t httpd_log_t "/opt/webapp/logs(/.*)?"

# Map a custom configuration directory
semanage fcontext -a -t httpd_config_t "/opt/webapp/config(/.*)?"

# Apply the new mappings
restorecon -Rv /opt/webapp/

# Verify
ls -laZ /opt/webapp/
```

### Application-Specific Context Types

```bash
# Contexts for common applications
# PostgreSQL data directory
semanage fcontext -a -t postgresql_db_t "/data/postgresql(/.*)?"

# Redis data directory
semanage fcontext -a -t redis_db_t "/data/redis(/.*)?"

# Application configuration in /etc
semanage fcontext -a -t myapp_etc_t "/etc/myapp(/.*)?"

# Executable files
semanage fcontext -a -t bin_t "/opt/myapp/bin(/.*)?"

# Writable data directory
semanage fcontext -a -t var_t "/opt/myapp/data(/.*)?"
```

### Port Context Management

SELinux controls which ports processes can bind to by type.

```bash
# List all port contexts
semanage port -l

# Check which type owns port 8080
semanage port -l | grep 8080

# Allow httpd to bind on port 8443
semanage port -a -t http_port_t -p tcp 8443

# Allow a custom application port
semanage port -a -t myapp_port_t -p tcp 9000

# If the type doesn't exist yet, you'll create it in a policy module
# For a quick workaround, add to an existing type:
semanage port -a -t http_port_t -p tcp 3000

# Remove a custom port mapping
semanage port -d -t http_port_t -p tcp 8443
```

## Section 4: The audit2allow Workflow

`audit2allow` reads AVC denials and generates policy module source code. It is a starting point, not a final answer. Always review generated rules before loading them.

### Basic Workflow

```bash
# Step 1: Reproduce the issue and capture denials
# Put the domain in permissive mode temporarily
semanage permissive -a httpd_t

# Run the operation that was being denied
systemctl restart nginx
curl http://localhost/health

# Step 2: Extract the relevant denials
ausearch -m AVC -c nginx -ts recent > /tmp/nginx-denials.txt

# Step 3: Generate policy module source
cat /tmp/nginx-denials.txt | audit2allow -M nginx-custom

# This creates:
# nginx-custom.te  - Type Enforcement source
# nginx-custom.pp  - Compiled policy package

# Step 4: REVIEW the .te file before loading
cat nginx-custom.te

# Step 5: Load the policy module
semodule -i nginx-custom.pp

# Step 6: Re-enable enforcement for the domain
semanage permissive -d httpd_t

# Step 7: Verify the fix
ausearch -m AVC -c nginx -ts recent | grep denied
```

### Understanding Generated Rules

```bash
# Example generated .te file
cat nginx-custom.te
```

```te
module nginx-custom 1.0;

require {
	type httpd_t;
	type unreserved_port_t;
	class tcp_socket name_connect;
}

#============= httpd_t ==============
allow httpd_t unreserved_port_t:tcp_socket name_connect;
```

Before loading this, consider: is it safe to allow httpd_t to connect to ALL unreserved ports? A more restrictive policy would define a specific port type:

```te
# Better: only allow connection to your specific backend port
module nginx-custom 1.0;

require {
	type httpd_t;
	type myapp_port_t;
	class tcp_socket name_connect;
}

allow httpd_t myapp_port_t:tcp_socket name_connect;
```

### Creating Policy Modules from Scratch

For production-grade policy, write modules manually rather than relying entirely on audit2allow output.

```bash
# Create a directory for your policy module
mkdir -p /root/selinux-policy/myapp && cd /root/selinux-policy/myapp
```

```te
# myapp.te - Type Enforcement file
policy_module(myapp, 1.0.0)

########################################
# Declarations
########################################

# Define the process type for myapp daemon
type myapp_t;
type myapp_exec_t;
init_daemon_domain(myapp_t, myapp_exec_t)

# Log file type
type myapp_log_t;
logging_log_file(myapp_log_t)

# Data directory type
type myapp_var_t;
files_type(myapp_var_t)

# Configuration file type
type myapp_etc_t;
files_config_file(myapp_etc_t)

# Port type
type myapp_port_t;
corenet_port(myapp_port_t)

########################################
# myapp local policy
########################################

# Allow myapp to read its own configuration
allow myapp_t myapp_etc_t:file { read getattr open };
allow myapp_t myapp_etc_t:dir { search };

# Allow myapp to write logs
allow myapp_t myapp_log_t:file { write create append getattr open };
allow myapp_t myapp_log_t:dir { write add_name remove_name };

# Allow myapp to read/write its data directory
allow myapp_t myapp_var_t:dir { read write search add_name remove_name };
allow myapp_t myapp_var_t:file { read write create unlink getattr };

# Allow myapp to bind its port
allow myapp_t myapp_port_t:tcp_socket { name_bind name_connect };

# Allow myapp to use standard networking
allow myapp_t self:tcp_socket { create bind connect getattr setopt };
allow myapp_t self:udp_socket { create bind connect getattr };

# Allow myapp to send signals to itself
allow myapp_t self:process { signal sigkill };

# Standard library and executable access
libs_use_ld_so(myapp_t)
libs_use_shared_libs(myapp_t)
corecmd_exec_bin(myapp_t)

# Logging via syslog
logging_send_syslog_msg(myapp_t)

# Read /etc files
files_read_etc_files(myapp_t)

# Read proc filesystem (for health checks etc.)
kernel_read_system_state(myapp_t)
```

```bash
# myapp.fc - File Contexts
# Executable
/usr/sbin/myapp               -- gen_context(system_u:object_r:myapp_exec_t,s0)
/opt/myapp/bin/myapp          -- gen_context(system_u:object_r:myapp_exec_t,s0)

# Configuration
/etc/myapp(/.*)?              gen_context(system_u:object_r:myapp_etc_t,s0)

# Logs
/var/log/myapp(/.*)?          gen_context(system_u:object_r:myapp_log_t,s0)

# Data
/var/lib/myapp(/.*)?          gen_context(system_u:object_r:myapp_var_t,s0)
/opt/myapp/data(/.*)?         gen_context(system_u:object_r:myapp_var_t,s0)
```

```bash
# myapp.if - Interface file (for other modules to use)
## <summary>myapp - Application policy</summary>

########################################
## <summary>
##      Execute myapp in the myapp domain.
## </summary>
## <param name="domain">
##      <summary>Domain allowed access.</summary>
## </param>
interface(`myapp_domtrans',`
        gen_require(`
                type myapp_t, myapp_exec_t;
        ')

        corecmd_search_bin($1)
        domtrans_pattern($1, myapp_exec_t, myapp_t)
')
```

### Compiling and Loading Policy Modules

```bash
# Compile to policy package
make -f /usr/share/selinux/devel/Makefile myapp.pp

# If you don't have the devel package:
dnf install selinux-policy-devel

# Or compile manually:
checkmodule -M -m -o myapp.mod myapp.te
semodule_package -o myapp.pp -m myapp.mod -f myapp.fc

# Install the module
semodule -i myapp.pp

# Apply file contexts
restorecon -Rv /etc/myapp /var/log/myapp /var/lib/myapp /opt/myapp

# Verify module is loaded
semodule -l | grep myapp

# Remove a module
semodule -r myapp

# Update an existing module (increment version in .te first)
semodule -u myapp.pp
```

## Section 5: Advanced Policy Patterns

### Transition Rules

Transitions control what domain a process moves into when it executes a binary.

```te
# Allow init_t to transition into myapp_t when executing myapp_exec_t
type_transition init_t myapp_exec_t:process myapp_t;

# Domain transition on socket creation (for network services)
type_transition myapp_t myapp_port_t:tcp_socket myapp_client_t;

# File type transition (new files created in myapp_var_t get myapp_data_t)
type_transition myapp_t myapp_var_t:file myapp_data_t;
```

### Attributes for Policy Grouping

```te
# Define an attribute that groups types with similar access
attribute myapp_domain;

# Assign types to the attribute
typeattribute myapp_t myapp_domain;
typeattribute myapp_worker_t myapp_domain;

# Write rules for all members of the attribute
allow myapp_domain myapp_log_t:file { write append };
allow myapp_domain myapp_etc_t:file { read getattr };
```

### Using Macros from Reference Policy

The reference policy ships hundreds of macros that simplify common patterns:

```te
# Instead of:
allow myapp_t proc_t:file { read };
allow myapp_t sysfs_t:file { read };
# ... many more rules

# Use the macro:
kernel_read_system_state(myapp_t)

# Common macros:
auth_read_passwd(myapp_t)           # read /etc/passwd
miscfiles_read_localization(myapp_t) # read locale files
sysnet_read_config(myapp_t)         # read network config
init_use_fds(myapp_t)               # use file descriptors from init
term_dontaudit_use_console(myapp_t) # suppress console denials
```

## Section 6: Multi-Level Security (MLS) and MCS

### MCS Overview

Multi-Category Security (MCS) is the MLS subset used by default in RHEL. It uses sensitivity level `s0` with user-defined categories `c0`-`c1023`. Categories provide multi-tenancy isolation without requiring the full MLS lattice.

In Kubernetes/container environments, MCS categories are used by CRI-O and container runtimes to isolate containers from each other.

```bash
# The MLS/MCS component of a context
# s0:c1,c2 = sensitivity s0, categories c1 and c2
# A process can only access objects with matching or dominated categories

# Check container MCS labels
ps auxZ | grep container
# system_u:system_r:container_t:s0:c123,c456

# View category definitions
seinfo -b | grep mlscats
```

### Enabling MLS Policy

MLS provides the full classification hierarchy (Unclassified, Confidential, Secret, Top Secret). Note: switching from targeted to MLS requires careful planning.

```bash
# Check current policy type
sestatus | grep "Policy type"

# MLS policy is in selinux-policy-mls
dnf install selinux-policy-mls

# Switch to MLS policy (requires reboot)
# Edit /etc/selinux/config:
SELINUX=enforcing
SELINUXTYPE=mls
```

### Working with MLS Levels

```bash
# Assign a user to an MLS range
# s0 = lowest (Unclassified), s3 = highest (Top Secret in a 4-level system
useradd -Z staff_u alice

# Set the user's security range
semanage user -m -r s0-s3:c0.c1023 staff_u

# Login with a specific clearance
newrole -r staff_r -t staff_t -l s2

# Run a command at a specific classification level
runcon -l s3 -- cat /classified/topsecret.txt

# Change file classification
chcon -l s2 /sensitive/confidential.txt
chcon -r object_r -l s0:c100,c200 /app/tenant-a/data
```

### MCS Container Isolation

```bash
# Assign unique MCS categories to separate containers
# Container A: s0:c100,c200
# Container B: s0:c300,c400
# Container A cannot access Container B's files

# Manually assign context to a container's data directory
chcon -R system_u:object_r:container_file_t:s0:c100,c200 /data/container-a/
chcon -R system_u:object_r:container_file_t:s0:c300,c400 /data/container-b/

# Verify isolation
# Running as container A's context, attempt to read container B's files
# Should result in AVC denial
runcon system_u:system_r:container_t:s0:c100,c200 -- \
  cat /data/container-b/secret.txt
# denied
```

## Section 7: Operational Procedures

### SELinux Audit and Reporting

```bash
#!/bin/bash
# selinux-daily-report.sh

REPORT_DATE=$(date +%Y-%m-%d)
REPORT_FILE="/var/log/selinux-report-${REPORT_DATE}.txt"

{
  echo "SELinux Daily Report - ${REPORT_DATE}"
  echo "====================================="
  echo ""

  echo "Current Status:"
  sestatus
  echo ""

  echo "Policy Modules (custom only):"
  semodule -l | grep -v "^(base|permissivedomains|unconfined|targeted)" | head -50
  echo ""

  echo "Denial Summary (last 24 hours):"
  ausearch -m AVC -ts yesterday -te today 2>/dev/null | \
    grep "avc:" | \
    awk '{
      for(i=1;i<=NF;i++) {
        if($i ~ /^scontext=/) sctx=$i
        if($i ~ /^tcontext=/) tctx=$i
        if($i ~ /^\{/)        op=$i
      }
      print sctx, op, tctx
    }' | sort | uniq -c | sort -rn | head -20
  echo ""

  echo "Permissive Domains:"
  semanage permissive -l
  echo ""

  echo "Changed File Contexts (last 24h):"
  find / -xdev -newer /var/log/selinux-report-$(date -d yesterday +%Y-%m-%d).txt \
    -context "*_t:s0" 2>/dev/null | head -20

} > "${REPORT_FILE}"

echo "Report written to ${REPORT_FILE}"
```

### Handling Denials in CI/CD Pipelines

```bash
#!/bin/bash
# check-selinux-denials.sh - Run in CI after integration tests

THRESHOLD=${MAX_DENIALS:-0}
DENIAL_COUNT=$(ausearch -m AVC -ts recent 2>/dev/null | grep -c "denied")

if [[ ${DENIAL_COUNT} -gt ${THRESHOLD} ]]; then
  echo "FAIL: ${DENIAL_COUNT} SELinux denials detected (threshold: ${THRESHOLD})"
  ausearch -m AVC -ts recent | audit2why
  exit 1
fi

echo "OK: ${DENIAL_COUNT} SELinux denials (threshold: ${THRESHOLD})"
```

### Troubleshooting Complex Multi-Process Denials

```bash
# Trace the full call chain for a denial
# 1. Find the PID in the AVC message
ausearch -m AVC -ts recent | grep "pid=12345"

# 2. Check the process tree
ps -eo pid,ppid,user,label,comm | grep "12345\|$(ps -o ppid= -p 12345)"

# 3. Use strace to identify the exact system call
strace -e trace=file,network -f -p 12345 2>&1 | head -50

# 4. Check if the issue is a transition problem
sesearch --allow -s httpd_t -t usr_t -c file
sesearch --type_trans -s init_t -t httpd_exec_t

# 5. Trace domain transitions
sesearch --type_trans | grep "httpd_exec_t"

# 6. Check if a process is running in wrong domain
ps -eZ | grep httpd
# Should show: system_u:system_r:httpd_t:s0
# If it shows unconfined_t, the transition is broken
```

### Disabling SELinux for Specific Services (Last Resort)

```bash
# Add a domain to permissive mode (NOT disabled, still logs)
semanage permissive -a httpd_t

# Verify
semanage permissive -l

# Re-enable enforcement when policy is fixed
semanage permissive -d httpd_t

# NEVER do this in production:
# setenforce 0  (disables for the whole system)
# SELINUX=disabled in /etc/selinux/config  (requires reboot, no logging)
```

## Section 8: SELinux in Containers and Kubernetes

### Kubernetes Pod Security with SELinux

```yaml
# Enforce SELinux type for pod containers
apiVersion: v1
kind: Pod
metadata:
  name: myapp
spec:
  securityContext:
    seLinuxOptions:
      type: container_t
      level: "s0:c123,c456"
  containers:
    - name: app
      image: myapp:latest
      securityContext:
        seLinuxOptions:
          type: container_t
          level: "s0:c123,c456"
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      hostPath:
        path: /data/myapp
        type: Directory
```

Ensure the host directory has the matching context:

```bash
chcon -R system_u:object_r:container_file_t:s0:c123,c456 /data/myapp
```

### Custom SELinux Policy for Kubernetes Node Agents

When you deploy custom DaemonSets that need elevated host access, create a dedicated SELinux policy:

```te
policy_module(k8s-node-agent, 1.0.0)

require {
    type container_t;
    type container_file_t;
    type sysfs_t;
    type proc_t;
}

# Allow agent to read container metadata
allow container_t sysfs_t:file { read getattr };
allow container_t proc_t:file { read getattr };
```

## Conclusion

SELinux administration reduces to a repeatable workflow: observe denials in the audit log, use booleans and file context relabeling to resolve common issues, and write targeted policy modules for custom applications. The MCS framework provides the container isolation that makes SELinux effective in multi-tenant environments without requiring the complexity of full MLS classification hierarchies. The key discipline is never disabling SELinux globally - instead, isolate the problem domain, use permissive mode to gather policy requirements, write a minimal policy module, and re-enable enforcement.
