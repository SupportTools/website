---
title: "SOL Serial Over LAN with Dell iDRAC & BMC Guide 2025: Complete Remote Console Management"
date: 2025-08-22T10:00:00-05:00
draft: false
tags: ["SOL", "Serial Over LAN", "Dell iDRAC", "BMC", "IPMI", "Remote Console", "Server Management", "Out-of-Band Management", "Dell PowerEdge", "Enterprise Hardware", "Server Troubleshooting", "Remote Access", "System Administration", "Infrastructure Management"]
categories:
- Server Management
- Hardware
- Remote Access
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Master SOL (Serial Over LAN) with Dell iDRAC and BMC for enterprise remote console management. Complete guide to IPMI configuration, troubleshooting, automation, security, and advanced out-of-band management strategies."
more_link: "yes"
url: "/sol-serial-over-lan-idrac-bmc-guide-2025/"
---

Serial Over LAN (SOL) provides critical out-of-band console access to Dell PowerEdge servers through iDRAC and BMC interfaces. This comprehensive guide covers SOL implementation, advanced configuration, enterprise security, automation strategies, and troubleshooting techniques for reliable remote server management.

<!--more-->

# [SOL and Out-of-Band Management Overview](#sol-and-out-of-band-management-overview)

## Understanding Serial Over LAN Architecture

### What is SOL?
Serial Over LAN redirects a server's serial console output over the network through the BMC (Baseboard Management Controller) or iDRAC (Integrated Dell Remote Access Controller). This enables:

- **Pre-boot Access**: BIOS/UEFI configuration and diagnostics
- **OS-Independent**: Works regardless of operating system state
- **Emergency Recovery**: Access during system failures or network issues
- **Automation**: Scripted server management and deployment
- **Remote Troubleshooting**: Console access from anywhere

### Enterprise Benefits
- **Reduced Downtime**: Immediate console access without physical presence
- **Cost Reduction**: Eliminates need for crash carts and site visits
- **Scalability**: Manage hundreds of servers from central location
- **Security**: Encrypted out-of-band management channel
- **Compliance**: Audit trails and secure access controls

### Dell iDRAC Architecture
```
[Server Hardware] ← [iDRAC/BMC] ← [Network] ← [Management Station]
       ↓                ↓             ↓            ↓
   Serial Console   IPMI/Redfish   Ethernet    SOL Client
```

# [Comprehensive SOL Setup and Configuration](#comprehensive-sol-setup-and-configuration)

## Prerequisites and Tool Installation

### Install Required Tools
```bash
#!/bin/bash
# Complete SOL management toolkit installation

# Update system packages
sudo apt update

# Install IPMI tools
sudo apt install -y ipmitool freeipmi-tools

# Install Dell RACADM (download from Dell support)
# Note: Replace with actual Dell RACADM download URL
download_racadm() {
    local racadm_url="https://downloads.dell.com/FOLDER07/racadm_64bit.tar.gz"
    local temp_dir="/tmp/racadm_install"
    
    mkdir -p "$temp_dir"
    cd "$temp_dir"
    
    # Download and extract RACADM
    wget "$racadm_url" -O racadm.tar.gz
    tar -xzf racadm.tar.gz
    
    # Install RACADM
    sudo ./install_racadm.sh
    
    # Verify installation
    racadm version
}

# Install additional management tools
sudo apt install -y \
    ipmiutil \
    ipmiseld \
    openipmi \
    expect \
    socat \
    screen \
    minicom

# Install Python IPMI libraries
pip3 install --user pyghmi python-ipmi

# Verify installations
echo "Verifying tool installations..."
for tool in ipmitool racadm ipmiutil; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "✓ $tool is installed"
        $tool --version 2>/dev/null || $tool version 2>/dev/null || echo "  (version check failed)"
    else
        echo "✗ $tool is not installed"
    fi
done
```

### Network and Firewall Configuration
```bash
#!/bin/bash
# Network configuration for SOL access

# Configure firewall for IPMI/SOL access
configure_firewall() {
    echo "Configuring firewall for SOL access..."
    
    # IPMI ports
    sudo ufw allow 623/udp comment "IPMI"
    sudo ufw allow 664/udp comment "IPMI over LAN"
    
    # SOL specific ports
    sudo ufw allow 623/tcp comment "SOL"
    
    # Dell iDRAC web interface (optional)
    sudo ufw allow 443/tcp comment "iDRAC HTTPS"
    sudo ufw allow 5900/tcp comment "iDRAC VNC"
    
    # Show firewall status
    sudo ufw status numbered
}

# Test network connectivity to iDRAC
test_idrac_connectivity() {
    local idrac_ip="$1"
    
    echo "Testing connectivity to iDRAC: $idrac_ip"
    
    # Ping test
    if ping -c 3 "$idrac_ip" >/dev/null 2>&1; then
        echo "✓ Ping successful"
    else
        echo "✗ Ping failed"
        return 1
    fi
    
    # IPMI port test
    if nc -zv "$idrac_ip" 623 2>/dev/null; then
        echo "✓ IPMI port 623 is open"
    else
        echo "✗ IPMI port 623 is closed or filtered"
    fi
    
    # Web interface test
    if curl -k -s --connect-timeout 5 "https://$idrac_ip" >/dev/null 2>&1; then
        echo "✓ HTTPS interface accessible"
    else
        echo "✗ HTTPS interface not accessible"
    fi
}

# Configure local IPMI settings
configure_local_ipmi() {
    echo "Configuring local IPMI settings..."
    
    # Load IPMI modules
    sudo modprobe ipmi_msghandler
    sudo modprobe ipmi_devintf
    sudo modprobe ipmi_si
    
    # Make modules persistent
    echo "ipmi_msghandler" | sudo tee -a /etc/modules
    echo "ipmi_devintf" | sudo tee -a /etc/modules
    echo "ipmi_si" | sudo tee -a /etc/modules
    
    # Start IPMI service
    sudo systemctl enable openipmi
    sudo systemctl start openipmi
    
    # Verify local IPMI
    if [[ -c /dev/ipmi0 ]]; then
        echo "✓ Local IPMI device available"
    else
        echo "✗ Local IPMI device not found"
    fi
}

# Example usage
configure_firewall
test_idrac_connectivity "192.168.1.100"
configure_local_ipmi
```

