---
title: "Linux Directory Permissions Troubleshooting Guide 2025: Complete Path Analysis & Security Auditing"
date: 2025-12-10T10:00:00-05:00
draft: false
tags: ["Linux Permissions", "Directory Permissions", "namei", "File System Security", "Permission Troubleshooting", "Linux Commands", "System Administration", "Access Control", "Security Auditing", "Path Analysis", "chmod", "File Permissions", "Linux Security", "Apache 403 Errors"]
categories:
- Linux
- System Administration
- Security
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Linux directory permissions troubleshooting with comprehensive path analysis tools. Complete guide to namei command, permission debugging, security auditing, Apache 403 fixes, and enterprise access control management."
more_link: "yes"
url: "/linux-directory-permissions-troubleshooting-guide-2025/"
---

Understanding and troubleshooting directory permissions is crucial for Linux system administration, security, and application deployment. This comprehensive guide covers advanced permission analysis tools, security auditing techniques, common permission issues, and enterprise-grade access control management strategies.

<!--more-->

# [Linux File System Permissions Overview](#linux-file-system-permissions-overview)

## Understanding Permission Architecture

### Permission Components
Linux file system permissions consist of three primary components:

- **Owner (User)**: The user who owns the file or directory
- **Group**: The group associated with the file or directory
- **Others**: All other users on the system

### Permission Types
```bash
# Permission bits and their meanings
r (4) - Read permission
w (2) - Write permission
x (1) - Execute permission (or directory access)

# Special permissions
s - SetUID/SetGID bit
t - Sticky bit
```

### Directory vs File Permissions
```bash
# Directory permissions have different implications:
# r - List directory contents (ls)
# w - Create/delete files in directory
# x - Access directory (cd) and files within

# File permissions:
# r - Read file contents
# w - Modify file contents
# x - Execute file as program
```

# [Advanced Permission Analysis with namei](#advanced-permission-analysis-with-namei)

## The namei Command Deep Dive

### Basic namei Usage
```bash
# Display permissions for all directories in a path
namei -m /var/www/html/myapp

# Example output with explanation
f: /var/www/html/myapp      # f: indicates file/directory type
 drwxr-xr-x /               # Root directory permissions
 drwxr-xr-x var             # /var directory permissions
 drwxr-xr-x www             # /var/www directory permissions
 drwxr-xr-x html            # /var/www/html directory permissions
 drwxr-xr-x myapp           # Target directory permissions
```

### Advanced namei Options
```bash
# Show owner and group information
namei -mo /path/to/directory

# Example with owner/group details
f: /var/www/html/myapp
 drwxr-xr-x root     root     /
 drwxr-xr-x root     root     var
 drwxr-xr-x root     root     www
 drwxr-xr-x www-data www-data html
 drwxr-xr-x deploy   deploy   myapp

# Follow symbolic links
namei -ml /path/to/symlink

# Show all information including symlinks
namei -movl /complex/path/with/symlinks

# Vertical display mode (easier to read)
namei -v /path/to/directory
```

### namei for Security Auditing
```bash
#!/bin/bash
# Security audit script using namei

audit_path() {
    local path="$1"
    echo "Security Audit for: $path"
    echo "================================"
    
    # Check if path exists
    if [[ ! -e "$path" ]]; then
        echo "ERROR: Path does not exist"
        return 1
    fi
    
    # Display full permission chain
    namei -movl "$path"
    
    # Check for world-writable directories
    echo -e "\nChecking for security issues..."
    
    namei -m "$path" | while read line; do
        if echo "$line" | grep -q "d.......w."; then
            echo "WARNING: World-writable directory found: $line"
        fi
        
        if echo "$line" | grep -q "777"; then
            echo "CRITICAL: Directory with 777 permissions: $line"
        fi
    done
}

# Audit multiple paths
for path in /var/www /etc/ssl /home /tmp; do
    audit_path "$path"
    echo ""
done
```

# [Comprehensive Permission Troubleshooting](#comprehensive-permission-troubleshooting)

## Apache 403 Forbidden Errors

