---
title: "Linux Security Deep Dive: Capabilities, Namespaces, and Advanced Access Control"
date: 2025-02-19T10:00:00-05:00
draft: false
tags: ["Linux", "Security", "Capabilities", "SELinux", "AppArmor", "Access Control", "Privileged Operations"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Linux security mechanisms including capabilities, mandatory access controls, user namespaces, and advanced privilege separation techniques for building secure systems"
more_link: "yes"
url: "/linux-security-capabilities-deep-dive/"
---

Linux security has evolved far beyond traditional Unix permissions. Modern Linux provides sophisticated security mechanisms including capabilities, mandatory access controls, user namespaces, and fine-grained privilege separation. Understanding these mechanisms is crucial for building secure applications and systems in today's threat landscape.

<!--more-->

# [Linux Security Deep Dive](#linux-security-deep-dive)

## Linux Capabilities System

### Understanding Capabilities

```c
// capabilities_demo.c - Linux capabilities programming
#include <sys/capability.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

// List all capabilities
void list_all_capabilities(void) {
    printf("=== All Linux Capabilities ===\n");
    
    for (int cap = 0; cap <= CAP_LAST_CAP; cap++) {
        char *name = cap_to_name(cap);
        if (name) {
            printf("CAP_%s (%d): %s\n", name, cap, 
                   cap_to_text(&cap, 1));
            cap_free(name);
        }
    }
}

// Check current process capabilities
void check_current_capabilities(void) {
    cap_t caps;
    char *caps_text;
    
    caps = cap_get_proc();
    if (caps == NULL) {
        perror("cap_get_proc");
        return;
    }
    
    caps_text = cap_to_text(caps, NULL);
    if (caps_text == NULL) {
        perror("cap_to_text");
        cap_free(caps);
        return;
    }
    
    printf("Current process capabilities: %s\n", caps_text);
    
    cap_free(caps);
    cap_free(caps_text);
}

// Set specific capabilities
int set_capabilities(cap_value_t *cap_list, int num_caps) {
    cap_t caps;
    
    // Get current capabilities
    caps = cap_get_proc();
    if (caps == NULL) {
        perror("cap_get_proc");
        return -1;
    }
    
    // Clear all capabilities
    if (cap_clear(caps) == -1) {
        perror("cap_clear");
        cap_free(caps);
        return -1;
    }
    
    // Set specific capabilities
    if (cap_set_flag(caps, CAP_EFFECTIVE, num_caps, cap_list, CAP_SET) == -1 ||
        cap_set_flag(caps, CAP_PERMITTED, num_caps, cap_list, CAP_SET) == -1) {
        perror("cap_set_flag");
        cap_free(caps);
        return -1;
    }
    
    // Apply capabilities
    if (cap_set_proc(caps) == -1) {
        perror("cap_set_proc");
        cap_free(caps);
        return -1;
    }
    
    cap_free(caps);
    return 0;
}

// Drop all capabilities
void drop_all_capabilities(void) {
    cap_t caps;
    
    caps = cap_init();
    if (caps == NULL) {
        perror("cap_init");
        return;
    }
    
    if (cap_set_proc(caps) == -1) {
        perror("cap_set_proc");
    }
    
    cap_free(caps);
    printf("All capabilities dropped\n");
}

// Capability-aware privilege dropping
void safe_privilege_drop(uid_t new_uid, gid_t new_gid) {
    // Keep only necessary capabilities
    cap_value_t caps_to_keep[] = {CAP_NET_BIND_SERVICE, CAP_DAC_OVERRIDE};
    
    // Set capabilities before dropping privileges
    if (set_capabilities(caps_to_keep, 2) == -1) {
        fprintf(stderr, "Failed to set capabilities\n");
        exit(1);
    }
    
    // Drop group privileges
    if (setgid(new_gid) == -1) {
        perror("setgid");
        exit(1);
    }
    
    // Drop user privileges
    if (setuid(new_uid) == -1) {
        perror("setuid");
        exit(1);
    }
    
    printf("Dropped privileges to uid=%d, gid=%d\n", new_uid, new_gid);
    check_current_capabilities();
}

// File capabilities demonstration
void demonstrate_file_capabilities(const char *filename) {
    cap_t file_caps;
    char *caps_text;
    
    // Get file capabilities
    file_caps = cap_get_file(filename);
    if (file_caps == NULL) {
        if (errno == ENODATA) {
            printf("File %s has no capabilities\n", filename);
        } else {
            perror("cap_get_file");
        }
        return;
    }
    
    caps_text = cap_to_text(file_caps, NULL);
    if (caps_text) {
        printf("File %s capabilities: %s\n", filename, caps_text);
        cap_free(caps_text);
    }
    
    cap_free(file_caps);
}

// Set file capabilities
int set_file_capabilities(const char *filename, const char *cap_string) {
    cap_t caps;
    
    caps = cap_from_text(cap_string);
    if (caps == NULL) {
        perror("cap_from_text");
        return -1;
    }
    
    if (cap_set_file(filename, caps) == -1) {
        perror("cap_set_file");
        cap_free(caps);
        return -1;
    }
    
    cap_free(caps);
    printf("Set capabilities on %s: %s\n", filename, cap_string);
    return 0;
}

int main(int argc, char *argv[]) {
    printf("=== Linux Capabilities Demo ===\n\n");
    
    // Check if running as root
    if (getuid() == 0) {
        printf("Running as root - demonstrating capability operations\n\n");
        
        check_current_capabilities();
        printf("\n");
        
        // Demonstrate privilege dropping with capabilities
        safe_privilege_drop(1000, 1000);
        printf("\n");
        
        if (argc > 1) {
            demonstrate_file_capabilities(argv[1]);
        }
    } else {
        printf("Running as non-root user\n");
        check_current_capabilities();
    }
    
    return 0;
}
```

### Capability Management Tools

```bash
#!/bin/bash
# capability_management.sh - Capability management utilities

# Check process capabilities
check_process_caps() {
    local pid=${1:-$$}
    
    echo "=== Process Capabilities (PID: $pid) ==="
    
    if [ -f "/proc/$pid/status" ]; then
        grep -E "^Cap" /proc/$pid/status
        echo
        
        # Decode capability masks
        echo "Decoded capabilities:"
        capsh --decode=$(grep CapEff /proc/$pid/status | awk '{print $2}')
    else
        echo "Process $pid not found"
    fi
}

# Set file capabilities
set_file_caps() {
    local file=$1
    local caps=$2
    
    if [ ! -f "$file" ]; then
        echo "File not found: $file"
        return 1
    fi
    
    echo "Setting capabilities on $file: $caps"
    setcap "$caps" "$file"
    
    if [ $? -eq 0 ]; then
        echo "Capabilities set successfully"
        getcap "$file"
    else
        echo "Failed to set capabilities"
        return 1
    fi
}

# Remove file capabilities
remove_file_caps() {
    local file=$1
    
    echo "Removing capabilities from $file"
    setcap -r "$file"
    
    if [ $? -eq 0 ]; then
        echo "Capabilities removed successfully"
    else
        echo "Failed to remove capabilities"
    fi
}

# Audit capabilities across system
audit_capabilities() {
    echo "=== System Capability Audit ==="
    
    # Find files with capabilities
    echo "Files with capabilities:"
    find /usr /bin /sbin -type f -exec getcap {} + 2>/dev/null | \
        grep -v "= $" | head -20
    echo
    
    # Check running processes with capabilities
    echo "Processes with capabilities:"
    for pid in $(ps -eo pid --no-headers); do
        if [ -f "/proc/$pid/status" ]; then
            caps=$(grep CapEff /proc/$pid/status 2>/dev/null | awk '{print $2}')
            if [ "$caps" != "0000000000000000" ] && [ -n "$caps" ]; then
                cmd=$(ps -p $pid -o comm= 2>/dev/null)
                echo "PID $pid ($cmd): $caps"
            fi
        fi
    done | head -10
}

# Capability-aware service wrapper
run_with_caps() {
    local caps=$1
    shift
    local command="$@"
    
    echo "Running with capabilities: $caps"
    echo "Command: $command"
    
    # Use capsh to run with specific capabilities
    capsh --caps="$caps" --user=$(whoami) -- -c "$command"
}

# Create capability-restricted environment
create_restricted_env() {
    local user=$1
    local caps=$2
    
    echo "Creating restricted environment for $user with caps: $caps"
    
    # Create a script that drops to user with specific caps
    cat > /tmp/restricted_shell << EOF
#!/bin/bash
exec capsh --caps="$caps" --user="$user" --shell=/bin/bash
EOF
    
    chmod +x /tmp/restricted_shell
    echo "Restricted shell created at /tmp/restricted_shell"
}

# Test capability requirements
test_capability_requirements() {
    local program=$1
    
    echo "=== Testing Capability Requirements for $program ==="
    
    # Test different capability combinations
    local test_caps=(
        "cap_net_bind_service=ep"
        "cap_dac_override=ep" 
        "cap_sys_admin=ep"
        "cap_net_raw=ep"
        "cap_setuid,cap_setgid=ep"
    )
    
    for cap in "${test_caps[@]}"; do
        echo "Testing with: $cap"
        
        # Copy program to test location
        cp "$program" "/tmp/test_$(basename $program)"
        
        # Set capability
        setcap "$cap" "/tmp/test_$(basename $program)" 2>/dev/null
        
        if [ $? -eq 0 ]; then
            echo "  ✓ Capability set successfully"
            
            # Test execution
            timeout 5 "/tmp/test_$(basename $program)" --version >/dev/null 2>&1
            if [ $? -eq 0 ]; then
                echo "  ✓ Program runs with this capability"
            else
                echo "  ✗ Program fails with this capability"
            fi
        else
            echo "  ✗ Failed to set capability"
        fi
        
        # Cleanup
        rm -f "/tmp/test_$(basename $program)"
        echo
    done
}
```

## Mandatory Access Control (MAC)

### SELinux Programming

```c
// selinux_demo.c - SELinux programming interface
#include <selinux/selinux.h>
#include <selinux/context.h>
#include <selinux/label.h>
#include <selinux/restorecon.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/stat.h>

// Check SELinux status
void check_selinux_status(void) {
    printf("=== SELinux Status ===\n");
    
    if (is_selinux_enabled()) {
        printf("SELinux is enabled\n");
        
        // Get current mode
        int mode = security_getenforce();
        switch (mode) {
            case 1:
                printf("Mode: Enforcing\n");
                break;
            case 0:
                printf("Mode: Permissive\n");
                break;
            default:
                printf("Mode: Unknown\n");
        }
        
        // Get policy version
        int policy_version = security_policyvers();
        printf("Policy version: %d\n", policy_version);
        
        // Get SELinux mount point
        const char *selinux_mnt = selinux_mnt();
        printf("SELinux filesystem: %s\n", selinux_mnt);
        
    } else {
        printf("SELinux is disabled\n");
    }
}

// Get and display security context
void show_security_context(const char *path) {
    char *context;
    
    if (getfilecon(path, &context) == -1) {
        perror("getfilecon");
        return;
    }
    
    printf("Security context of %s: %s\n", path, context);
    
    // Parse context components
    context_t con = context_new(context);
    if (con) {
        printf("  User: %s\n", context_user_get(con));
        printf("  Role: %s\n", context_role_get(con));
        printf("  Type: %s\n", context_type_get(con));
        printf("  Level: %s\n", context_range_get(con));
        context_free(con);
    }
    
    freecon(context);
}

// Set security context
int set_security_context(const char *path, const char *context) {
    if (setfilecon(path, context) == -1) {
        perror("setfilecon");
        return -1;
    }
    
    printf("Set security context of %s to %s\n", path, context);
    return 0;
}

// Check access permissions
void check_access_permissions(const char *path, const char *avc_class) {
    char *user_context;
    char *file_context;
    
    // Get current process context
    if (getcon(&user_context) == -1) {
        perror("getcon");
        return;
    }
    
    // Get file context
    if (getfilecon(path, &file_context) == -1) {
        perror("getfilecon");
        freecon(user_context);
        return;
    }
    
    printf("Checking access: %s -> %s (%s)\n", 
           user_context, file_context, avc_class);
    
    // Check various permissions
    const char *permissions[] = {"read", "write", "execute", "open"};
    
    for (int i = 0; i < 4; i++) {
        int result = security_compute_av(user_context, file_context,
                                       string_to_security_class(avc_class),
                                       string_to_av_perm(string_to_security_class(avc_class),
                                                        permissions[i]),
                                       NULL);
        
        printf("  %s: %s\n", permissions[i], 
               (result == 0) ? "ALLOWED" : "DENIED");
    }
    
    freecon(user_context);
    freecon(file_context);
}

// Restore file contexts
void restore_file_contexts(const char *path) {
    struct selabel_handle *hnd;
    char *context;
    struct stat st;
    
    // Initialize labeling handle
    hnd = selabel_open(SELABEL_CTX_FILE, NULL, 0);
    if (!hnd) {
        perror("selabel_open");
        return;
    }
    
    // Get file stats
    if (stat(path, &st) == -1) {
        perror("stat");
        selabel_close(hnd);
        return;
    }
    
    // Get expected context
    if (selabel_lookup(hnd, &context, path, st.st_mode) == 0) {
        printf("Expected context for %s: %s\n", path, context);
        
        // Set the context
        if (setfilecon(path, context) == -1) {
            perror("setfilecon");
        } else {
            printf("Restored context for %s\n", path);
        }
        
        freecon(context);
    } else {
        printf("No default context found for %s\n", path);
    }
    
    selabel_close(hnd);
}

// Domain transition example
void demonstrate_domain_transition(void) {
    char *current_context;
    char *exec_context;
    
    // Get current context
    if (getcon(&current_context) == -1) {
        perror("getcon");
        return;
    }
    
    printf("Current domain: %s\n", current_context);
    
    // Check what domain we would transition to
    if (getexeccon(&exec_context) == 0 && exec_context) {
        printf("Exec context: %s\n", exec_context);
        freecon(exec_context);
    } else {
        printf("No exec context set\n");
    }
    
    freecon(current_context);
}

int main(int argc, char *argv[]) {
    printf("=== SELinux Programming Demo ===\n\n");
    
    check_selinux_status();
    printf("\n");
    
    if (!is_selinux_enabled()) {
        printf("SELinux not enabled, exiting\n");
        return 1;
    }
    
    // Demonstrate with a file
    const char *test_file = (argc > 1) ? argv[1] : "/etc/passwd";
    
    show_security_context(test_file);
    printf("\n");
    
    check_access_permissions(test_file, "file");
    printf("\n");
    
    demonstrate_domain_transition();
    
    return 0;
}
```

### SELinux Policy Management

```bash
#!/bin/bash
# selinux_management.sh - SELinux policy and context management

# Check SELinux status
check_selinux() {
    echo "=== SELinux Status ==="
    
    if command -v getenforce >/dev/null; then
        echo "Status: $(getenforce)"
        echo "Config: $(grep ^SELINUX= /etc/selinux/config 2>/dev/null || echo 'Not configured')"
        
        if [ "$(getenforce)" != "Disabled" ]; then
            echo "Policy: $(selinuxenabled && sestatus | grep 'Policy from config')"
            echo "Mode from config: $(grep ^SELINUXTYPE= /etc/selinux/config 2>/dev/null)"
        fi
    else
        echo "SELinux tools not available"
    fi
    echo
}

# Show current context
show_current_context() {
    echo "=== Current Security Context ==="
    
    if command -v id >/dev/null; then
        id -Z 2>/dev/null || echo "Context not available"
    fi
    echo
}

# File context analysis
analyze_file_contexts() {
    local path=${1:-"/etc"}
    
    echo "=== File Context Analysis: $path ==="
    
    # Show contexts
    ls -lZ "$path" 2>/dev/null | head -10
    echo
    
    # Show mismatched contexts
    echo "Files with mismatched contexts:"
    restorecon -n -v "$path"/* 2>/dev/null | head -5
    echo
}

# Process context analysis
analyze_process_contexts() {
    echo "=== Process Context Analysis ==="
    
    echo "Running processes with contexts:"
    ps auxZ 2>/dev/null | head -10
    echo
    
    # System services
    echo "Systemd services and their contexts:"
    systemctl list-units --type=service --state=active | head -5 | \
    while read service _; do
        if [[ $service =~ \.service$ ]]; then
            echo -n "$service: "
            systemctl show -p ExecMainPID --value "$service" | \
            xargs -I {} sh -c 'ps -p {} -o label= 2>/dev/null || echo "No context"'
        fi
    done
}

# Boolean management
manage_booleans() {
    echo "=== SELinux Booleans ==="
    
    if command -v getsebool >/dev/null; then
        echo "Active booleans (showing first 10):"
        getsebool -a | head -10
        echo
        
        echo "Booleans that are 'on':"
        getsebool -a | grep " on$" | head -5
    else
        echo "SELinux boolean tools not available"
    fi
    echo
}

# Port context management
manage_port_contexts() {
    echo "=== Port Context Management ==="
    
    if command -v semanage >/dev/null; then
        echo "Port contexts:"
        semanage port -l | head -10
        echo
        
        echo "Custom port contexts:"
        semanage port -l -C 2>/dev/null || echo "None"
    else
        echo "semanage not available"
    fi
    echo
}

# AVC denial analysis
analyze_avc_denials() {
    local logfile=${1:-"/var/log/audit/audit.log"}
    
    echo "=== AVC Denial Analysis ==="
    
    if [ -f "$logfile" ]; then
        echo "Recent AVC denials:"
        grep "avc.*denied" "$logfile" 2>/dev/null | tail -5
        echo
        
        # Use audit2allow if available
        if command -v audit2allow >/dev/null; then
            echo "Suggested policy (last 10 denials):"
            grep "avc.*denied" "$logfile" 2>/dev/null | tail -10 | \
            audit2allow 2>/dev/null || echo "No denials to analyze"
        fi
    else
        echo "Audit log not found: $logfile"
    fi
    echo
}

# Create custom policy module
create_policy_module() {
    local module_name=$1
    local te_content=$2
    
    if [ -z "$module_name" ] || [ -z "$te_content" ]; then
        echo "Usage: create_policy_module <name> <te_content>"
        return 1
    fi
    
    echo "Creating SELinux policy module: $module_name"
    
    # Create .te file
    cat > "${module_name}.te" << EOF
module $module_name 1.0;

require {
    type unconfined_t;
    class file { read write open };
}

$te_content
EOF
    
    # Compile and install
    if command -v checkmodule >/dev/null && command -v semodule_package >/dev/null; then
        checkmodule -M -m -o "${module_name}.mod" "${module_name}.te"
        semodule_package -o "${module_name}.pp" -m "${module_name}.mod"
        
        echo "Policy module created: ${module_name}.pp"
        echo "Install with: semodule -i ${module_name}.pp"
    else
        echo "SELinux development tools not available"
    fi
}

# Security context restoration
restore_contexts() {
    local path=${1:-"/"}
    local recursive=${2:-"false"}
    
    echo "=== Restoring Security Contexts ==="
    echo "Path: $path"
    echo "Recursive: $recursive"
    
    if [ "$recursive" = "true" ]; then
        restorecon -R -v "$path" 2>/dev/null | head -10
    else
        restorecon -v "$path" 2>/dev/null
    fi
}

# SELinux troubleshooting
troubleshoot_selinux() {
    echo "=== SELinux Troubleshooting ==="
    
    # Check if SELinux is causing issues
    echo "1. Check current enforcement:"
    getenforce 2>/dev/null || echo "getenforce not available"
    echo
    
    echo "2. Recent denials:"
    journalctl -t setroubleshoot --since "1 hour ago" 2>/dev/null | head -5 || \
    echo "No setroubleshoot entries found"
    echo
    
    echo "3. Temporary enforcement change (for testing):"
    echo "   setenforce 0  # Permissive mode"
    echo "   setenforce 1  # Enforcing mode"
    echo
    
    echo "4. Common fixes:"
    echo "   - Restore contexts: restorecon -R /path"
    echo "   - Set boolean: setsebool boolean_name on"
    echo "   - Add file context: semanage fcontext -a -t type_t '/path(/.*)?'"
    echo "   - Relabel filesystem: touch /.autorelabel && reboot"
}

# Main function
case "${1:-status}" in
    "status")
        check_selinux
        show_current_context
        ;;
    "files")
        analyze_file_contexts "$2"
        ;;
    "processes")
        analyze_process_contexts
        ;;
    "booleans")
        manage_booleans
        ;;
    "ports")
        manage_port_contexts
        ;;
    "denials")
        analyze_avc_denials "$2"
        ;;
    "restore")
        restore_contexts "$2" "$3"
        ;;
    "troubleshoot")
        troubleshoot_selinux
        ;;
    *)
        echo "Usage: $0 {status|files|processes|booleans|ports|denials|restore|troubleshoot} [path]"
        exit 1
        ;;
esac
```

## User Namespaces and Privilege Separation

### User Namespace Programming

```c
// user_namespace.c - User namespace programming
#define _GNU_SOURCE
#include <sched.h>
#include <sys/wait.h>
#include <sys/mount.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

// Create user namespace with UID/GID mapping
int create_user_namespace(uid_t inside_uid, gid_t inside_gid,
                         uid_t outside_uid, gid_t outside_gid) {
    pid_t child_pid;
    char map_path[256];
    char map_line[256];
    int fd;
    
    // Create new user namespace
    child_pid = fork();
    if (child_pid == -1) {
        perror("fork");
        return -1;
    }
    
    if (child_pid == 0) {
        // Child process - inside the new namespace
        printf("Child: PID=%d, UID=%d, GID=%d\n", 
               getpid(), getuid(), getgid());
        
        // Wait for parent to set up mappings
        sleep(1);
        
        printf("Child: After mapping - UID=%d, GID=%d\n", 
               getuid(), getgid());
        
        // Try to access privileged operations
        if (geteuid() == 0) {
            printf("Child: Running as root inside namespace\n");
            
            // Create a file
            int fd = open("/tmp/namespace_test", O_CREAT | O_WRONLY, 0644);
            if (fd >= 0) {
                write(fd, "Created by namespace root\n", 26);
                close(fd);
                printf("Child: Created file successfully\n");
            } else {
                perror("Child: Failed to create file");
            }
        }
        
        return 0;
    } else {
        // Parent process - set up UID/GID mappings
        
        // Set UID mapping
        snprintf(map_path, sizeof(map_path), "/proc/%d/uid_map", child_pid);
        snprintf(map_line, sizeof(map_line), "%d %d 1", inside_uid, outside_uid);
        
        fd = open(map_path, O_WRONLY);
        if (fd >= 0) {
            write(fd, map_line, strlen(map_line));
            close(fd);
        } else {
            perror("Failed to write uid_map");
        }
        
        // Deny setgroups for GID mapping
        snprintf(map_path, sizeof(map_path), "/proc/%d/setgroups", child_pid);
        fd = open(map_path, O_WRONLY);
        if (fd >= 0) {
            write(fd, "deny", 4);
            close(fd);
        }
        
        // Set GID mapping
        snprintf(map_path, sizeof(map_path), "/proc/%d/gid_map", child_pid);
        snprintf(map_line, sizeof(map_line), "%d %d 1", inside_gid, outside_gid);
        
        fd = open(map_path, O_WRONLY);
        if (fd >= 0) {
            write(fd, map_line, strlen(map_line));
            close(fd);
        } else {
            perror("Failed to write gid_map");
        }
        
        // Wait for child
        wait(NULL);
        return 0;
    }
}

// Create container-like environment with multiple namespaces
int create_container(void) {
    pid_t child_pid;
    
    // Clone with multiple namespace flags
    child_pid = clone(container_main, 
                     malloc(4096) + 4096,  // Stack for new process
                     CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | 
                     CLONE_NEWNS | CLONE_NEWUTS | CLONE_NEWIPC,
                     NULL);
    
    if (child_pid == -1) {
        perror("clone");
        return -1;
    }
    
    printf("Container created with PID %d\n", child_pid);
    
    // Set up UID/GID mappings (as in previous function)
    // ... mapping code here ...
    
    wait(NULL);
    return 0;
}

int container_main(void *arg) {
    printf("Container: PID=%d (should be 1), UID=%d, GID=%d\n",
           getpid(), getuid(), getgid());
    
    // Set hostname
    sethostname("container", 9);
    
    // Mount new filesystem
    if (mount("none", "/proc", "proc", 0, NULL) == -1) {
        perror("mount /proc");
    }
    
    // Create a simple shell environment
    execl("/bin/sh", "sh", NULL);
    perror("execl");
    return -1;
}

// Secure application launcher
int launch_secure_app(const char *app_path, char *const argv[]) {
    pid_t child_pid;
    
    child_pid = fork();
    if (child_pid == -1) {
        perror("fork");
        return -1;
    }
    
    if (child_pid == 0) {
        // Child: Create security boundaries
        
        // Create new user namespace
        if (unshare(CLONE_NEWUSER) == -1) {
            perror("unshare user namespace");
            exit(1);
        }
        
        // Set up UID/GID mappings to run as non-root
        // (Mapping code would go here)
        
        // Create new mount namespace
        if (unshare(CLONE_NEWNS) == -1) {
            perror("unshare mount namespace");
            exit(1);
        }
        
        // Make root filesystem read-only
        if (mount("none", "/", NULL, MS_REMOUNT | MS_RDONLY, NULL) == -1) {
            perror("remount root read-only");
        }
        
        // Create private /tmp
        if (mount("tmpfs", "/tmp", "tmpfs", 0, "size=100m") == -1) {
            perror("mount private /tmp");
        }
        
        // Execute application
        execv(app_path, argv);
        perror("execv");
        exit(1);
    } else {
        // Parent: Monitor child
        int status;
        wait(&status);
        
        if (WIFEXITED(status)) {
            printf("Application exited with status %d\n", WEXITSTATUS(status));
        } else if (WIFSIGNALED(status)) {
            printf("Application killed by signal %d\n", WTERMSIG(status));
        }
        
        return WEXITSTATUS(status);
    }
}

// Demonstrate namespace isolation
void demonstrate_isolation(void) {
    printf("=== Namespace Isolation Demo ===\n");
    
    printf("Original namespaces:\n");
    system("ls -la /proc/self/ns/");
    
    // Create user namespace
    if (unshare(CLONE_NEWUSER | CLONE_NEWNET) == 0) {
        printf("\nAfter creating new namespaces:\n");
        system("ls -la /proc/self/ns/");
        
        printf("\nNetwork interfaces in new namespace:\n");
        system("ip link show 2>/dev/null || echo 'No network interfaces'");
    } else {
        perror("unshare");
    }
}

int main(int argc, char *argv[]) {
    printf("=== User Namespace Demo ===\n\n");
    
    if (getuid() != 0) {
        printf("Running as non-root user (UID: %d)\n", getuid());
        printf("Creating user namespace with root mapping...\n\n");
        
        create_user_namespace(0, 0, getuid(), getgid());
    } else {
        printf("Running as root\n");
        demonstrate_isolation();
    }
    
    return 0;
}
```

## Secure Application Development

### Privilege Separation Patterns

```c
// privilege_separation.c - Secure application architecture
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pwd.h>
#include <grp.h>
#include <errno.h>

// Message types for IPC
enum msg_type {
    MSG_READ_FILE,
    MSG_WRITE_FILE,
    MSG_NET_CONNECT,
    MSG_RESPONSE,
    MSG_ERROR
};

struct ipc_message {
    enum msg_type type;
    size_t data_len;
    char data[];
};

// Privileged helper process
int privileged_helper(int sock_fd) {
    struct ipc_message *msg;
    char buffer[4096];
    ssize_t n;
    
    printf("Privileged helper started (UID: %d)\n", getuid());
    
    while (1) {
        // Receive message header
        n = recv(sock_fd, buffer, sizeof(struct ipc_message), 0);
        if (n <= 0) break;
        
        msg = (struct ipc_message *)buffer;
        
        // Receive message data if any
        if (msg->data_len > 0) {
            n = recv(sock_fd, buffer + sizeof(struct ipc_message), 
                    msg->data_len, 0);
            if (n <= 0) break;
        }
        
        // Process request based on type
        switch (msg->type) {
            case MSG_READ_FILE: {
                printf("Helper: Reading file %s\n", msg->data);
                
                // Validate file path (security check)
                if (strstr(msg->data, "..") || msg->data[0] != '/') {
                    send_error(sock_fd, "Invalid file path");
                    break;
                }
                
                // Read file and send response
                FILE *fp = fopen(msg->data, "r");
                if (fp) {
                    char content[1024];
                    size_t len = fread(content, 1, sizeof(content) - 1, fp);
                    content[len] = '\0';
                    fclose(fp);
                    
                    send_response(sock_fd, content, len);
                } else {
                    send_error(sock_fd, "File not found");
                }
                break;
            }
            
            case MSG_NET_CONNECT: {
                printf("Helper: Network connect to %s\n", msg->data);
                
                // Implement network connection logic
                // This would be done with elevated privileges
                send_response(sock_fd, "Connected", 9);
                break;
            }
            
            default:
                send_error(sock_fd, "Unknown message type");
                break;
        }
    }
    
    return 0;
}

// Unprivileged main process
int unprivileged_main(int sock_fd) {
    char response[1024];
    
    printf("Main process started (UID: %d)\n", getuid());
    
    // Request file read through privileged helper
    send_request(sock_fd, MSG_READ_FILE, "/etc/hostname", strlen("/etc/hostname"));
    
    if (receive_response(sock_fd, response, sizeof(response)) > 0) {
        printf("Main: Received file content: %s\n", response);
    }
    
    // Request network operation
    send_request(sock_fd, MSG_NET_CONNECT, "example.com:80", strlen("example.com:80"));
    
    if (receive_response(sock_fd, response, sizeof(response)) > 0) {
        printf("Main: Network response: %s\n", response);
    }
    
    return 0;
}

// Helper functions for IPC
void send_request(int sock_fd, enum msg_type type, const char *data, size_t len) {
    struct ipc_message *msg = malloc(sizeof(struct ipc_message) + len);
    
    msg->type = type;
    msg->data_len = len;
    memcpy(msg->data, data, len);
    
    send(sock_fd, msg, sizeof(struct ipc_message) + len, 0);
    free(msg);
}

void send_response(int sock_fd, const char *data, size_t len) {
    struct ipc_message *msg = malloc(sizeof(struct ipc_message) + len);
    
    msg->type = MSG_RESPONSE;
    msg->data_len = len;
    memcpy(msg->data, data, len);
    
    send(sock_fd, msg, sizeof(struct ipc_message) + len, 0);
    free(msg);
}

void send_error(int sock_fd, const char *error) {
    send_response(sock_fd, error, strlen(error));
}

ssize_t receive_response(int sock_fd, char *buffer, size_t buf_size) {
    struct ipc_message msg_header;
    ssize_t n;
    
    // Receive header
    n = recv(sock_fd, &msg_header, sizeof(msg_header), 0);
    if (n <= 0) return n;
    
    // Receive data
    if (msg_header.data_len > 0 && msg_header.data_len < buf_size) {
        n = recv(sock_fd, buffer, msg_header.data_len, 0);
        if (n > 0) {
            buffer[n] = '\0';
        }
        return n;
    }
    
    return 0;
}

// Drop privileges safely
int drop_privileges(const char *username) {
    struct passwd *pw;
    
    // Look up user
    pw = getpwnam(username);
    if (!pw) {
        fprintf(stderr, "User %s not found\n", username);
        return -1;
    }
    
    // Change group first
    if (setgid(pw->pw_gid) == -1) {
        perror("setgid");
        return -1;
    }
    
    // Initialize supplementary groups
    if (initgroups(username, pw->pw_gid) == -1) {
        perror("initgroups");
        return -1;
    }
    
    // Change user
    if (setuid(pw->pw_uid) == -1) {
        perror("setuid");
        return -1;
    }
    
    // Verify we can't regain privileges
    if (setuid(0) == 0) {
        fprintf(stderr, "ERROR: Could regain root privileges!\n");
        return -1;
    }
    
    printf("Successfully dropped privileges to %s (UID: %d, GID: %d)\n",
           username, getuid(), getgid());
    
    return 0;
}

int main(int argc, char *argv[]) {
    int sock_pair[2];
    pid_t child_pid;
    
    printf("=== Privilege Separation Demo ===\n");
    
    // Create socket pair for IPC
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sock_pair) == -1) {
        perror("socketpair");
        return 1;
    }
    
    // Fork into privileged helper and unprivileged main
    child_pid = fork();
    if (child_pid == -1) {
        perror("fork");
        return 1;
    }
    
    if (child_pid == 0) {
        // Child: Privileged helper
        close(sock_pair[1]);
        
        // Keep running as root for privileged operations
        return privileged_helper(sock_pair[0]);
    } else {
        // Parent: Unprivileged main process
        close(sock_pair[0]);
        
        // Drop privileges
        if (getuid() == 0) {
            if (drop_privileges("nobody") == -1) {
                kill(child_pid, SIGTERM);
                return 1;
            }
        }
        
        // Run main application logic
        int result = unprivileged_main(sock_pair[1]);
        
        // Clean up
        close(sock_pair[1]);
        wait(NULL);
        
        return result;
    }
}
```

### Secure Coding Patterns

```c
// secure_coding.c - Secure coding patterns and techniques
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <errno.h>
#include <limits.h>

// Secure string handling
char* secure_strdup(const char* src, size_t max_len) {
    if (!src) return NULL;
    
    size_t len = strnlen(src, max_len);
    if (len == max_len) {
        errno = E2BIG;
        return NULL;
    }
    
    char* dest = malloc(len + 1);
    if (!dest) return NULL;
    
    memcpy(dest, src, len);
    dest[len] = '\0';
    
    return dest;
}

// Secure buffer operations
int secure_concat(char* dest, size_t dest_size, const char* src) {
    size_t dest_len = strnlen(dest, dest_size);
    size_t src_len = strnlen(src, dest_size);
    
    if (dest_len == dest_size) {
        return -1; // dest not null-terminated
    }
    
    if (dest_len + src_len >= dest_size) {
        return -1; // would overflow
    }
    
    strncat(dest, src, dest_size - dest_len - 1);
    return 0;
}

// Secure memory allocation
void* secure_malloc(size_t size) {
    // Check for integer overflow
    if (size == 0 || size > SIZE_MAX / 2) {
        errno = EINVAL;
        return NULL;
    }
    
    void* ptr = malloc(size);
    if (ptr) {
        // Clear allocated memory
        memset(ptr, 0, size);
    }
    
    return ptr;
}

// Secure memory cleanup
void secure_free(void* ptr, size_t size) {
    if (ptr && size > 0) {
        // Clear sensitive data
        explicit_bzero(ptr, size);
        free(ptr);
    }
}

// Secure password handling
typedef struct {
    char* data;
    size_t length;
    size_t capacity;
} secure_string_t;

secure_string_t* secure_string_new(size_t initial_capacity) {
    secure_string_t* str = malloc(sizeof(secure_string_t));
    if (!str) return NULL;
    
    // Use mlock to prevent swapping to disk
    str->data = mmap(NULL, initial_capacity, 
                    PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS,
                    -1, 0);
    
    if (str->data == MAP_FAILED) {
        free(str);
        return NULL;
    }
    
    // Lock memory to prevent swapping
    if (mlock(str->data, initial_capacity) == -1) {
        munmap(str->data, initial_capacity);
        free(str);
        return NULL;
    }
    
    str->length = 0;
    str->capacity = initial_capacity;
    
    return str;
}

void secure_string_destroy(secure_string_t* str) {
    if (str) {
        if (str->data) {
            // Clear sensitive data
            explicit_bzero(str->data, str->capacity);
            munlock(str->data, str->capacity);
            munmap(str->data, str->capacity);
        }
        explicit_bzero(str, sizeof(secure_string_t));
        free(str);
    }
}

// Input validation
int validate_input(const char* input, size_t max_len) {
    if (!input) return 0;
    
    size_t len = strnlen(input, max_len + 1);
    if (len > max_len) return 0;
    
    // Check for null bytes (potential null byte injection)
    if (strlen(input) != len) return 0;
    
    // Validate characters (example: alphanumeric only)
    for (size_t i = 0; i < len; i++) {
        if (!((input[i] >= 'a' && input[i] <= 'z') ||
              (input[i] >= 'A' && input[i] <= 'Z') ||
              (input[i] >= '0' && input[i] <= '9') ||
              input[i] == '_' || input[i] == '-')) {
            return 0;
        }
    }
    
    return 1;
}

// Safe file operations
FILE* secure_fopen(const char* filename, const char* mode) {
    // Validate filename
    if (!filename || !validate_input(filename, PATH_MAX)) {
        errno = EINVAL;
        return NULL;
    }
    
    // Prevent path traversal
    if (strstr(filename, "..") || filename[0] != '/') {
        errno = EINVAL;
        return NULL;
    }
    
    // Open with O_NOFOLLOW to prevent symlink attacks
    int flags = O_NOFOLLOW;
    if (strchr(mode, 'r')) flags |= O_RDONLY;
    if (strchr(mode, 'w')) flags |= O_WRONLY | O_CREAT | O_TRUNC;
    if (strchr(mode, 'a')) flags |= O_WRONLY | O_CREAT | O_APPEND;
    
    int fd = open(filename, flags, 0644);
    if (fd == -1) return NULL;
    
    return fdopen(fd, mode);
}

// Timing-safe comparison
int timing_safe_compare(const void* a, const void* b, size_t len) {
    const unsigned char* ua = a;
    const unsigned char* ub = b;
    unsigned char result = 0;
    
    for (size_t i = 0; i < len; i++) {
        result |= ua[i] ^ ub[i];
    }
    
    return result == 0;
}

// Random number generation
int secure_random_bytes(void* buf, size_t len) {
    FILE* fp = fopen("/dev/urandom", "rb");
    if (!fp) return -1;
    
    size_t read_bytes = fread(buf, 1, len, fp);
    fclose(fp);
    
    return (read_bytes == len) ? 0 : -1;
}

// Demonstration of secure patterns
int main() {
    printf("=== Secure Coding Patterns Demo ===\n\n");
    
    // Secure string handling
    char buffer[256] = "Hello, ";
    if (secure_concat(buffer, sizeof(buffer), "World!") == 0) {
        printf("Secure concatenation: %s\n", buffer);
    }
    
    // Secure memory
    char* secure_data = secure_malloc(1024);
    if (secure_data) {
        strcpy(secure_data, "Sensitive data");
        printf("Allocated secure memory\n");
        secure_free(secure_data, 1024);
    }
    
    // Secure string for passwords
    secure_string_t* password = secure_string_new(256);
    if (password) {
        printf("Created secure string for password storage\n");
        secure_string_destroy(password);
    }
    
    // Input validation
    const char* test_input = "valid_input_123";
    if (validate_input(test_input, 50)) {
        printf("Input validation: PASSED\n");
    } else {
        printf("Input validation: FAILED\n");
    }
    
    // Timing-safe comparison
    char hash1[] = "secret_hash";
    char hash2[] = "secret_hash";
    if (timing_safe_compare(hash1, hash2, strlen(hash1))) {
        printf("Timing-safe comparison: MATCH\n");
    } else {
        printf("Timing-safe comparison: NO MATCH\n");
    }
    
    // Random bytes
    unsigned char random_data[16];
    if (secure_random_bytes(random_data, sizeof(random_data)) == 0) {
        printf("Generated %zu random bytes\n", sizeof(random_data));
    }
    
    return 0;
}
```

## Security Auditing and Monitoring

### Security Event Monitoring

```bash
#!/bin/bash
# security_monitor.sh - Security event monitoring and alerting

# Monitor authentication events
monitor_auth_events() {
    echo "=== Authentication Monitoring ==="
    
    # Failed login attempts
    echo "Recent failed login attempts:"
    journalctl -u ssh --since "1 hour ago" | grep "Failed password" | \
    awk '{print $1, $2, $3, $11}' | sort | uniq -c | sort -nr | head -10
    echo
    
    # Successful logins
    echo "Recent successful logins:"
    journalctl -u ssh --since "1 hour ago" | grep "Accepted" | \
    awk '{print $1, $2, $3, $9, $11}' | tail -10
    echo
    
    # Root login attempts
    echo "Root login attempts:"
    journalctl --since "1 hour ago" | grep -i "root" | grep -E "(login|su|sudo)" | tail -5
    echo
}

# Monitor privilege escalation
monitor_privilege_escalation() {
    echo "=== Privilege Escalation Monitoring ==="
    
    # Sudo usage
    echo "Recent sudo usage:"
    journalctl -u sudo --since "1 hour ago" | head -10
    echo
    
    # SUID/SGID execution
    echo "SUID/SGID programs executed:"
    ausearch -m avc,user_cmd -ts recent 2>/dev/null | grep -E "(suid|sgid)" | head -5 || \
    echo "No audit events found"
    echo
    
    # New SUID/SGID files
    echo "Checking for new SUID/SGID files:"
    find /usr /bin /sbin -type f \( -perm -4000 -o -perm -2000 \) -newer /var/log/suid_sgid_baseline 2>/dev/null | \
    head -10 || echo "No baseline file found"
}

# Monitor file system changes
monitor_filesystem_changes() {
    echo "=== File System Monitoring ==="
    
    # Critical system files
    echo "Changes to critical system files:"
    find /etc -name "*.conf" -newer /var/log/fs_baseline -type f 2>/dev/null | head -10 || \
    echo "No baseline found"
    echo
    
    # New executable files
    echo "New executable files:"
    find /tmp /var/tmp /home -type f -executable -newer /var/log/exec_baseline 2>/dev/null | \
    head -10 || echo "No new executables found"
    echo
    
    # World-writable files
    echo "World-writable files (potential security risk):"
    find /usr /bin /sbin -type f -perm -002 2>/dev/null | head -5 || \
    echo "No world-writable files found"
}

# Monitor network activity
monitor_network_activity() {
    echo "=== Network Activity Monitoring ==="
    
    # Listening services
    echo "Listening network services:"
    ss -tlnp | awk 'NR>1 {print $1, $4, $7}' | head -10
    echo
    
    # New network connections
    echo "Active network connections:"
    ss -tnp | grep ESTAB | awk '{print $4, $5, $6}' | head -10
    echo
    
    # Check for suspicious network activity
    echo "Checking for suspicious connections:"
    netstat -tan | awk '{print $5}' | grep -E '^[0-9]+\.' | \
    cut -d: -f1 | sort | uniq -c | sort -nr | head -5 | \
    while read count ip; do
        if [ $count -gt 10 ]; then
            echo "High connection count from $ip: $count connections"
        fi
    done
}

# Monitor process activity
monitor_process_activity() {
    echo "=== Process Activity Monitoring ==="
    
    # Processes running as root
    echo "Processes running as root:"
    ps aux | awk '$1=="root" && $11!~/^\[/ {print $2, $11}' | head -10
    echo
    
    # High CPU/Memory processes
    echo "Resource-intensive processes:"
    ps aux --sort=-%cpu | awk 'NR<=6 {print $1, $2, $3, $4, $11}'
    echo
    
    # Processes with unusual names
    echo "Checking for suspicious process names:"
    ps aux | awk '{print $11}' | grep -E '^[^/]' | sort | uniq | \
    while read proc; do
        if [[ $proc =~ ^[0-9]+$ ]] || [[ ${#proc} -eq 1 ]]; then
            echo "Suspicious process name: $proc"
        fi
    done | head -5
}

# Check for rootkits and malware
check_rootkits() {
    echo "=== Rootkit Detection ==="
    
    # Check for common rootkit indicators
    echo "Checking for hidden processes:"
    for pid in /proc/[0-9]*; do
        if [ -d "$pid" ] && ! ps -p "$(basename $pid)" >/dev/null 2>&1; then
            echo "Hidden process found: $(basename $pid)"
        fi
    done | head -5
    
    echo
    echo "Checking for modified system binaries:"
    for binary in /bin/ls /bin/ps /usr/bin/netstat /bin/login; do
        if [ -f "$binary" ]; then
            if file "$binary" | grep -q "dynamically linked"; then
                echo "Binary $binary: OK"
            else
                echo "Binary $binary: SUSPICIOUS (not dynamically linked)"
            fi
        fi
    done
}

# Generate security report
generate_security_report() {
    local output="/tmp/security_report_$(date +%Y%m%d_%H%M%S).txt"
    
    echo "Generating comprehensive security report..."
    
    {
        echo "=== Security Report ==="
        echo "Generated: $(date)"
        echo "Hostname: $(hostname)"
        echo "Kernel: $(uname -r)"
        echo
        
        monitor_auth_events
        monitor_privilege_escalation
        monitor_filesystem_changes
        monitor_network_activity
        monitor_process_activity
        check_rootkits
        
        echo "=== System Hardening Status ==="
        
        # Check firewall status
        echo "Firewall status:"
        systemctl is-active ufw iptables firewalld 2>/dev/null || echo "No firewall active"
        echo
        
        # Check SELinux/AppArmor
        echo "Mandatory Access Control:"
        if command -v getenforce >/dev/null; then
            echo "SELinux: $(getenforce)"
        elif command -v aa-status >/dev/null; then
            echo "AppArmor: $(aa-status --enabled && echo "enabled" || echo "disabled")"
        else
            echo "No MAC system detected"
        fi
        echo
        
        # Check for security updates
        echo "Security updates:"
        if command -v apt >/dev/null; then
            apt list --upgradable 2>/dev/null | grep -i security | wc -l | \
            awk '{print $1 " security updates available"}'
        elif command -v yum >/dev/null; then
            yum --security check-update 2>/dev/null | grep -c "Needed" || echo "0 security updates"
        fi
        
    } > "$output"
    
    echo "Security report saved to: $output"
}

# Real-time security monitoring
realtime_monitoring() {
    echo "=== Real-time Security Monitoring ==="
    echo "Press Ctrl+C to stop"
    echo
    
    # Monitor critical log files
    tail -F /var/log/auth.log /var/log/secure /var/log/audit/audit.log 2>/dev/null | \
    while read line; do
        # Highlight security events
        if echo "$line" | grep -q -E "(Failed|Invalid|Illegal|Attack|Intrusion)"; then
            echo "[ALERT] $line"
        elif echo "$line" | grep -q -E "(Accepted|Opened|Started)"; then
            echo "[INFO] $line"
        fi
    done
}

# Main function
case "${1:-report}" in
    "auth")
        monitor_auth_events
        ;;
    "privesc")
        monitor_privilege_escalation
        ;;
    "filesystem")
        monitor_filesystem_changes
        ;;
    "network")
        monitor_network_activity
        ;;
    "processes")
        monitor_process_activity
        ;;
    "rootkits")
        check_rootkits
        ;;
    "realtime")
        realtime_monitoring
        ;;
    "report")
        generate_security_report
        ;;
    *)
        echo "Usage: $0 {auth|privesc|filesystem|network|processes|rootkits|realtime|report}"
        exit 1
        ;;
esac
```

## Best Practices

1. **Principle of Least Privilege**: Grant minimal necessary permissions
2. **Defense in Depth**: Use multiple security layers
3. **Input Validation**: Validate all external input rigorously
4. **Secure Defaults**: Default to secure configurations
5. **Regular Audits**: Monitor and audit security configurations
6. **Capability-Based Security**: Use capabilities instead of SUID when possible
7. **Namespace Isolation**: Isolate processes using namespaces

## Conclusion

Linux security has evolved into a sophisticated ecosystem of complementary technologies. From capabilities and mandatory access controls to user namespaces and privilege separation, modern Linux provides powerful tools for building secure systems. Understanding these mechanisms—and how to combine them effectively—is essential for developing secure applications and maintaining robust system security.

The techniques covered here provide the foundation for implementing defense-in-depth security strategies, from basic privilege separation to advanced container-like isolation. By mastering these security mechanisms, you can build systems that are resilient against modern threats while maintaining functionality and performance.