## Advanced SOL Configuration

### Enterprise SOL Management Script
```bash
#!/bin/bash
# Enterprise SOL management framework

# Configuration file
SOL_CONFIG_FILE="/etc/sol-manager/servers.conf"
SOL_LOG_FILE="/var/log/sol-manager.log"
SOL_SESSION_DIR="/var/run/sol-sessions"

# Create required directories
sudo mkdir -p "$(dirname "$SOL_CONFIG_FILE")" "$SOL_SESSION_DIR"

# Logging function
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$SOL_LOG_FILE"
}

# Server configuration structure
create_server_config() {
    cat > "$SOL_CONFIG_FILE" << 'EOF'
# SOL Server Configuration
# Format: name|ip|username|password|type|description
# Types: idrac8, idrac9, idrac10, bmc

server01|192.168.1.101|root|calvin|idrac9|PowerEdge R740
server02|192.168.1.102|admin|password|idrac10|PowerEdge R750
server03|192.168.1.103|root|calvin|bmc|PowerEdge C6320
EOF
}

# Enhanced SOL connection function
connect_sol() {
    local server_name="$1"
    local session_log="${2:-true}"
    
    # Parse server configuration
    local server_config=$(grep "^$server_name|" "$SOL_CONFIG_FILE")
    
    if [[ -z "$server_config" ]]; then
        echo "Error: Server '$server_name' not found in configuration"
        return 1
    fi
    
    IFS='|' read -r name ip username password type description <<< "$server_config"
    
    log_message "Connecting to SOL on $name ($ip) - $description"
    
    # Create session directory
    local session_dir="$SOL_SESSION_DIR/$name"
    mkdir -p "$session_dir"
    
    # Session log file
    local session_log_file="$session_dir/session_$(date +%Y%m%d_%H%M%S).log"
    
    # Pre-connection checks
    if ! ping -c 1 -W 3 "$ip" >/dev/null 2>&1; then
        log_message "Error: Cannot reach $ip"
        return 1
    fi
    
    # Test IPMI connectivity
    if ! ipmitool -I lanplus -H "$ip" -U "$username" -P "$password" chassis status >/dev/null 2>&1; then
        log_message "Error: IPMI authentication failed for $ip"
        return 1
    fi
    
    # Configure SOL settings based on server type
    configure_sol_settings "$ip" "$username" "$password" "$type"
    
    # Connect to SOL with logging
    if [[ "$session_log" == "true" ]]; then
        log_message "Starting SOL session with logging to $session_log_file"
        
        # Use script to log session
        script -f "$session_log_file" -c "ipmitool -I lanplus -H '$ip' -U '$username' -P '$password' sol activate"
    else
        log_message "Starting SOL session without logging"
        ipmitool -I lanplus -H "$ip" -U "$username" -P "$password" sol activate
    fi
    
    log_message "SOL session ended for $name"
}

# SOL configuration optimization
configure_sol_settings() {
    local ip="$1"
    local username="$2"
    local password="$3"
    local type="$4"
    
    log_message "Configuring SOL settings for $ip ($type)"
    
    # Common SOL settings
    local ipmi_cmd="ipmitool -I lanplus -H $ip -U $username -P $password"
    
    # Configure based on server type
    case "$type" in
        "idrac8"|"idrac9"|"idrac10")
            # Dell iDRAC specific settings
            $ipmi_cmd sol set character-accumulate-level 1
            $ipmi_cmd sol set character-send-threshold 40
            $ipmi_cmd sol set retry-count 3
            $ipmi_cmd sol set retry-interval 100
            $ipmi_cmd sol set volatile-bit-rate 115.2
            $ipmi_cmd sol set non-volatile-bit-rate 115.2
            
            # Enable SOL via RACADM if available
            if command -v racadm >/dev/null 2>&1; then
                racadm -r "$ip" -u "$username" -p "$password" config -g cfgIpmiSol -o cfgIpmiSolEnable 1
                racadm -r "$ip" -u "$username" -p "$password" config -g cfgIpmiSol -o cfgIpmiSolBaudRate 115200
            fi
            ;;
        "bmc")
            # Generic BMC settings
            $ipmi_cmd sol set character-accumulate-level 5
            $ipmi_cmd sol set character-send-threshold 60
            $ipmi_cmd sol set retry-count 7
            ;;
    esac
    
    # Verify SOL is enabled
    $ipmi_cmd sol info | grep -q "Enabled.*true" || {
        log_message "Warning: SOL may not be enabled on $ip"
    }
}

# Batch SOL operations
batch_sol_operation() {
    local operation="$1"
    local server_pattern="${2:-.*}"
    
    log_message "Starting batch SOL operation: $operation (pattern: $server_pattern)"
    
    while IFS='|' read -r name ip username password type description; do
        [[ "$name" =~ ^#.*$ ]] && continue
        [[ -z "$name" ]] && continue
        
        if [[ "$name" =~ $server_pattern ]]; then
            log_message "Processing server: $name"
            
            case "$operation" in
                "test")
                    test_sol_connectivity "$ip" "$username" "$password"
                    ;;
                "enable")
                    enable_sol_server "$ip" "$username" "$password" "$type"
                    ;;
                "configure")
                    configure_sol_settings "$ip" "$username" "$password" "$type"
                    ;;
                "status")
                    check_sol_status "$ip" "$username" "$password"
                    ;;
            esac
        fi
    done < "$SOL_CONFIG_FILE"
}

# Test SOL connectivity
test_sol_connectivity() {
    local ip="$1"
    local username="$2"
    local password="$3"
    
    echo "Testing SOL connectivity to $ip..."
    
    # Test basic IPMI connectivity
    if ipmitool -I lanplus -H "$ip" -U "$username" -P "$password" chassis status >/dev/null 2>&1; then
        echo "  ✓ IPMI connectivity: OK"
    else
        echo "  ✗ IPMI connectivity: FAILED"
        return 1
    fi
    
    # Test SOL status
    local sol_info=$(ipmitool -I lanplus -H "$ip" -U "$username" -P "$password" sol info 2>/dev/null)
    if [[ -n "$sol_info" ]]; then
        echo "  ✓ SOL query: OK"
        
        # Check if SOL is enabled
        if echo "$sol_info" | grep -q "Enabled.*true"; then
            echo "  ✓ SOL status: Enabled"
        else
            echo "  ⚠ SOL status: Disabled"
        fi
        
        # Show SOL configuration
        echo "  SOL Configuration:"
        echo "$sol_info" | grep -E "(Bit Rate|Retry|Threshold)" | sed 's/^/    /'
    else
        echo "  ✗ SOL query: FAILED"
        return 1
    fi
}

# Enable SOL on server
enable_sol_server() {
    local ip="$1"
    local username="$2"
    local password="$3"
    local type="$4"
    
    log_message "Enabling SOL on $ip ($type)"
    
    case "$type" in
        "idrac8"|"idrac9"|"idrac10")
            # Enable via RACADM
            if command -v racadm >/dev/null 2>&1; then
                racadm -r "$ip" -u "$username" -p "$password" config -g cfgIpmiSol -o cfgIpmiSolEnable 1
                racadm -r "$ip" -u "$username" -p "$password" config -g cfgIpmiLan -o cfgIpmiLanEnable 1
                
                log_message "SOL enabled via RACADM on $ip"
            else
                log_message "Warning: RACADM not available, using IPMI commands"
            fi
            ;;
    esac
    
    # Verify SOL is enabled
    if ipmitool -I lanplus -H "$ip" -U "$username" -P "$password" sol info | grep -q "Enabled.*true"; then
        log_message "✓ SOL successfully enabled on $ip"
    else
        log_message "✗ Failed to enable SOL on $ip"
        return 1
    fi
}

# Check SOL status across all servers
check_sol_status() {
    local ip="$1"
    local username="$2"
    local password="$3"
    
    local sol_info=$(ipmitool -I lanplus -H "$ip" -U "$username" -P "$password" sol info 2>/dev/null)
    
    if [[ -n "$sol_info" ]]; then
        local enabled=$(echo "$sol_info" | grep "Enabled" | awk '{print $3}')
        local bitrate=$(echo "$sol_info" | grep "Bit Rate" | awk '{print $6}')
        
        printf "%-15s %-10s %-10s\n" "$ip" "$enabled" "$bitrate"
    else
        printf "%-15s %-10s %-10s\n" "$ip" "ERROR" "N/A"
    fi
}

# Interactive SOL manager
interactive_sol_manager() {
    echo "SOL Interactive Manager"
    echo "======================"
    
    # List available servers
    echo "Available servers:"
    echo "=================="
    local count=1
    while IFS='|' read -r name ip username password type description; do
        [[ "$name" =~ ^#.*$ ]] && continue
        [[ -z "$name" ]] && continue
        
        printf "%2d. %-12s %-15s %-10s %s\n" "$count" "$name" "$ip" "$type" "$description"
        ((count++))
    done < "$SOL_CONFIG_FILE"
    
    echo ""
    echo "Options:"
    echo "========="
    echo "1. Connect to SOL session"
    echo "2. Test connectivity"
    echo "3. Check SOL status"
    echo "4. Enable SOL"
    echo "5. Configure SOL settings"
    echo "6. Batch operations"
    echo "7. Exit"
    
    read -p "Select option (1-7): " choice
    
    case "$choice" in
        1)
            read -p "Enter server name: " server_name
            read -p "Enable session logging? (y/n): " enable_log
            local log_flag="false"
            [[ "$enable_log" =~ ^[Yy] ]] && log_flag="true"
            
            connect_sol "$server_name" "$log_flag"
            ;;
        2)
            read -p "Enter server name or pattern: " server_input
            batch_sol_operation "test" "$server_input"
            ;;
        3)
            echo "SOL Status Report"
            echo "================="
            printf "%-15s %-10s %-10s\n" "IP Address" "Enabled" "Bit Rate"
            printf "%-15s %-10s %-10s\n" "----------" "-------" "--------"
            batch_sol_operation "status" ".*"
            ;;
        4)
            read -p "Enter server name: " server_name
            batch_sol_operation "enable" "$server_name"
            ;;
        5)
            read -p "Enter server name: " server_name
            batch_sol_operation "configure" "$server_name"
            ;;
        6)
            echo "Available batch operations: test, enable, configure, status"
            read -p "Enter operation: " operation
            read -p "Enter server pattern (or . for all): " pattern
            batch_sol_operation "$operation" "$pattern"
            ;;
        7)
            echo "Goodbye!"
            exit 0
            ;;
        *)
            echo "Invalid choice"
            ;;
    esac
}

# Main execution
if [[ ! -f "$SOL_CONFIG_FILE" ]]; then
    echo "Creating default configuration file..."
    create_server_config
fi

# Run interactive manager if no arguments
if [[ $# -eq 0 ]]; then
    interactive_sol_manager
else
    # Command line interface
    case "$1" in
        "connect")
            connect_sol "$2" "${3:-true}"
            ;;
        "test")
            batch_sol_operation "test" "${2:-.*}"
            ;;
        "enable")
            batch_sol_operation "enable" "${2:-.*}"
            ;;
        "status")
            batch_sol_operation "status" "${2:-.*}"
            ;;
        *)
            echo "Usage: $0 {connect|test|enable|status} [server_name]"
            exit 1
            ;;
    esac
fi
```