### Systematic Apache Permission Debugging
```bash
#!/bin/bash
# Apache 403 error troubleshooting script

troubleshoot_apache_403() {
    local document_root="$1"
    local apache_user="${2:-www-data}"
    local apache_group="${3:-www-data}"
    
    echo "Apache 403 Troubleshooting for: $document_root"
    echo "Apache User: $apache_user:$apache_group"
    echo "================================================"
    
    # Step 1: Check document root permissions
    echo -e "\n1. Document Root Permission Chain:"
    namei -movl "$document_root"
    
    # Step 2: Check Apache user access
    echo -e "\n2. Testing Apache User Access:"
    if sudo -u "$apache_user" test -r "$document_root"; then
        echo "✓ Apache user can read directory"
    else
        echo "✗ Apache user CANNOT read directory"
    fi
    
    if sudo -u "$apache_user" test -x "$document_root"; then
        echo "✓ Apache user can access directory"
    else
        echo "✗ Apache user CANNOT access directory"
    fi
    
    # Step 3: Check parent directory execute permissions
    echo -e "\n3. Parent Directory Execute Permissions:"
    local current_path=""
    IFS='/' read -ra PARTS <<< "$document_root"
    
    for part in "${PARTS[@]}"; do
        if [[ -n "$part" ]]; then
            current_path="$current_path/$part"
            local perms=$(stat -c "%a" "$current_path" 2>/dev/null)
            local owner=$(stat -c "%U:%G" "$current_path" 2>/dev/null)
            echo "$current_path - $perms ($owner)"
            
            # Check if apache user can traverse
            if ! sudo -u "$apache_user" test -x "$current_path" 2>/dev/null; then
                echo "  ✗ Apache cannot traverse this directory!"
            fi
        fi
    done
    
    # Step 4: SELinux context check
    if command -v getenforce >/dev/null 2>&1 && [[ $(getenforce) != "Disabled" ]]; then
        echo -e "\n4. SELinux Context:"
        ls -Z "$document_root" 2>/dev/null || echo "SELinux labels not available"
        
        # Check for correct httpd context
        if ! ls -Z "$document_root" 2>/dev/null | grep -q "httpd_sys_content_t"; then
            echo "WARNING: Incorrect SELinux context. Fix with:"
            echo "sudo semanage fcontext -a -t httpd_sys_content_t '$document_root(/.*)?'"
            echo "sudo restorecon -Rv '$document_root'"
        fi
    fi
    
    # Step 5: Check .htaccess files
    echo -e "\n5. Checking for .htaccess restrictions:"
    find "$document_root" -name ".htaccess" -type f 2>/dev/null | while read htaccess; do
        echo "Found: $htaccess"
        if grep -q "Deny from all\|Require all denied" "$htaccess"; then
            echo "  WARNING: Contains deny rules"
        fi
    done
    
    # Step 6: Recommended fixes
    echo -e "\n6. Recommended Permission Structure:"
    echo "sudo find '$document_root' -type d -exec chmod 755 {} +"
    echo "sudo find '$document_root' -type f -exec chmod 644 {} +"
    echo "sudo chown -R $apache_user:$apache_group '$document_root'"
}

# Example usage
troubleshoot_apache_403 "/var/www/html/mysite"
```

### Nginx Permission Troubleshooting
```bash
#!/bin/bash
# Nginx permission troubleshooting

troubleshoot_nginx_permissions() {
    local root_path="$1"
    local nginx_user="${2:-nginx}"
    
    echo "Nginx Permission Troubleshooting"
    echo "================================"
    
    # Check nginx user
    if ! id "$nginx_user" >/dev/null 2>&1; then
        nginx_user="www-data"  # Try common alternative
    fi
    
    echo "Nginx user: $nginx_user"
    echo "Document root: $root_path"
    
    # Check full path permissions
    echo -e "\n1. Full Path Analysis:"
    namei -movl "$root_path"
    
    # Test nginx user access
    echo -e "\n2. Nginx User Access Test:"
    
    # Create test script for nginx user
    cat > /tmp/nginx_access_test.sh << 'EOF'
#!/bin/bash
path="$1"
echo "Testing access to: $path"

# Test read access
if test -r "$path"; then
    echo "✓ Can read directory"
else
    echo "✗ Cannot read directory"
fi

# Test execute access
if test -x "$path"; then
    echo "✓ Can access directory"
else
    echo "✗ Cannot access directory"
fi

# Try to list directory
if ls "$path" >/dev/null 2>&1; then
    echo "✓ Can list directory contents"
else
    echo "✗ Cannot list directory contents"
fi
EOF
    
    chmod +x /tmp/nginx_access_test.sh
    sudo -u "$nginx_user" /tmp/nginx_access_test.sh "$root_path"
    rm -f /tmp/nginx_access_test.sh
    
    # Check for common issues
    echo -e "\n3. Common Issue Detection:"
    
    # Check for socket permissions
    if [[ -S /var/run/php/php-fpm.sock ]]; then
        echo "PHP-FPM Socket permissions:"
        ls -l /var/run/php/php-fpm.sock
    fi
    
    # Check static file permissions
    echo -e "\n4. Static File Permission Check:"
    find "$root_path" -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" \) -ls 2>/dev/null | head -5
}
```

## Application-Specific Permission Issues

### Database Directory Permissions
```bash
#!/bin/bash
# Database permission troubleshooting

check_mysql_permissions() {
    local mysql_user="mysql"
    local mysql_datadir="/var/lib/mysql"
    
    echo "MySQL Permission Check"
    echo "====================="
    
    # Check data directory
    echo "Data directory permissions:"
    namei -movl "$mysql_datadir"
    
    # Check ownership
    echo -e "\nOwnership check:"
    ls -la "$mysql_datadir" | head -5
    
    # Check if mysql user can access
    if sudo -u "$mysql_user" test -r "$mysql_datadir"; then
        echo "✓ MySQL user can read data directory"
    else
        echo "✗ MySQL user cannot read data directory"
    fi
    
    # Check socket directory
    local socket_dir="/var/run/mysqld"
    if [[ -d "$socket_dir" ]]; then
        echo -e "\nSocket directory permissions:"
        ls -la "$socket_dir"
    fi
    
    # Recommended fixes
    echo -e "\nRecommended permissions:"
    echo "sudo chown -R mysql:mysql $mysql_datadir"
    echo "sudo chmod 750 $mysql_datadir"
    echo "sudo find $mysql_datadir -type d -exec chmod 750 {} +"
    echo "sudo find $mysql_datadir -type f -exec chmod 640 {} +"
}

check_postgresql_permissions() {
    local postgres_user="postgres"
    local postgres_datadir="/var/lib/postgresql"
    
    echo "PostgreSQL Permission Check"
    echo "==========================="
    
    # Check data directory structure
    echo "Data directory structure:"
    find "$postgres_datadir" -maxdepth 2 -type d -ls 2>/dev/null
    
    # Check critical directories
    for dir in "$postgres_datadir" "$postgres_datadir/12/main" "/var/run/postgresql"; do
        if [[ -d "$dir" ]]; then
            echo -e "\nChecking: $dir"
            namei -mo "$dir" | tail -3
        fi
    done
    
    # Socket permissions
    echo -e "\nSocket permissions:"
    ls -la /var/run/postgresql/.s.PGSQL.* 2>/dev/null || echo "No sockets found"
}
```

# [Advanced Permission Analysis Tools](#advanced-permission-analysis-tools)

## Comprehensive Permission Scanner