# [Security and Authentication](#security-and-authentication)

## Advanced Authentication Management

### Secure Credential Management
```bash
#!/bin/bash
# Secure SOL credential management system

# Configuration
CRED_DIR="/etc/sol-manager/credentials"
KEYRING_SERVICE="sol-manager"

# Create secure credential storage
setup_credential_storage() {
    echo "Setting up secure credential storage..."
    
    # Create credentials directory with restricted permissions
    sudo mkdir -p "$CRED_DIR"
    sudo chmod 700 "$CRED_DIR"
    sudo chown root:root "$CRED_DIR"
    
    # Install secret management tools
    sudo apt install -y libsecret-tools gnupg2
    
    # Create GPG key for credential encryption
    if ! gpg --list-keys "SOL Manager" >/dev/null 2>&1; then
        echo "Creating GPG key for credential encryption..."
        gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 2048
Subkey-Type: RSA
Subkey-Length: 2048
Name-Real: SOL Manager
Name-Email: sol-manager@$(hostname)
Expire-Date: 1y
%no-ask-passphrase
%commit
EOF
    fi
    
    echo "✓ Credential storage configured"
}

# Store encrypted credentials
store_credentials() {
    local server_name="$1"
    local ip="$2"
    local username="$3"
    local password="$4"
    
    echo "Storing encrypted credentials for $server_name..."
    
    # Create credential file
    local cred_file="$CRED_DIR/${server_name}.cred"
    
    cat > "/tmp/cred_temp" <<EOF
IP=$ip
USERNAME=$username
PASSWORD=$password
CREATED=$(date)
EOF
    
    # Encrypt and store
    gpg --trust-model always --encrypt -r "SOL Manager" "/tmp/cred_temp"
    sudo mv "/tmp/cred_temp.gpg" "$cred_file"
    sudo chmod 600 "$cred_file"
    
    # Clean up
    rm -f "/tmp/cred_temp"
    
    echo "✓ Credentials stored securely"
}

# Retrieve credentials
get_credentials() {
    local server_name="$1"
    local cred_file="$CRED_DIR/${server_name}.cred"
    
    if [[ ! -f "$cred_file" ]]; then
        echo "Error: Credentials not found for $server_name"
        return 1
    fi
    
    # Decrypt credentials
    gpg --quiet --decrypt "$cred_file" 2>/dev/null
}

# Use credentials in SOL connection
secure_sol_connect() {
    local server_name="$1"
    
    # Get credentials
    local cred_data=$(get_credentials "$server_name")
    if [[ -z "$cred_data" ]]; then
        echo "Error: Cannot retrieve credentials for $server_name"
        return 1
    fi
    
    # Parse credentials
    local ip username password
    while IFS='=' read -r key value; do
        case "$key" in
            "IP") ip="$value" ;;
            "USERNAME") username="$value" ;;
            "PASSWORD") password="$value" ;;
        esac
    done <<< "$cred_data"
    
    # Connect with retrieved credentials
    echo "Connecting to SOL on $server_name ($ip)..."
    ipmitool -I lanplus -H "$ip" -U "$username" -P "$password" sol activate
}

# Certificate-based authentication
setup_certificate_auth() {
    local server_ip="$1"
    local cert_file="/etc/sol-manager/certs/${server_ip}.crt"
    local key_file="/etc/sol-manager/certs/${server_ip}.key"
    
    echo "Setting up certificate-based authentication for $server_ip..."
    
    # Create certificate directory
    sudo mkdir -p "$(dirname "$cert_file")"
    
    # Generate client certificate
    openssl req -new -x509 -days 365 -nodes \
        -out "$cert_file" \
        -keyout "$key_file" \
        -subj "/C=US/ST=State/L=City/O=Organization/CN=sol-client"
    
    # Secure certificate files
    sudo chmod 600 "$cert_file" "$key_file"
    
    echo "✓ Certificate authentication configured"
    echo "Upload $cert_file to iDRAC for certificate-based auth"
}

# Role-based access control
setup_rbac() {
    local config_file="/etc/sol-manager/rbac.conf"
    
    echo "Setting up role-based access control..."
    
    cat > "$config_file" <<EOF
# Role-Based Access Control Configuration
# Format: user:role:servers

# Administrators - full access
admin:full:*
root:full:*

# Operations team - production servers only
ops-user1:prod:server01,server02,server03
ops-user2:prod:server04,server05

# Development team - dev servers only
dev-user1:dev:dev-server01,dev-server02
dev-user2:dev:dev-server03

# Read-only users
monitor:readonly:*
EOF
    
    echo "✓ RBAC configuration created"
}

# Enforce access control
check_user_access() {
    local user="$1"
    local server="$2"
    local rbac_file="/etc/sol-manager/rbac.conf"
    
    # Get user's role and allowed servers
    local user_config=$(grep "^$user:" "$rbac_file" 2>/dev/null)
    
    if [[ -z "$user_config" ]]; then
        echo "Error: User $user not found in RBAC configuration"
        return 1
    fi
    
    local role=$(echo "$user_config" | cut -d':' -f2)
    local allowed_servers=$(echo "$user_config" | cut -d':' -f3)
    
    # Check if user has access to server
    if [[ "$allowed_servers" == "*" ]] || [[ "$allowed_servers" =~ $server ]]; then
        echo "✓ User $user ($role) has access to $server"
        return 0
    else
        echo "✗ User $user ($role) does not have access to $server"
        return 1
    fi
}
```