```bash
#!/bin/bash
# Advanced permission scanning and analysis tool

# Color codes for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Permission analysis function
analyze_permissions() {
    local target_path="$1"
    local report_file="${2:-permission_report.txt}"
    
    echo "Permission Analysis Report" | tee "$report_file"
    echo "=========================" | tee -a "$report_file"
    echo "Target: $target_path" | tee -a "$report_file"
    echo "Date: $(date)" | tee -a "$report_file"
    echo "" | tee -a "$report_file"
    
    # Section 1: Path Permission Chain
    echo "1. Complete Path Permission Chain:" | tee -a "$report_file"
    echo "-----------------------------------" | tee -a "$report_file"
    namei -movl "$target_path" | tee -a "$report_file"
    echo "" | tee -a "$report_file"
    
    # Section 2: Permission Statistics
    echo "2. Permission Statistics:" | tee -a "$report_file"
    echo "------------------------" | tee -a "$report_file"
    
    # Count different permission types
    local perm_stats=$(find "$target_path" -type f -o -type d 2>/dev/null | xargs stat -c "%a" 2>/dev/null | sort | uniq -c | sort -rn)
    echo "$perm_stats" | tee -a "$report_file"
    echo "" | tee -a "$report_file"
    
    # Section 3: Ownership Analysis
    echo "3. Ownership Distribution:" | tee -a "$report_file"
    echo "--------------------------" | tee -a "$report_file"
    
    find "$target_path" -printf "%u:%g\n" 2>/dev/null | sort | uniq -c | sort -rn | head -20 | tee -a "$report_file"
    echo "" | tee -a "$report_file"
    
    # Section 4: Security Issues
    echo "4. Security Issue Detection:" | tee -a "$report_file"
    echo "----------------------------" | tee -a "$report_file"
    
    # World-writable files
    echo -e "${YELLOW}World-writable files:${NC}" | tee -a "$report_file"
    find "$target_path" -type f -perm -002 2>/dev/null | head -20 | tee -a "$report_file"
    
    # World-writable directories
    echo -e "\n${YELLOW}World-writable directories:${NC}" | tee -a "$report_file"
    find "$target_path" -type d -perm -002 2>/dev/null | head -20 | tee -a "$report_file"
    
    # Files with SUID bit
    echo -e "\n${RED}SUID files:${NC}" | tee -a "$report_file"
    find "$target_path" -type f -perm -4000 2>/dev/null | tee -a "$report_file"
    
    # Files with SGID bit
    echo -e "\n${RED}SGID files:${NC}" | tee -a "$report_file"
    find "$target_path" -type f -perm -2000 2>/dev/null | tee -a "$report_file"
    
    # Directories with sticky bit
    echo -e "\n${GREEN}Sticky bit directories:${NC}" | tee -a "$report_file"
    find "$target_path" -type d -perm -1000 2>/dev/null | tee -a "$report_file"
    
    echo "" | tee -a "$report_file"
    
    # Section 5: Inconsistencies
    echo "5. Permission Inconsistencies:" | tee -a "$report_file"
    echo "------------------------------" | tee -a "$report_file"
    
    # Files not readable by owner
    echo "Files not readable by owner:" | tee -a "$report_file"
    find "$target_path" -type f ! -perm -400 2>/dev/null | head -10 | tee -a "$report_file"
    
    # Executable files without read permission
    echo -e "\nExecutable files without read permission:" | tee -a "$report_file"
    find "$target_path" -type f -perm -100 ! -perm -400 2>/dev/null | head -10 | tee -a "$report_file"
}

# Interactive permission checker
interactive_permission_check() {
    local path="$1"
    
    echo "Interactive Permission Checker"
    echo "=============================="
    echo "Path: $path"
    echo ""
    
    # Get current user info
    echo "Current user: $(whoami) (UID: $(id -u), GID: $(id -g))"
    echo "Groups: $(groups)"
    echo ""
    
    # Check access for current user
    echo "Access check for current user:"
    
    if [[ -r "$path" ]]; then
        echo "✓ Read: YES"
    else
        echo "✗ Read: NO"
    fi
    
    if [[ -w "$path" ]]; then
        echo "✓ Write: YES"
    else
        echo "✗ Write: NO"
    fi
    
    if [[ -x "$path" ]]; then
        echo "✓ Execute/Access: YES"
    else
        echo "✗ Execute/Access: NO"
    fi
    
    # Explain why access is granted/denied
    echo -e "\nPermission Analysis:"
    
    local stat_info=$(stat -c "%a %U %G" "$path")
    local perms=$(echo "$stat_info" | cut -d' ' -f1)
    local owner=$(echo "$stat_info" | cut -d' ' -f2)
    local group=$(echo "$stat_info" | cut -d' ' -f3)
    
    echo "Permissions: $perms"
    echo "Owner: $owner"
    echo "Group: $group"
    
    # Determine access reason
    if [[ "$(whoami)" == "$owner" ]]; then
        echo "→ You have OWNER permissions"
        analyze_permission_bits "${perms:0:1}" "owner"
    elif groups | grep -q "\b$group\b"; then
        echo "→ You have GROUP permissions"
        analyze_permission_bits "${perms:1:1}" "group"
    else
        echo "→ You have OTHER permissions"
        analyze_permission_bits "${perms:2:1}" "other"
    fi
}

analyze_permission_bits() {
    local perm_digit="$1"
    local perm_type="$2"
    
    local read=$((perm_digit & 4))
    local write=$((perm_digit & 2))
    local exec=$((perm_digit & 1))
    
    echo "Permission breakdown for $perm_type:"
    echo "  Read (4): $([[ $read -ne 0 ]] && echo "YES" || echo "NO")"
    echo "  Write (2): $([[ $write -ne 0 ]] && echo "YES" || echo "NO")"
    echo "  Execute (1): $([[ $exec -ne 0 ]] && echo "YES" || echo "NO")"
}
```

## Automated Permission Fixing

```bash
#!/bin/bash
# Intelligent permission fixing script

fix_web_permissions() {
    local web_root="$1"
    local web_user="${2:-www-data}"
    local web_group="${3:-www-data}"
    local dry_run="${4:-false}"
    
    echo "Web Permission Fixer"
    echo "===================="
    echo "Root: $web_root"
    echo "User: $web_user:$web_group"
    echo "Dry run: $dry_run"
    echo ""
    
    # Define permission policies
    declare -A dir_perms=(
        ["default"]="755"
        ["uploads"]="775"
        ["cache"]="775"
        ["logs"]="775"
        ["private"]="750"
    )
    
    declare -A file_perms=(
        ["default"]="644"
        ["*.sh"]="755"
        ["*.pl"]="755"
        ["*.py"]="755"
        ["*.cgi"]="755"
        [".htaccess"]="644"
        ["wp-config.php"]="640"
        ["config.php"]="640"
    )
    
    # Function to execute or simulate commands
    execute_cmd() {
        local cmd="$1"
        if [[ "$dry_run" == "true" ]]; then
            echo "[DRY RUN] $cmd"
        else
            echo "[EXECUTE] $cmd"
            eval "$cmd"
        fi
    }
    
    # Fix ownership
    echo "1. Fixing ownership..."
    execute_cmd "chown -R $web_user:$web_group '$web_root'"
    
    # Fix directory permissions
    echo -e "\n2. Fixing directory permissions..."
    
    # Default directory permissions
    execute_cmd "find '$web_root' -type d -exec chmod ${dir_perms[default]} {} +"
    
    # Special directory permissions
    for dir_pattern in "${!dir_perms[@]}"; do
        if [[ "$dir_pattern" != "default" ]]; then
            execute_cmd "find '$web_root' -type d -name '$dir_pattern' -exec chmod ${dir_perms[$dir_pattern]} {} +"
        fi
    done
    
    # Fix file permissions
    echo -e "\n3. Fixing file permissions..."
    
    # Default file permissions
    execute_cmd "find '$web_root' -type f -exec chmod ${file_perms[default]} {} +"
    
    # Special file permissions
    for file_pattern in "${!file_perms[@]}"; do
        if [[ "$file_pattern" != "default" ]]; then
            execute_cmd "find '$web_root' -type f -name '$file_pattern' -exec chmod ${file_perms[$file_pattern]} {} +"
        fi
    done
    
    # Fix SELinux contexts if applicable
    if command -v getenforce >/dev/null 2>&1 && [[ $(getenforce) != "Disabled" ]]; then
        echo -e "\n4. Fixing SELinux contexts..."
        execute_cmd "restorecon -Rv '$web_root'"
    fi
    
    # Verify fixes
    if [[ "$dry_run" == "false" ]]; then
        echo -e "\n5. Verification:"
        echo "Sample directory permissions:"
        find "$web_root" -type d -ls 2>/dev/null | head -5
        
        echo -e "\nSample file permissions:"
        find "$web_root" -type f -ls 2>/dev/null | head -5
    fi
}

# Recursive permission inheritance fixer
fix_permission_inheritance() {
    local base_path="$1"
    local inherit_from_parent="${2:-true}"
    
    echo "Permission Inheritance Fixer"
    echo "============================"
    
    if [[ "$inherit_from_parent" == "true" ]]; then
        # Get parent directory permissions
        local parent_dir=$(dirname "$base_path")
        local parent_perms=$(stat -c "%a" "$parent_dir")
        local parent_owner=$(stat -c "%U:%G" "$parent_dir")
        
        echo "Parent directory: $parent_dir"
        echo "Parent permissions: $parent_perms"
        echo "Parent ownership: $parent_owner"
        
        echo -e "\nApplying parent permissions to all subdirectories..."
        find "$base_path" -type d -exec chmod "$parent_perms" {} +
        find "$base_path" -type d -exec chown "$parent_owner" {} +
    else
        # Apply uniform permissions
        echo "Applying uniform permission structure..."
        
        # Directories: 755
        find "$base_path" -type d -exec chmod 755 {} +
        
        # Files: 644
        find "$base_path" -type f -exec chmod 644 {} +
        
        # Executables: 755
        find "$base_path" -type f \( -name "*.sh" -o -name "*.pl" -o -name "*.py" \) -exec chmod 755 {} +
    fi
}
```