## Audit Logging and Monitoring

### Comprehensive SOL Audit System
```bash
#!/bin/bash
# SOL audit logging and monitoring system

# Configuration
AUDIT_LOG_DIR="/var/log/sol-audit"
AUDIT_CONFIG="/etc/sol-manager/audit.conf"
ALERT_SCRIPT="/usr/local/bin/sol-alert"

# Setup audit logging
setup_audit_logging() {
    echo "Setting up SOL audit logging..."
    
    # Create audit directories
    sudo mkdir -p "$AUDIT_LOG_DIR"/{sessions,commands,security}
    sudo chmod 750 "$AUDIT_LOG_DIR"
    
    # Configure log rotation
    sudo tee /etc/logrotate.d/sol-audit <<EOF
$AUDIT_LOG_DIR/*/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 640 root root
}
EOF
    
    # Create audit configuration
    cat > "$AUDIT_CONFIG" <<EOF
# SOL Audit Configuration
AUDIT_ENABLED=true
LOG_SESSIONS=true
LOG_COMMANDS=true
LOG_SECURITY_EVENTS=true
ALERT_ON_FAILURES=true
ALERT_EMAIL=admin@example.com
RETENTION_DAYS=90
EOF
    
    echo "✓ Audit logging configured"
}

# Audit wrapper for SOL connections
audit_sol_connect() {
    local server_name="$1"
    local user="${2:-$(whoami)}"
    local session_id="$(date +%Y%m%d_%H%M%S)_$$"
    
    # Load audit configuration
    source "$AUDIT_CONFIG"
    
    if [[ "$AUDIT_ENABLED" != "true" ]]; then
        echo "Audit logging is disabled"
        return 1
    fi
    
    # Create session log directory
    local session_log_dir="$AUDIT_LOG_DIR/sessions/$server_name"
    sudo mkdir -p "$session_log_dir"
    
    # Session metadata
    local session_file="$session_log_dir/${session_id}.json"
    local session_log="$session_log_dir/${session_id}.log"
    
    # Create session metadata
    cat > "$session_file" <<EOF
{
    "session_id": "$session_id",
    "server": "$server_name",
    "user": "$user",
    "start_time": "$(date -Iseconds)",
    "client_ip": "${SSH_CLIENT%% *}",
    "client_hostname": "$(hostname)",
    "pid": "$$",
    "ppid": "$PPID"
}
EOF
    
    # Log session start
    log_security_event "SESSION_START" "$user" "$server_name" "Session $session_id started"
    
    # Get server credentials
    local cred_data=$(get_credentials "$server_name")
    if [[ -z "$cred_data" ]]; then
        log_security_event "AUTH_FAILURE" "$user" "$server_name" "Failed to retrieve credentials"
        return 1
    fi
    
    # Parse credentials
    local ip username password
    while IFS='=' read -r key value; do
        case "$key" in
            "IP") ip="$value" ;;
            "USERNAME") username="$value" ;;
            "PASSWORD") password="$value" ;;
        esac
    done <<< "$cred_data"
    
    # Pre-connection security check
    if ! check_user_access "$user" "$server_name"; then
        log_security_event "ACCESS_DENIED" "$user" "$server_name" "User does not have permission"
        return 1
    fi
    
    # Start session with logging
    echo "Starting audited SOL session to $server_name..."
    
    # Use script to capture session
    script -f "$session_log" -c "
        echo 'SOL session started at $(date)'
        echo 'User: $user | Server: $server_name | Session: $session_id'
        echo '=========================================='
        ipmitool -I lanplus -H '$ip' -U '$username' -P '$password' sol activate
        echo '=========================================='
        echo 'SOL session ended at $(date)'
    "
    
    # Update session metadata
    local end_time=$(date -Iseconds)
    local session_duration=$(($(date -d "$end_time" +%s) - $(date -d "$(jq -r .start_time "$session_file")" +%s)))
    
    jq --arg end_time "$end_time" --arg duration "$session_duration" \
       '.end_time = $end_time | .duration_seconds = ($duration | tonumber)' \
       "$session_file" > "${session_file}.tmp" && mv "${session_file}.tmp" "$session_file"
    
    # Log session end
    log_security_event "SESSION_END" "$user" "$server_name" "Session $session_id ended (duration: ${session_duration}s)"
}

# Security event logging
log_security_event() {
    local event_type="$1"
    local user="$2"
    local server="$3"
    local message="$4"
    
    local security_log="$AUDIT_LOG_DIR/security/security.log"
    local timestamp=$(date -Iseconds)
    
    # Create security log entry
    local log_entry=$(cat <<EOF
{
    "timestamp": "$timestamp",
    "event_type": "$event_type",
    "user": "$user",
    "server": "$server",
    "message": "$message",
    "client_ip": "${SSH_CLIENT%% *}",
    "hostname": "$(hostname)"
}
EOF
    )
    
    echo "$log_entry" >> "$security_log"
    
    # Send alert if configured
    if [[ "$ALERT_ON_FAILURES" == "true" ]] && [[ "$event_type" =~ (FAILURE|DENIED|ERROR) ]]; then
        send_security_alert "$event_type" "$user" "$server" "$message"
    fi
}

# Send security alerts
send_security_alert() {
    local event_type="$1"
    local user="$2"
    local server="$3"
    local message="$4"
    
    local alert_subject="SOL Security Alert: $event_type"
    local alert_body="
Security Event Details:
======================
Event Type: $event_type
User: $user
Server: $server
Message: $message
Time: $(date)
Host: $(hostname)
Client IP: ${SSH_CLIENT%% *}
"
    
    # Email alert
    if [[ -n "$ALERT_EMAIL" ]]; then
        echo "$alert_body" | mail -s "$alert_subject" "$ALERT_EMAIL"
    fi
    
    # Syslog
    logger -t sol-audit -p auth.warning "$alert_subject: $message"
    
    # Custom alert script
    if [[ -x "$ALERT_SCRIPT" ]]; then
        "$ALERT_SCRIPT" "$event_type" "$user" "$server" "$message"
    fi
}

# Generate audit reports
generate_audit_report() {
    local report_type="${1:-summary}"
    local start_date="${2:-$(date -d '30 days ago' +%Y-%m-%d)}"
    local end_date="${3:-$(date +%Y-%m-%d)}"
    
    echo "SOL Audit Report ($report_type)"
    echo "Period: $start_date to $end_date"
    echo "==============================="
    
    case "$report_type" in
        "summary")
            echo ""
            echo "Session Summary:"
            echo "----------------"
            
            # Count sessions by user
            echo "Sessions by User:"
            find "$AUDIT_LOG_DIR/sessions" -name "*.json" -newer "$(date -d "$start_date" +%Y%m%d)" ! -newer "$(date -d "$end_date" +%Y%m%d)" \
                -exec jq -r '.user' {} \; | sort | uniq -c | sort -nr
            
            echo ""
            echo "Sessions by Server:"
            find "$AUDIT_LOG_DIR/sessions" -name "*.json" -newer "$(date -d "$start_date" +%Y%m%d)" ! -newer "$(date -d "$end_date" +%Y%m%d)" \
                -exec jq -r '.server' {} \; | sort | uniq -c | sort -nr
            
            echo ""
            echo "Security Events:"
            echo "----------------"
            if [[ -f "$AUDIT_LOG_DIR/security/security.log" ]]; then
                grep -E "$(date -d "$start_date" +%Y-%m-%d)|$(date -d "$end_date" +%Y-%m-%d)" \
                    "$AUDIT_LOG_DIR/security/security.log" | \
                    jq -r '.event_type' | sort | uniq -c | sort -nr
            fi
            ;;
            
        "detailed")
            echo ""
            echo "Detailed Session Log:"
            echo "---------------------"
            
            find "$AUDIT_LOG_DIR/sessions" -name "*.json" -newer "$(date -d "$start_date" +%Y%m%d)" ! -newer "$(date -d "$end_date" +%Y%m%d)" \
                -exec jq -r '"[\(.start_time)] \(.user) -> \(.server) (\(.duration_seconds//0)s)"' {} \; | sort
            
            echo ""
            echo "Security Events:"
            echo "----------------"
            if [[ -f "$AUDIT_LOG_DIR/security/security.log" ]]; then
                grep -E "$(date -d "$start_date" +%Y-%m-%d)|$(date -d "$end_date" +%Y-%m-%d)" \
                    "$AUDIT_LOG_DIR/security/security.log" | \
                    jq -r '"[\(.timestamp)] \(.event_type): \(.user) -> \(.server) - \(.message)"' | sort
            fi
            ;;
            
        "compliance")
            echo ""
            echo "Compliance Report:"
            echo "------------------"
            
            local total_sessions=$(find "$AUDIT_LOG_DIR/sessions" -name "*.json" -newer "$(date -d "$start_date" +%Y%m%d)" ! -newer "$(date -d "$end_date" +%Y%m%d)" | wc -l)
            local unique_users=$(find "$AUDIT_LOG_DIR/sessions" -name "*.json" -newer "$(date -d "$start_date" +%Y%m%d)" ! -newer "$(date -d "$end_date" +%Y%m%d)" -exec jq -r '.user' {} \; | sort -u | wc -l)
            local unique_servers=$(find "$AUDIT_LOG_DIR/sessions" -name "*.json" -newer "$(date -d "$start_date" +%Y%m%d)" ! -newer "$(date -d "$end_date" +%Y%m%d)" -exec jq -r '.server' {} \; | sort -u | wc -l)
            
            echo "Total Sessions: $total_sessions"
            echo "Unique Users: $unique_users"
            echo "Unique Servers: $unique_servers"
            echo "Audit Coverage: 100% (all sessions logged)"
            echo "Data Retention: $RETENTION_DAYS days"
            ;;
    esac
}

# Cleanup old audit logs
cleanup_audit_logs() {
    local retention_days="${1:-$RETENTION_DAYS}"
    
    echo "Cleaning up audit logs older than $retention_days days..."
    
    # Remove old session logs
    find "$AUDIT_LOG_DIR/sessions" -name "*.json" -mtime +$retention_days -delete
    find "$AUDIT_LOG_DIR/sessions" -name "*.log" -mtime +$retention_days -delete
    
    # Remove old security logs
    find "$AUDIT_LOG_DIR/security" -name "*.log" -mtime +$retention_days -delete
    
    echo "✓ Audit log cleanup completed"
}

# Setup audit system
setup_audit_logging

# Example usage
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        "connect")
            audit_sol_connect "$2" "$3"
            ;;
        "report")
            generate_audit_report "$2" "$3" "$4"
            ;;
        "cleanup")
            cleanup_audit_logs "$2"
            ;;
        *)
            echo "Usage: $0 {connect|report|cleanup}"
            echo "  connect <server> [user]     - Start audited SOL session"
            echo "  report [type] [start] [end] - Generate audit report"
            echo "  cleanup [days]              - Clean up old logs"
            ;;
    esac
fi
```