# [Enterprise Permission Management](#enterprise-permission-management)

## ACL (Access Control Lists) Management

```bash
#!/bin/bash
# Advanced ACL management for fine-grained permissions

# Check ACL support
check_acl_support() {
    local test_file="/tmp/acl_test_$$"
    touch "$test_file"
    
    if setfacl -m u:nobody:r "$test_file" 2>/dev/null; then
        echo "✓ ACL support is enabled"
        setfacl -b "$test_file"  # Remove ACL
        rm -f "$test_file"
        return 0
    else
        echo "✗ ACL support is not available"
        echo "Install with: sudo apt-get install acl"
        rm -f "$test_file"
        return 1
    fi
}

# Set default ACLs for a directory
set_default_acls() {
    local directory="$1"
    local owner="$2"
    local group="$3"
    local web_user="${4:-www-data}"
    
    echo "Setting default ACLs for: $directory"
    
    # Set default ACLs for new files
    setfacl -R -m d:u:"$owner":rwx "$directory"
    setfacl -R -m d:g:"$group":rwx "$directory"
    setfacl -R -m d:u:"$web_user":rx "$directory"
    setfacl -R -m d:o::r "$directory"
    
    # Set ACLs for existing files
    setfacl -R -m u:"$owner":rwx "$directory"
    setfacl -R -m g:"$group":rwx "$directory"
    setfacl -R -m u:"$web_user":rx "$directory"
    setfacl -R -m o::r "$directory"
    
    # Display ACLs
    echo -e "\nCurrent ACLs:"
    getfacl "$directory" | grep -v "^#"
}

# Complex ACL scenario management
manage_project_acls() {
    local project_dir="$1"
    local developers=("dev1" "dev2" "dev3")
    local readonly_users=("auditor" "monitor")
    local admin_users=("admin" "devops")
    
    echo "Setting up project ACLs for: $project_dir"
    
    # Create directory structure if needed
    mkdir -p "$project_dir"/{src,docs,config,logs,data}
    
    # Set base permissions
    chmod 750 "$project_dir"
    chown root:developers "$project_dir"
    
    # Admin users - full access
    for user in "${admin_users[@]}"; do
        setfacl -R -m u:"$user":rwx "$project_dir"
        setfacl -R -m d:u:"$user":rwx "$project_dir"
    done
    
    # Developers - read/write to most directories
    for user in "${developers[@]}"; do
        setfacl -R -m u:"$user":rwx "$project_dir/src"
        setfacl -R -m u:"$user":rwx "$project_dir/docs"
        setfacl -R -m u:"$user":r-x "$project_dir/config"
        setfacl -R -m u:"$user":rwx "$project_dir/data"
        
        # Set defaults for new files
        setfacl -R -m d:u:"$user":rwx "$project_dir/src"
        setfacl -R -m d:u:"$user":rwx "$project_dir/docs"
        setfacl -R -m d:u:"$user":r-x "$project_dir/config"
        setfacl -R -m d:u:"$user":rwx "$project_dir/data"
    done
    
    # Read-only users
    for user in "${readonly_users[@]}"; do
        setfacl -R -m u:"$user":r-x "$project_dir"
        setfacl -R -m d:u:"$user":r-x "$project_dir"
        
        # No access to logs
        setfacl -R -m u:"$user":--- "$project_dir/logs"
    done
    
    # Web server user - read access to specific directories
    setfacl -R -m u:www-data:r-x "$project_dir/src"
    setfacl -R -m d:u:www-data:r-x "$project_dir/src"
    
    # Display ACL summary
    echo -e "\nACL Summary:"
    for dir in "$project_dir"/{src,docs,config,logs,data}; do
        echo -e "\n$dir:"
        getfacl "$dir" 2>/dev/null | grep -E "^(user|group|other)" | sort -u
    done
}

# ACL backup and restore
backup_acls() {
    local source_dir="$1"
    local backup_file="${2:-acl_backup_$(date +%Y%m%d_%H%M%S).txt}"
    
    echo "Backing up ACLs from: $source_dir"
    echo "Backup file: $backup_file"
    
    # Backup ACLs recursively
    getfacl -R "$source_dir" > "$backup_file"
    
    # Compress backup
    gzip "$backup_file"
    
    echo "✓ ACL backup completed: ${backup_file}.gz"
}

restore_acls() {
    local backup_file="$1"
    local target_dir="${2:-.}"
    
    echo "Restoring ACLs from: $backup_file"
    echo "Target directory: $target_dir"
    
    # Decompress if needed
    if [[ "$backup_file" == *.gz ]]; then
        gunzip -c "$backup_file" | setfacl --restore=-
    else
        setfacl --restore="$backup_file"
    fi
    
    echo "✓ ACL restore completed"
}
```