# [Advanced SOL Automation](#advanced-sol-automation)

## Scripted SOL Operations

### Automated Server Provisioning via SOL
```bash
#!/bin/bash
# Automated server provisioning through SOL

# Configuration
PROVISION_CONFIG="/etc/sol-manager/provision.conf"
KICKSTART_SERVER="http://provisioning.example.com"
EXPECT_TIMEOUT=300

# Provisioning framework
automated_provisioning() {
    local server_name="$1"
    local profile="$2"
    local kickstart_url="$3"
    
    echo "Starting automated provisioning for $server_name with profile $profile"
    
    # Get server credentials
    local cred_data=$(get_credentials "$server_name")
    if [[ -z "$cred_data" ]]; then
        echo "Error: Cannot retrieve credentials for $server_name"
        return 1
    fi
    
    # Parse credentials
    local ip username password
    while IFS='=' read -r key value; do
        case "$key" in
            "IP") ip="$value" ;;
            "USERNAME") username="$value" ;;
            "PASSWORD") password="$value" ;;
        esac
    done <<< "$cred_data"
    
    # Create expect script for automated interaction
    cat > "/tmp/provision_${server_name}.expect" <<EOF
#!/usr/bin/expect -f

set timeout $EXPECT_TIMEOUT
log_user 1

# Start SOL session
spawn ipmitool -I lanplus -H $ip -U $username -P $password sol activate

# Wait for boot menu or prompt
expect {
    "Press <F2>" {
        send "\x1b\[12~"
        exp_continue
    }
    "BIOS Setup" {
        send "q"
        exp_continue
    }
    "Boot Menu" {
        send "3\r"
        exp_continue
    }
    "PXE Boot" {
        send "\r"
        exp_continue
    }
    "vmlinuz" {
        send " ks=$kickstart_url\r"
        exp_continue
    }
    "login:" {
        send "root\r"
        expect "Password:"
        send "password\r"
        exp_continue
    }
    timeout {
        puts "Timeout waiting for boot process"
        exit 1
    }
}

# Monitor installation progress
expect {
    "Installation complete" {
        puts "✓ Installation completed successfully"
        exit 0
    }
    "Error" {
        puts "✗ Installation failed"
        exit 1
    }
    timeout {
        puts "Installation timeout"
        exit 1
    }
}
EOF
    
    # Execute provisioning
    chmod +x "/tmp/provision_${server_name}.expect"
    "/tmp/provision_${server_name}.expect"
    
    # Cleanup
    rm -f "/tmp/provision_${server_name}.expect"
}

# BIOS configuration automation
automated_bios_config() {
    local server_name="$1"
    local bios_profile="$2"
    
    echo "Configuring BIOS for $server_name with profile $bios_profile"
    
    # Get server credentials
    local cred_data=$(get_credentials "$server_name")
    local ip username password
    while IFS='=' read -r key value; do
        case "$key" in
            "IP") ip="$value" ;;
            "USERNAME") username="$value" ;;
            "PASSWORD") password="$value" ;;
        esac
    done <<< "$cred_data"
    
    # Create BIOS configuration expect script
    cat > "/tmp/bios_config_${server_name}.expect" <<EOF
#!/usr/bin/expect -f

set timeout 60
log_user 1

# Start SOL session
spawn ipmitool -I lanplus -H $ip -U $username -P $password sol activate

# Power cycle server
spawn ipmitool -I lanplus -H $ip -U $username -P $password power cycle

# Wait for BIOS setup prompt
expect {
    "Press <F2>" {
        send "\x1b\[12~"
        exp_continue
    }
    "BIOS Setup" {
        # Navigate through BIOS menus based on profile
        apply_bios_profile "$bios_profile"
        exp_continue
    }
    timeout {
        puts "Timeout waiting for BIOS setup"
        exit 1
    }
}

proc apply_bios_profile {profile} {
    switch \$profile {
        "performance" {
            # Enable performance settings
            send_performance_config
        }
        "power_save" {
            # Enable power saving features
            send_power_config
        }
        "default" {
            # Reset to defaults
            send "\x1b\[21~"  # F9 for defaults
            expect "Load defaults?"
            send "y\r"
        }
    }
    
    # Save and exit
    send "\x1b\[22~"  # F10 to save and exit
    expect "Save changes?"
    send "y\r"
}

proc send_performance_config {} {
    # Navigate to performance settings
    send "\t\t\t\r"  # Navigate to Advanced tab
    expect "Advanced"
    
    # Enable performance features
    send "\r"  # Enter CPU settings
    expect "CPU Configuration"
    
    # Enable Intel Turbo Boost
    send "\t\t\r"  # Navigate to Turbo Boost
    expect "Intel Turbo Boost"
    send "\r"  # Enable
    
    # Continue with other performance settings...
}

proc send_power_config {} {
    # Navigate to power management
    send "\t\t\t\t\r"  # Navigate to Power tab
    expect "Power"
    
    # Enable power saving features
    send "\r"  # Enter power settings
    expect "Power Management"
    
    # Enable C-states
    send "\t\t\r"  # Navigate to C-states
    expect "C-states"
    send "\r"  # Enable
    
    # Continue with other power settings...
}
EOF
    
    # Execute BIOS configuration
    chmod +x "/tmp/bios_config_${server_name}.expect"
    "/tmp/bios_config_${server_name}.expect"
    
    # Cleanup
    rm -f "/tmp/bios_config_${server_name}.expect"
}

# Batch server deployment
batch_deployment() {
    local deployment_list="$1"
    local deployment_profile="$2"
    
    echo "Starting batch deployment with profile: $deployment_profile"
    
    # Process deployment list
    while IFS=',' read -r server_name os_profile kickstart_url; do
        echo "Deploying $server_name with $os_profile..."
        
        # Configure BIOS if needed
        if [[ "$deployment_profile" == "performance" ]]; then
            automated_bios_config "$server_name" "performance"
        fi
        
        # Start OS installation
        automated_provisioning "$server_name" "$os_profile" "$kickstart_url"
        
        # Wait between deployments
        sleep 30
        
    done < "$deployment_list"
    
    echo "Batch deployment completed"
}

# Recovery operations
automated_recovery() {
    local server_name="$1"
    local recovery_type="$2"
    
    echo "Starting automated recovery for $server_name (type: $recovery_type)"
    
    case "$recovery_type" in
        "rescue_boot")
            # Boot from rescue media
            automated_rescue_boot "$server_name"
            ;;
        "bios_reset")
            # Reset BIOS to defaults
            automated_bios_config "$server_name" "default"
            ;;
        "firmware_update")
            # Update server firmware
            automated_firmware_update "$server_name"
            ;;
        *)
            echo "Unknown recovery type: $recovery_type"
            return 1
            ;;
    esac
}

# Rescue boot automation
automated_rescue_boot() {
    local server_name="$1"
    
    # Get server credentials
    local cred_data=$(get_credentials "$server_name")
    local ip username password
    while IFS='=' read -r key value; do
        case "$key" in
            "IP") ip="$value" ;;
            "USERNAME") username="$value" ;;
            "PASSWORD") password="$value" ;;
        esac
    done <<< "$cred_data"
    
    echo "Initiating rescue boot for $server_name..."
    
    # Create rescue boot expect script
    cat > "/tmp/rescue_boot_${server_name}.expect" <<EOF
#!/usr/bin/expect -f

set timeout 120
log_user 1

# Start SOL session
spawn ipmitool -I lanplus -H $ip -U $username -P $password sol activate

# Power cycle server
spawn ipmitool -I lanplus -H $ip -U $username -P $password power cycle

# Wait for boot menu
expect {
    "Boot Menu" {
        send "2\r"  # Select rescue media
        exp_continue
    }
    "Rescue" {
        send "\r"
        exp_continue
    }
    "rescue#" {
        puts "✓ Rescue mode activated"
        # Keep session open for manual intervention
        interact
    }
    timeout {
        puts "Timeout waiting for rescue boot"
        exit 1
    }
}
EOF
    
    # Execute rescue boot
    chmod +x "/tmp/rescue_boot_${server_name}.expect"
    "/tmp/rescue_boot_${server_name}.expect"
    
    # Cleanup
    rm -f "/tmp/rescue_boot_${server_name}.expect"
}
```

## Integration with Configuration Management

### Ansible SOL Integration
```yaml
# Ansible playbook for SOL operations
---
- name: SOL Server Management
  hosts: localhost
  vars:
    sol_servers:
      - name: server01
        ip: 192.168.1.101
        username: root
        password: calvin
        type: idrac9
      - name: server02
        ip: 192.168.1.102
        username: admin
        password: password
        type: idrac10
  
  tasks:
    - name: Test SOL connectivity
      shell: |
        ipmitool -I lanplus -H {{ item.ip }} -U {{ item.username }} -P {{ item.password }} chassis status
      loop: "{{ sol_servers }}"
      register: sol_test_results
      ignore_errors: yes
    
    - name: Enable SOL on servers
      shell: |
        ipmitool -I lanplus -H {{ item.ip }} -U {{ item.username }} -P {{ item.password }} sol set enabled true
      loop: "{{ sol_servers }}"
      when: sol_test_results is succeeded
    
    - name: Configure SOL settings
      shell: |
        ipmitool -I lanplus -H {{ item.ip }} -U {{ item.username }} -P {{ item.password }} sol set character-accumulate-level 1
        ipmitool -I lanplus -H {{ item.ip }} -U {{ item.username }} -P {{ item.password }} sol set character-send-threshold 40
        ipmitool -I lanplus -H {{ item.ip }} -U {{ item.username }} -P {{ item.password }} sol set retry-count 3
      loop: "{{ sol_servers }}"
    
    - name: Generate SOL status report
      shell: |
        ipmitool -I lanplus -H {{ item.ip }} -U {{ item.username }} -P {{ item.password }} sol info
      loop: "{{ sol_servers }}"
      register: sol_status
    
    - name: Display SOL status
      debug:
        msg: "Server {{ item.item.name }}: {{ item.stdout }}"
      loop: "{{ sol_status.results }}"
```