## Permission Monitoring and Alerting

```bash
#!/bin/bash
# Real-time permission monitoring system

# Permission change monitor
monitor_permission_changes() {
    local watch_dir="$1"
    local log_file="${2:-/var/log/permission_monitor.log}"
    local alert_email="${3:-admin@example.com}"
    
    echo "Starting permission monitor for: $watch_dir"
    echo "Log file: $log_file"
    
    # Initialize baseline
    local baseline_file="/tmp/permission_baseline_$$.txt"
    find "$watch_dir" -printf "%m %u %g %p\n" 2>/dev/null | sort > "$baseline_file"
    
    # Monitor loop
    while true; do
        sleep 60  # Check every minute
        
        # Current state
        local current_file="/tmp/permission_current_$$.txt"
        find "$watch_dir" -printf "%m %u %g %p\n" 2>/dev/null | sort > "$current_file"
        
        # Compare with baseline
        local changes=$(diff "$baseline_file" "$current_file" 2>/dev/null)
        
        if [[ -n "$changes" ]]; then
            local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
            echo "[$timestamp] Permission changes detected:" | tee -a "$log_file"
            echo "$changes" | tee -a "$log_file"
            
            # Send alert
            if [[ -n "$alert_email" ]] && command -v mail >/dev/null 2>&1; then
                echo "$changes" | mail -s "Permission Change Alert: $watch_dir" "$alert_email"
            fi
            
            # Update baseline
            mv "$current_file" "$baseline_file"
        else
            rm -f "$current_file"
        fi
    done
}

# Periodic permission audit
scheduled_permission_audit() {
    local audit_dirs=("/etc" "/var/www" "/home" "/opt")
    local report_dir="/var/log/permission_audits"
    
    mkdir -p "$report_dir"
    
    local report_file="$report_dir/audit_$(date +%Y%m%d_%H%M%S).txt"
    
    echo "Permission Audit Report" > "$report_file"
    echo "======================" >> "$report_file"
    echo "Date: $(date)" >> "$report_file"
    echo "" >> "$report_file"
    
    for dir in "${audit_dirs[@]}"; do
        if [[ -d "$dir" ]]; then
            echo "Auditing: $dir" >> "$report_file"
            echo "-------------------" >> "$report_file"
            
            # Find permission anomalies
            echo "World-writable files:" >> "$report_file"
            find "$dir" -type f -perm -002 2>/dev/null | head -20 >> "$report_file"
            
            echo -e "\nSUID/SGID files:" >> "$report_file"
            find "$dir" -type f \( -perm -4000 -o -perm -2000 \) 2>/dev/null >> "$report_file"
            
            echo -e "\nUnowned files:" >> "$report_file"
            find "$dir" -nouser -o -nogroup 2>/dev/null | head -20 >> "$report_file"
            
            echo -e "\n" >> "$report_file"
        fi
    done
    
    echo "Audit report saved: $report_file"
    
    # Compress old reports
    find "$report_dir" -name "audit_*.txt" -mtime +30 -exec gzip {} \;
    
    # Delete very old reports
    find "$report_dir" -name "audit_*.txt.gz" -mtime +365 -delete
}
```