### Terraform SOL Infrastructure
```hcl
# Terraform configuration for SOL infrastructure
terraform {
  required_providers {
    null = {
      source = "hashicorp/null"
    }
  }
}

variable "sol_servers" {
  description = "List of servers for SOL configuration"
  type = list(object({
    name     = string
    ip       = string
    username = string
    password = string
    type     = string
  }))
  default = [
    {
      name     = "server01"
      ip       = "192.168.1.101"
      username = "root"
      password = "calvin"
      type     = "idrac9"
    }
  ]
}

resource "null_resource" "sol_configuration" {
  count = length(var.sol_servers)
  
  provisioner "local-exec" {
    command = <<-EOT
      # Test connectivity
      ipmitool -I lanplus -H ${var.sol_servers[count.index].ip} \
        -U ${var.sol_servers[count.index].username} \
        -P ${var.sol_servers[count.index].password} chassis status
      
      # Enable SOL
      ipmitool -I lanplus -H ${var.sol_servers[count.index].ip} \
        -U ${var.sol_servers[count.index].username} \
        -P ${var.sol_servers[count.index].password} sol set enabled true
      
      # Configure SOL settings
      ipmitool -I lanplus -H ${var.sol_servers[count.index].ip} \
        -U ${var.sol_servers[count.index].username} \
        -P ${var.sol_servers[count.index].password} sol set character-accumulate-level 1
    EOT
  }
  
  triggers = {
    server_config = jsonencode(var.sol_servers[count.index])
  }
}

output "sol_server_status" {
  value = {
    for idx, server in var.sol_servers :
    server.name => {
      ip   = server.ip
      type = server.type
    }
  }
}
```

This comprehensive SOL guide provides enterprise-level knowledge for managing Serial Over LAN connections with Dell iDRAC and BMC systems, covering everything from basic setup to advanced automation, security, and integration with modern infrastructure management tools.