# [Troubleshooting Common Scenarios](#troubleshooting-common-scenarios)

## Multi-User Development Environment

```bash
#!/bin/bash
# Setup secure multi-user development environment

setup_shared_development() {
    local project_name="$1"
    local project_root="/var/projects/$project_name"
    local dev_group="${project_name}_dev"
    
    echo "Setting up shared development environment: $project_name"
    
    # Create project structure
    mkdir -p "$project_root"/{src,docs,tests,build,deploy}
    
    # Create development group
    groupadd "$dev_group" 2>/dev/null || echo "Group $dev_group already exists"
    
    # Set base permissions
    chown -R root:"$dev_group" "$project_root"
    chmod 2775 "$project_root"  # SGID for group inheritance
    
    # Configure directory permissions
    find "$project_root" -type d -exec chmod 2775 {} +
    
    # Set default ACLs for group collaboration
    setfacl -R -m d:g:"$dev_group":rwx "$project_root"
    setfacl -R -m d:o::r-x "$project_root"
    
    # Create git hooks for permission maintenance
    if [[ -d "$project_root/.git" ]]; then
        cat > "$project_root/.git/hooks/post-checkout" << 'EOF'
#!/bin/bash
# Fix permissions after git operations
find . -type d -exec chmod 2775 {} +
find . -type f -exec chmod 664 {} +
find . -name "*.sh" -exec chmod 775 {} +
EOF
        chmod +x "$project_root/.git/hooks/post-checkout"
    fi
    
    echo "✓ Development environment configured"
    echo "Add users to group with: sudo usermod -a -G $dev_group username"
}
```

## Container Volume Permissions

```bash
#!/bin/bash
# Fix container volume permission issues

fix_docker_volume_permissions() {
    local volume_path="$1"
    local container_uid="${2:-1000}"
    local container_gid="${3:-1000}"
    
    echo "Fixing Docker volume permissions"
    echo "Volume: $volume_path"
    echo "Container UID:GID = $container_uid:$container_gid"
    
    # Create user/group if they don't exist
    if ! getent passwd "$container_uid" >/dev/null; then
        useradd -u "$container_uid" -s /bin/false -d /nonexistent -c "Container User" container_user
    fi
    
    if ! getent group "$container_gid" >/dev/null; then
        groupadd -g "$container_gid" container_group
    fi
    
    # Fix ownership
    chown -R "$container_uid:$container_gid" "$volume_path"
    
    # Set appropriate permissions
    find "$volume_path" -type d -exec chmod 755 {} +
    find "$volume_path" -type f -exec chmod 644 {} +
    
    # Handle special cases
    find "$volume_path" -name "*.sh" -exec chmod 755 {} +
    
    echo "✓ Volume permissions fixed"
}
```

This comprehensive guide provides enterprise-level knowledge for troubleshooting and managing Linux directory permissions, covering everything from basic analysis to advanced ACL management and automated monitoring systems.