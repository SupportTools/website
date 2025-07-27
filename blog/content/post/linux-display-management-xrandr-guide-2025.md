---
title: "Linux Display Management & Multi-Monitor Setup Guide 2025: Complete xrandr Configuration & Automation"
date: 2025-08-05T10:00:00-05:00
draft: false
tags: ["xrandr", "Linux Display", "Multi-Monitor", "X11", "Wayland", "Display Configuration", "Monitor Setup", "Linux Graphics", "Display Manager", "Screen Resolution", "HDMI Configuration", "Desktop Environment", "Graphics Setup", "Monitor Management"]
categories:
- Linux
- Desktop Configuration
- System Administration
- Graphics
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Linux display management with xrandr and modern tools. Complete guide to multi-monitor setup, resolution configuration, automated display switching, graphics troubleshooting, and enterprise desktop deployment."
more_link: "yes"
url: "/linux-display-management-xrandr-guide-2025/"
---

Linux display management has evolved significantly with modern graphics drivers, multi-monitor setups, and enterprise desktop deployments. This comprehensive guide covers xrandr mastery, automated display configuration, graphics troubleshooting, and advanced multi-monitor management for both X11 and Wayland environments.

<!--more-->

# [Modern Linux Display Architecture](#modern-linux-display-architecture)

## Understanding Display Systems

### X11 vs Wayland Display Servers
```bash
# Check current display server
echo $XDG_SESSION_TYPE

# X11 display information
if [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
    echo "Running X11 - using xrandr"
    xrandr --version
elif [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
    echo "Running Wayland - using wlr-randr or swaymsg"
    which wlr-randr swaymsg
fi
```

### Graphics Driver Architecture
- **Intel Graphics**: i915 kernel driver with mesa userspace
- **NVIDIA**: Proprietary driver or nouveau open-source
- **AMD**: AMDGPU kernel driver with mesa userspace
- **Display Protocols**: DisplayPort, HDMI, DVI, VGA, USB-C/Thunderbolt

### Modern Display Technologies
- **4K/8K Support**: High resolution display management
- **HDR**: High Dynamic Range configuration
- **Variable Refresh Rate**: FreeSync/G-Sync support
- **Color Management**: ICC profiles and color spaces
- **Multi-GPU**: Hybrid graphics and GPU switching

# [Comprehensive xrandr Usage](#comprehensive-xrandr-usage)

## Advanced Display Detection and Configuration

### Complete System Analysis Script
```bash
#!/bin/bash
# Comprehensive display system analysis

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

analyze_display_system() {
    echo -e "${BLUE}Linux Display System Analysis${NC}"
    echo "=================================="
    
    # System information
    echo -e "\n${YELLOW}System Information:${NC}"
    echo "Kernel: $(uname -r)"
    echo "Distribution: $(lsb_release -d | cut -f2 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
    echo "Desktop Environment: $DESKTOP_SESSION"
    echo "Display Server: $XDG_SESSION_TYPE"
    
    # Graphics hardware
    echo -e "\n${YELLOW}Graphics Hardware:${NC}"
    lspci | grep -E "(VGA|3D|Display)" | while read line; do
        echo "  $line"
    done
    
    # Graphics drivers
    echo -e "\n${YELLOW}Graphics Drivers:${NC}"
    lsmod | grep -E "(i915|nouveau|nvidia|amdgpu|radeon)" | while read module rest; do
        echo "  $module: loaded"
    done
    
    # Display server info
    echo -e "\n${YELLOW}Display Server Information:${NC}"
    if [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
        echo "X Server: $(X -version 2>&1 | head -1)"
        echo "X Display: $DISPLAY"
        
        # Available displays
        echo -e "\n${YELLOW}Connected Displays:${NC}"
        xrandr --query | grep " connected" | while read output status rest; do
            echo "  $output: $status"
            
            # Get current mode
            current_mode=$(xrandr --query | grep -A1 "^$output" | tail -1 | grep -o '[0-9]*x[0-9]*' | head -1)
            echo "    Current: $current_mode"
            
            # Get preferred mode
            preferred_mode=$(xrandr --query | grep -A10 "^$output" | grep -E '\+.*\*' | awk '{print $1}')
            echo "    Preferred: $preferred_mode"
        done
        
    elif [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
        echo "Wayland Compositor: $WAYLAND_DISPLAY"
        
        # Try different Wayland display managers
        if command -v swaymsg >/dev/null 2>&1; then
            echo -e "\n${YELLOW}Sway Outputs:${NC}"
            swaymsg -t get_outputs | jq -r '.[] | "\(.name): \(.current_mode.width)x\(.current_mode.height) @ \(.current_mode.refresh)Hz"'
        elif command -v wlr-randr >/dev/null 2>&1; then
            echo -e "\n${YELLOW}wlr-randr Outputs:${NC}"
            wlr-randr
        fi
    fi
    
    # Display capabilities
    echo -e "\n${YELLOW}Display Capabilities:${NC}"
    if command -v xrandr >/dev/null 2>&1 && [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
        xrandr --listproviders 2>/dev/null | grep -v "^Providers:" | while read line; do
            echo "  $line"
        done
    fi
}

# Execute analysis
analyze_display_system
```

### Advanced xrandr Configuration
```bash
#!/bin/bash
# Advanced xrandr configuration management

# Configuration file for display presets
DISPLAY_CONFIG_DIR="$HOME/.config/display-manager"
mkdir -p "$DISPLAY_CONFIG_DIR"

# Save current display configuration
save_display_config() {
    local config_name="$1"
    local config_file="$DISPLAY_CONFIG_DIR/${config_name}.conf"
    
    echo "# Display configuration: $config_name" > "$config_file"
    echo "# Generated on: $(date)" >> "$config_file"
    echo "" >> "$config_file"
    
    # Save current xrandr state
    xrandr --query | grep " connected" | while read output status geometry rest; do
        if [[ "$status" == "connected" ]]; then
            if [[ "$geometry" =~ ^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+ ]]; then
                # Output is active
                local resolution=$(echo "$geometry" | cut -d'+' -f1)
                local x_offset=$(echo "$geometry" | cut -d'+' -f2)
                local y_offset=$(echo "$geometry" | cut -d'+' -f3)
                
                echo "xrandr --output $output --mode $resolution --pos ${x_offset}x${y_offset}" >> "$config_file"
            else
                # Output is connected but inactive
                echo "# xrandr --output $output --off" >> "$config_file"
            fi
        fi
    done
    
    echo "✓ Display configuration saved to: $config_file"
}

# Load display configuration
load_display_config() {
    local config_name="$1"
    local config_file="$DISPLAY_CONFIG_DIR/${config_name}.conf"
    
    if [[ ! -f "$config_file" ]]; then
        echo "Error: Configuration '$config_name' not found"
        return 1
    fi
    
    echo "Loading display configuration: $config_name"
    
    # Execute configuration commands
    grep -v '^#' "$config_file" | grep -v '^$' | while read cmd; do
        echo "Executing: $cmd"
        eval "$cmd"
    done
    
    echo "✓ Display configuration loaded"
}

# List available configurations
list_display_configs() {
    echo "Available display configurations:"
    echo "================================"
    
    for config in "$DISPLAY_CONFIG_DIR"/*.conf; do
        if [[ -f "$config" ]]; then
            local name=$(basename "$config" .conf)
            local date=$(grep "Generated on:" "$config" | cut -d':' -f2- | xargs)
            echo "  $name ($date)"
        fi
    done
}

# Intelligent display detection and configuration
auto_configure_displays() {
    echo "Auto-configuring displays..."
    
    # Get connected displays
    local displays=($(xrandr --query | grep " connected" | cut -d' ' -f1))
    local primary_display=""
    local external_displays=()
    
    # Identify primary and external displays
    for display in "${displays[@]}"; do
        if [[ "$display" =~ ^(eDP|LVDS|DSI) ]]; then
            primary_display="$display"
        else
            external_displays+=("$display")
        fi
    done
    
    # Configure based on setup
    case ${#external_displays[@]} in
        0)
            # Laptop only
            echo "Laptop-only configuration"
            xrandr --output "$primary_display" --auto --primary
            ;;
        1)
            # Single external monitor
            echo "Single external monitor configuration"
            local external="${external_displays[0]}"
            
            # Get optimal resolution for external
            local ext_resolution=$(xrandr --query | grep -A1 "^$external connected" | tail -1 | awk '{print $1}')
            
            xrandr --output "$primary_display" --auto --primary \
                   --output "$external" --mode "$ext_resolution" --right-of "$primary_display"
            ;;
        *)
            # Multiple external monitors
            echo "Multiple external monitor configuration"
            xrandr --output "$primary_display" --auto --primary
            
            local prev_output="$primary_display"
            for external in "${external_displays[@]}"; do
                local ext_resolution=$(xrandr --query | grep -A1 "^$external connected" | tail -1 | awk '{print $1}')
                xrandr --output "$external" --mode "$ext_resolution" --right-of "$prev_output"
                prev_output="$external"
            done
            ;;
    esac
    
    echo "✓ Auto-configuration complete"
}

# Interactive display configuration
interactive_display_config() {
    echo "Interactive Display Configuration"
    echo "================================"
    
    # List connected displays
    local displays=($(xrandr --query | grep " connected" | cut -d' ' -f1))
    
    echo "Connected displays:"
    for i in "${!displays[@]}"; do
        echo "  $((i+1)). ${displays[i]}"
    done
    
    echo ""
    echo "Configuration options:"
    echo "1. Mirror all displays"
    echo "2. Extend displays horizontally"
    echo "3. Extend displays vertically"
    echo "4. Custom configuration"
    echo "5. Save current configuration"
    echo "6. Load saved configuration"
    
    read -p "Select option (1-6): " choice
    
    case $choice in
        1)
            # Mirror displays
            local primary="${displays[0]}"
            xrandr --output "$primary" --auto --primary
            
            for display in "${displays[@]:1}"; do
                xrandr --output "$display" --same-as "$primary"
            done
            ;;
        2)
            # Extend horizontally
            auto_configure_displays
            ;;
        3)
            # Extend vertically
            local primary="${displays[0]}"
            xrandr --output "$primary" --auto --primary
            
            local prev_output="$primary"
            for display in "${displays[@]:1}"; do
                xrandr --output "$display" --auto --above "$prev_output"
                prev_output="$display"
            done
            ;;
        4)
            # Custom configuration
            echo "Custom configuration mode - enter xrandr commands manually"
            ;;
        5)
            # Save configuration
            read -p "Enter configuration name: " config_name
            save_display_config "$config_name"
            ;;
        6)
            # Load configuration
            list_display_configs
            read -p "Enter configuration name to load: " config_name
            load_display_config "$config_name"
            ;;
    esac
}

# Display resolution testing
test_display_resolution() {
    local output="$1"
    local resolution="$2"
    local test_duration="${3:-10}"
    
    echo "Testing resolution $resolution on $output for $test_duration seconds..."
    
    # Get current resolution
    local current_resolution=$(xrandr --query | grep "^$output" | grep -o '[0-9]*x[0-9]*' | head -1)
    
    # Apply test resolution
    if xrandr --output "$output" --mode "$resolution"; then
        echo "✓ Resolution applied successfully"
        echo "Test will revert in $test_duration seconds. Press Ctrl+C to keep changes."
        
        # Countdown timer
        for ((i=test_duration; i>0; i--)); do
            echo -ne "\rReverting in $i seconds... "
            sleep 1
        done
        
        # Revert to original resolution
        xrandr --output "$output" --mode "$current_resolution"
        echo -e "\n✓ Reverted to original resolution"
    else
        echo "✗ Failed to apply resolution"
        return 1
    fi
}
```

# [Enterprise Multi-Monitor Management](#enterprise-multi-monitor-management)

## Automated Display Profile System

```bash
#!/bin/bash
# Enterprise display profile management system

# System-wide configuration directory
SYSTEM_CONFIG_DIR="/etc/display-profiles"
USER_CONFIG_DIR="$HOME/.config/display-profiles"

# Create configuration directories
sudo mkdir -p "$SYSTEM_CONFIG_DIR"
mkdir -p "$USER_CONFIG_DIR"

# Display profile manager
cat > /usr/local/bin/display-profile-manager << 'SCRIPT'
#!/bin/bash

# Enterprise Display Profile Manager
# Manages display configurations across multiple environments

set -euo pipefail

# Configuration
SYSTEM_PROFILES="/etc/display-profiles"
USER_PROFILES="$HOME/.config/display-profiles"
CURRENT_PROFILE_FILE="$USER_PROFILES/.current"
LOG_FILE="/var/log/display-manager.log"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Detect display environment
detect_environment() {
    local connected_displays=($(xrandr --query | grep " connected" | cut -d' ' -f1 | sort))
    local display_hash=$(printf '%s\n' "${connected_displays[@]}" | md5sum | cut -d' ' -f1)
    
    echo "$display_hash"
}

# Create display fingerprint
create_display_fingerprint() {
    local profile_name="$1"
    local fingerprint_file="$USER_PROFILES/${profile_name}.fingerprint"
    
    # Create comprehensive fingerprint
    {
        echo "# Display fingerprint for $profile_name"
        echo "# Generated on $(date)"
        echo ""
        
        echo "[connected_displays]"
        xrandr --query | grep " connected" | cut -d' ' -f1 | sort
        
        echo ""
        echo "[display_info]"
        xrandr --query | grep -A5 " connected" | grep -E "(connected|[0-9]+x[0-9]+)" | \
            sed 's/^[[:space:]]*//' | while read line; do
            echo "$line"
        done
        
        echo ""
        echo "[system_info]"
        echo "hostname=$(hostname)"
        echo "user=$(whoami)"
        echo "session=$XDG_SESSION_TYPE"
        
    } > "$fingerprint_file"
    
    log "Created fingerprint for profile: $profile_name"
}

# Match environment to profile
match_environment() {
    local current_env=$(detect_environment)
    
    # Check user profiles first
    for profile in "$USER_PROFILES"/*.profile; do
        [[ ! -f "$profile" ]] && continue
        
        local profile_name=$(basename "$profile" .profile)
        local fingerprint_file="$USER_PROFILES/${profile_name}.fingerprint"
        
        if [[ -f "$fingerprint_file" ]]; then
            local profile_env=$(grep -A20 "\[connected_displays\]" "$fingerprint_file" | \
                              grep -v "\[" | grep -v "^#" | grep -v "^$" | sort | md5sum | cut -d' ' -f1)
            
            if [[ "$current_env" == "$profile_env" ]]; then
                echo "$profile_name"
                return 0
            fi
        fi
    done
    
    # Check system profiles
    for profile in "$SYSTEM_PROFILES"/*.profile; do
        [[ ! -f "$profile" ]] && continue
        
        local profile_name=$(basename "$profile" .profile)
        local fingerprint_file="$SYSTEM_PROFILES/${profile_name}.fingerprint"
        
        if [[ -f "$fingerprint_file" ]]; then
            local profile_env=$(grep -A20 "\[connected_displays\]" "$fingerprint_file" | \
                              grep -v "\[" | grep -v "^#" | grep -v "^$" | sort | md5sum | cut -d' ' -f1)
            
            if [[ "$current_env" == "$profile_env" ]]; then
                echo "$profile_name"
                return 0
            fi
        fi
    done
    
    echo ""
}

# Apply display profile
apply_profile() {
    local profile_name="$1"
    local force="${2:-false}"
    
    # Look for profile in user directory first, then system
    local profile_file=""
    if [[ -f "$USER_PROFILES/${profile_name}.profile" ]]; then
        profile_file="$USER_PROFILES/${profile_name}.profile"
    elif [[ -f "$SYSTEM_PROFILES/${profile_name}.profile" ]]; then
        profile_file="$SYSTEM_PROFILES/${profile_name}.profile"
    else
        log "Error: Profile '$profile_name' not found"
        return 1
    fi
    
    log "Applying display profile: $profile_name"
    
    # Turn off all displays first (except if forcing)
    if [[ "$force" != "true" ]]; then
        xrandr --query | grep " connected" | cut -d' ' -f1 | while read output; do
            xrandr --output "$output" --off 2>/dev/null || true
        done
        sleep 1
    fi
    
    # Apply profile commands
    while IFS= read -r cmd; do
        [[ "$cmd" =~ ^#.*$ ]] && continue
        [[ -z "$cmd" ]] && continue
        
        log "Executing: $cmd"
        if ! eval "$cmd"; then
            log "Warning: Command failed: $cmd"
        fi
    done < "$profile_file"
    
    # Record current profile
    echo "$profile_name" > "$CURRENT_PROFILE_FILE"
    log "✓ Profile applied successfully: $profile_name"
}

# Auto-apply profile based on environment
auto_apply() {
    local matched_profile=$(match_environment)
    
    if [[ -n "$matched_profile" ]]; then
        log "Environment matched to profile: $matched_profile"
        apply_profile "$matched_profile"
    else
        log "No matching profile found for current environment"
        
        # Create default configuration
        log "Applying default auto-configuration"
        auto_configure_basic
    fi
}

# Basic auto-configuration fallback
auto_configure_basic() {
    local displays=($(xrandr --query | grep " connected" | cut -d' ' -f1))
    
    if [[ ${#displays[@]} -eq 1 ]]; then
        # Single display
        xrandr --output "${displays[0]}" --auto --primary
    else
        # Multiple displays - extend horizontally
        xrandr --output "${displays[0]}" --auto --primary
        
        local prev_output="${displays[0]}"
        for display in "${displays[@]:1}"; do
            xrandr --output "$display" --auto --right-of "$prev_output"
            prev_output="$display"
        done
    fi
}

# Create new profile
create_profile() {
    local profile_name="$1"
    local description="${2:-Created on $(date)}"
    
    local profile_file="$USER_PROFILES/${profile_name}.profile"
    
    # Save current xrandr configuration
    {
        echo "# Display profile: $profile_name"
        echo "# Description: $description"
        echo "# Created: $(date)"
        echo ""
        
        # Generate xrandr commands for current state
        xrandr --query | grep " connected" | while read output status geometry rest; do
            if [[ "$geometry" =~ ^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+ ]]; then
                # Active output
                local mode=$(echo "$geometry" | cut -d'+' -f1)
                local x_pos=$(echo "$geometry" | cut -d'+' -f2)
                local y_pos=$(echo "$geometry" | cut -d'+' -f3)
                
                # Check if primary
                local primary=""
                if xrandr --query | grep "^$output" | grep -q "primary"; then
                    primary=" --primary"
                fi
                
                echo "xrandr --output $output --mode $mode --pos ${x_pos}x${y_pos}${primary}"
            fi
        done
        
    } > "$profile_file"
    
    # Create fingerprint
    create_display_fingerprint "$profile_name"
    
    log "Created profile: $profile_name"
    echo "✓ Profile saved: $profile_file"
}

# List available profiles
list_profiles() {
    echo "Available Display Profiles"
    echo "=========================="
    
    echo ""
    echo "User Profiles:"
    echo "--------------"
    for profile in "$USER_PROFILES"/*.profile; do
        [[ ! -f "$profile" ]] && continue
        
        local name=$(basename "$profile" .profile)
        local description=$(grep "# Description:" "$profile" | cut -d':' -f2- | xargs)
        local created=$(grep "# Created:" "$profile" | cut -d':' -f2- | xargs)
        
        echo "  $name"
        echo "    Description: $description"
        echo "    Created: $created"
        echo ""
    done
    
    echo "System Profiles:"
    echo "----------------"
    for profile in "$SYSTEM_PROFILES"/*.profile; do
        [[ ! -f "$profile" ]] && continue
        
        local name=$(basename "$profile" .profile)
        local description=$(grep "# Description:" "$profile" | cut -d':' -f2- | xargs)
        
        echo "  $name"
        echo "    Description: $description"
        echo ""
    done
}

# Current status
show_status() {
    echo "Display Profile Manager Status"
    echo "=============================="
    
    # Current profile
    if [[ -f "$CURRENT_PROFILE_FILE" ]]; then
        local current=$(cat "$CURRENT_PROFILE_FILE")
        echo "Current Profile: $current"
    else
        echo "Current Profile: None"
    fi
    
    # Environment fingerprint
    echo "Environment Hash: $(detect_environment)"
    
    # Matched profile
    local matched=$(match_environment)
    if [[ -n "$matched" ]]; then
        echo "Matched Profile: $matched"
    else
        echo "Matched Profile: None"
    fi
    
    # Connected displays
    echo ""
    echo "Connected Displays:"
    xrandr --query | grep " connected" | while read output status geometry rest; do
        if [[ "$geometry" =~ ^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+ ]]; then
            local mode=$(echo "$geometry" | cut -d'+' -f1)
            local pos_x=$(echo "$geometry" | cut -d'+' -f2)
            local pos_y=$(echo "$geometry" | cut -d'+' -f3)
            
            local primary_flag=""
            if xrandr --query | grep "^$output" | grep -q "primary"; then
                primary_flag=" (PRIMARY)"
            fi
            
            echo "  $output: $mode at ${pos_x}x${pos_y}${primary_flag}"
        else
            echo "  $output: connected but inactive"
        fi
    done
}

# Monitor for display changes
monitor_changes() {
    log "Starting display change monitor"
    
    local last_environment=""
    
    while true; do
        local current_environment=$(detect_environment)
        
        if [[ "$current_environment" != "$last_environment" ]]; then
            log "Display environment changed"
            auto_apply
            last_environment="$current_environment"
        fi
        
        sleep 5
    done
}

# Main command handler
case "${1:-}" in
    apply)
        apply_profile "${2:-}" "${3:-false}"
        ;;
    create)
        create_profile "${2:-new_profile}" "${3:-}"
        ;;
    list)
        list_profiles
        ;;
    status)
        show_status
        ;;
    auto)
        auto_apply
        ;;
    monitor)
        monitor_changes
        ;;
    match)
        matched=$(match_environment)
        if [[ -n "$matched" ]]; then
            echo "Matched profile: $matched"
        else
            echo "No matching profile found"
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 {apply|create|list|status|auto|monitor|match}"
        echo ""
        echo "Commands:"
        echo "  apply <profile>     Apply a display profile"
        echo "  create <name> [desc] Create new profile from current setup"
        echo "  list               List available profiles"
        echo "  status             Show current status"
        echo "  auto               Auto-apply best matching profile"
        echo "  monitor            Monitor for display changes"
        echo "  match              Show which profile matches current environment"
        exit 1
        ;;
esac
SCRIPT

chmod +x /usr/local/bin/display-profile-manager
```

## Automated Display Switching Service

```bash
# Create systemd service for automatic display management
sudo tee /etc/systemd/system/display-profile-manager.service << 'EOF'
[Unit]
Description=Display Profile Manager
After=graphical-session.target
Wants=graphical-session.target

[Service]
Type=simple
User=%i
Environment="DISPLAY=:0"
ExecStart=/usr/local/bin/display-profile-manager monitor
Restart=always
RestartSec=10

[Install]
WantedBy=graphical-session.target
EOF

# Enable for current user
systemctl --user enable display-profile-manager.service
systemctl --user start display-profile-manager.service
```

# [Graphics Driver Optimization](#graphics-driver-optimization)

## Driver Performance Tuning

```bash
#!/bin/bash
# Graphics driver optimization and configuration

# Intel graphics optimization
optimize_intel_graphics() {
    echo "Optimizing Intel graphics configuration..."
    
    # Create Intel graphics configuration
    sudo tee /etc/X11/xorg.conf.d/20-intel.conf << 'EOF'
Section "Device"
    Identifier "Intel Graphics"
    Driver "intel"
    Option "AccelMethod" "sna"
    Option "TearFree" "true"
    Option "DRI" "3"
    Option "Backlight" "intel_backlight"
    # Performance optimizations
    Option "TripleBuffer" "true"
    Option "SwapbuffersWait" "false"
    # Power management
    Option "RelaxedFencing" "true"
EOF
    
    # Configure kernel parameters
    echo "# Intel graphics optimizations" | sudo tee -a /etc/default/grub.d/intel-graphics.cfg
    echo 'GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT i915.enable_fbc=1 i915.enable_psr=1"' | \
        sudo tee -a /etc/default/grub.d/intel-graphics.cfg
    
    sudo update-grub
}

# NVIDIA graphics optimization
optimize_nvidia_graphics() {
    echo "Optimizing NVIDIA graphics configuration..."
    
    # Install NVIDIA drivers if not present
    if ! command -v nvidia-smi >/dev/null 2>&1; then
        echo "Installing NVIDIA drivers..."
        sudo apt update
        sudo apt install -y nvidia-driver-525 nvidia-settings
    fi
    
    # Create NVIDIA configuration
    sudo nvidia-xconfig --cool-bits=28 --allow-empty-initial-configuration
    
    # Performance settings
    sudo tee /etc/X11/xorg.conf.d/20-nvidia.conf << 'EOF'
Section "Device"
    Identifier "NVIDIA Graphics"
    Driver "nvidia"
    Option "NoLogo" "true"
    Option "UseEDID" "false"
    Option "ConnectedMonitor" "DFP"
    # Performance options
    Option "TripleBuffer" "true"
    Option "RegistryDwords" "PerfLevelSrc=0x2222"
    Option "OnDemandVBlankInterrupts" "true"
    # Multi-monitor support
    Option "MetaModes" "nvidia-auto-select +0+0 { ForceFullCompositionPipeline = On }"
    Option "AllowIndirectGLXProtocol" "off"
    Option "TripleBuffer" "on"
EOF
    
    # Configure power management
    echo "# NVIDIA power management" | sudo tee /etc/modprobe.d/nvidia-power.conf
    echo "options nvidia_drm modeset=1" | sudo tee -a /etc/modprobe.d/nvidia-power.conf
    
    # Update initramfs
    sudo update-initramfs -u
}

# AMD graphics optimization
optimize_amd_graphics() {
    echo "Optimizing AMD graphics configuration..."
    
    # Create AMD configuration
    sudo tee /etc/X11/xorg.conf.d/20-amdgpu.conf << 'EOF'
Section "Device"
    Identifier "AMD Graphics"
    Driver "amdgpu"
    Option "DRI" "3"
    Option "TearFree" "true"
    Option "AccelMethod" "glamor"
    # Performance options
    Option "SWcursor" "false"
    Option "EnablePageFlip" "true"
    Option "ColorTiling" "true"
EOF
    
    # Configure kernel parameters
    echo "# AMD graphics optimizations" | sudo tee /etc/default/grub.d/amd-graphics.cfg
    echo 'GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT amdgpu.dc=1 amdgpu.dpm=1"' | \
        sudo tee -a /etc/default/grub.d/amd-graphics.cfg
    
    sudo update-grub
}

# Detect and optimize graphics driver
auto_optimize_graphics() {
    local gpu_vendor=$(lspci | grep -E "(VGA|3D)" | head -1)
    
    if echo "$gpu_vendor" | grep -qi intel; then
        optimize_intel_graphics
    elif echo "$gpu_vendor" | grep -qi nvidia; then
        optimize_nvidia_graphics
    elif echo "$gpu_vendor" | grep -qi "advanced micro devices\|amd\|ati"; then
        optimize_amd_graphics
    else
        echo "Unknown GPU vendor: $gpu_vendor"
        echo "Using generic optimizations..."
        
        # Generic optimizations
        sudo tee /etc/X11/xorg.conf.d/20-generic.conf << 'EOF'
Section "Extensions"
    Option "Composite" "Enable"
EndSection

Section "ServerFlags"
    Option "DefaultServerLayout" "Layout0"
    Option "DontZap" "false"
EndSection
EOF
    fi
}

# Performance testing
test_graphics_performance() {
    echo "Graphics Performance Testing"
    echo "============================"
    
    # Install benchmarking tools
    if ! command -v glxgears >/dev/null 2>&1; then
        sudo apt install -y mesa-utils
    fi
    
    # Basic OpenGL test
    echo "OpenGL Information:"
    glxinfo | grep -E "(OpenGL version|OpenGL renderer|OpenGL vendor)"
    
    # FPS test
    echo ""
    echo "Running GLX gears benchmark (10 seconds)..."
    timeout 10 glxgears 2>&1 | tail -3
    
    # VSync test
    echo ""
    echo "Testing VSync status:"
    if command -v nvidia-settings >/dev/null 2>&1; then
        nvidia-settings -q SyncToVBlank
    else
        glxinfo | grep -i "sync"
    fi
    
    # Memory usage
    echo ""
    echo "GPU Memory Usage:"
    if command -v nvidia-smi >/dev/null 2>&1; then
        nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits
    elif command -v radeontop >/dev/null 2>&1; then
        radeontop -d- -l1 | grep -E "(VRAM|GTT)"
    else
        echo "No GPU memory monitoring available"
    fi
}
```

# [Wayland Display Management](#wayland-display-management)

## Wayland-Specific Tools and Configuration

```bash
#!/bin/bash
# Wayland display management tools

# Detect Wayland compositor
detect_wayland_compositor() {
    if [[ "$XDG_SESSION_TYPE" != "wayland" ]]; then
        echo "Not running Wayland"
        return 1
    fi
    
    if pgrep -x "sway" >/dev/null; then
        echo "sway"
    elif pgrep -x "gnome-shell" >/dev/null; then
        echo "gnome"
    elif pgrep -x "kwin_wayland" >/dev/null; then
        echo "kde"
    elif pgrep -x "weston" >/dev/null; then
        echo "weston"
    else
        echo "unknown"
    fi
}

# Sway display management
manage_sway_displays() {
    local action="$1"
    
    case "$action" in
        "list")
            swaymsg -t get_outputs | jq -r '.[] | "\(.name): \(.current_mode.width)x\(.current_mode.height) @ \(.current_mode.refresh)Hz"'
            ;;
        "configure")
            # Interactive Sway display configuration
            echo "Sway Display Configuration"
            echo "========================="
            
            local outputs=($(swaymsg -t get_outputs | jq -r '.[].name'))
            
            for output in "${outputs[@]}"; do
                echo "Configuring output: $output"
                
                # Get available modes
                echo "Available modes:"
                swaymsg -t get_outputs | jq -r ".[] | select(.name==\"$output\") | .modes[] | \"\(.width)x\(.height) @ \(.refresh)Hz\""
                
                read -p "Enter mode (WIDTHxHEIGHT@REFRESH or skip): " mode
                
                if [[ "$mode" != "skip" ]] && [[ -n "$mode" ]]; then
                    local width=$(echo "$mode" | cut -d'x' -f1)
                    local height=$(echo "$mode" | cut -d'x' -f2 | cut -d'@' -f1)
                    local refresh=$(echo "$mode" | cut -d'@' -f2 | sed 's/Hz//')
                    
                    swaymsg output "$output" mode "${width}x${height}@${refresh}Hz"
                fi
                
                read -p "Position (e.g., 1920 0 or auto): " position
                if [[ "$position" != "auto" ]] && [[ -n "$position" ]]; then
                    swaymsg output "$output" pos $position
                fi
            done
            ;;
        "save")
            # Save current Sway configuration
            local config_file="$HOME/.config/sway/displays.conf"
            mkdir -p "$(dirname "$config_file")"
            
            echo "# Sway display configuration - $(date)" > "$config_file"
            swaymsg -t get_outputs | jq -r '.[] | "output \(.name) mode \(.current_mode.width)x\(.current_mode.height)@\(.current_mode.refresh)Hz pos \(.rect.x) \(.rect.y)"' >> "$config_file"
            
            echo "Configuration saved to: $config_file"
            ;;
    esac
}

# GNOME Wayland display management
manage_gnome_displays() {
    local action="$1"
    
    case "$action" in
        "list")
            # List GNOME displays using gsettings
            gsettings list-keys org.gnome.settings-daemon.plugins.xrandr
            ;;
        "configure")
            # Use GNOME's display settings
            gnome-control-center display
            ;;
        "reset")
            # Reset GNOME display settings
            gsettings reset-recursively org.gnome.settings-daemon.plugins.xrandr
            gsettings reset-recursively org.gnome.desktop.interface
            ;;
    esac
}

# wlr-randr for wlroots-based compositors
setup_wlr_randr() {
    # Install wlr-randr if not available
    if ! command -v wlr-randr >/dev/null 2>&1; then
        echo "Installing wlr-randr..."
        
        # Try package manager first
        if command -v apt >/dev/null 2>&1; then
            sudo apt install -y wlr-randr
        elif command -v pacman >/dev/null 2>&1; then
            sudo pacman -S wlr-randr
        else
            # Build from source
            echo "Building wlr-randr from source..."
            git clone https://github.com/emersion/wlr-randr.git /tmp/wlr-randr
            cd /tmp/wlr-randr
            meson build
            ninja -C build
            sudo ninja -C build install
        fi
    fi
    
    echo "wlr-randr installed successfully"
}

# Universal Wayland display manager
wayland_display_manager() {
    local compositor=$(detect_wayland_compositor)
    
    echo "Wayland Display Manager"
    echo "======================"
    echo "Detected compositor: $compositor"
    echo ""
    
    case "$compositor" in
        "sway")
            echo "Sway commands:"
            echo "  1. List outputs"
            echo "  2. Configure displays"
            echo "  3. Save configuration"
            
            read -p "Select option (1-3): " choice
            case $choice in
                1) manage_sway_displays "list" ;;
                2) manage_sway_displays "configure" ;;
                3) manage_sway_displays "save" ;;
            esac
            ;;
        "gnome")
            echo "GNOME commands:"
            echo "  1. List settings"
            echo "  2. Open display settings"
            echo "  3. Reset configuration"
            
            read -p "Select option (1-3): " choice
            case $choice in
                1) manage_gnome_displays "list" ;;
                2) manage_gnome_displays "configure" ;;
                3) manage_gnome_displays "reset" ;;
            esac
            ;;
        *)
            echo "Using wlr-randr for compositor: $compositor"
            setup_wlr_randr
            
            echo ""
            echo "Available commands:"
            echo "  wlr-randr                    # List outputs"
            echo "  wlr-randr --output eDP-1 --mode 1920x1080@60"
            echo "  wlr-randr --output HDMI-A-1 --pos 1920,0"
            ;;
    esac
}

# Wayland screen capture and recording
wayland_screen_tools() {
    echo "Setting up Wayland screen capture tools..."
    
    # Install required tools
    local tools=("grim" "slurp" "wf-recorder" "swappy")
    
    for tool in "${tools[@]}"; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            echo "Installing $tool..."
            sudo apt install -y "$tool" 2>/dev/null || \
            sudo pacman -S "$tool" 2>/dev/null || \
            echo "Please install $tool manually"
        fi
    done
    
    # Create screen capture scripts
    cat > "$HOME/.local/bin/wayland-screenshot" << 'EOF'
#!/bin/bash
# Wayland screenshot tool

case "${1:-fullscreen}" in
    "fullscreen")
        grim "$HOME/Pictures/screenshot-$(date +%Y%m%d-%H%M%S).png"
        ;;
    "area")
        grim -g "$(slurp)" "$HOME/Pictures/screenshot-$(date +%Y%m%d-%H%M%S).png"
        ;;
    "edit")
        grim -g "$(slurp)" - | swappy -f -
        ;;
esac
EOF

    chmod +x "$HOME/.local/bin/wayland-screenshot"
    
    echo "✓ Wayland screen tools configured"
    echo "Usage: wayland-screenshot [fullscreen|area|edit]"
}
```

# [Display Troubleshooting and Diagnostics](#display-troubleshooting-and-diagnostics)

## Comprehensive Troubleshooting Toolkit

```bash
#!/bin/bash
# Comprehensive display troubleshooting toolkit

# Display problem diagnosis
diagnose_display_issues() {
    echo "Display Issue Diagnosis"
    echo "======================"
    
    # Check basic system state
    echo "1. System State Check:"
    echo "   Display Server: $XDG_SESSION_TYPE"
    echo "   Desktop Environment: ${DESKTOP_SESSION:-Unknown}"
    echo "   Current User: $(whoami)"
    echo "   Display Variable: ${DISPLAY:-Not set}"
    
    # Check graphics hardware
    echo ""
    echo "2. Graphics Hardware:"
    lspci | grep -E "(VGA|3D|Display)" | while read line; do
        echo "   $line"
    done
    
    # Check loaded graphics modules
    echo ""
    echo "3. Loaded Graphics Drivers:"
    lsmod | grep -E "(i915|nvidia|nouveau|amdgpu|radeon)" | while read module rest; do
        echo "   $module: loaded"
    done
    
    # Check X11 specific issues
    if [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
        echo ""
        echo "4. X11 Status:"
        
        # Check X server process
        if pgrep -x Xorg >/dev/null; then
            echo "   ✓ X server is running"
            
            # Check X server log for errors
            local x_log="/var/log/Xorg.0.log"
            if [[ -f "$x_log" ]]; then
                local error_count=$(grep -c "(EE)" "$x_log" 2>/dev/null || echo "0")
                local warning_count=$(grep -c "(WW)" "$x_log" 2>/dev/null || echo "0")
                echo "   X log errors: $error_count"
                echo "   X log warnings: $warning_count"
                
                if [[ $error_count -gt 0 ]]; then
                    echo "   Recent X errors:"
                    grep "(EE)" "$x_log" | tail -3 | sed 's/^/     /'
                fi
            fi
        else
            echo "   ✗ X server is not running"
        fi
        
        # Check xrandr functionality
        if command -v xrandr >/dev/null 2>&1; then
            if xrandr --query >/dev/null 2>&1; then
                echo "   ✓ xrandr is functional"
                
                # Check for connected but inactive displays
                local inactive_displays=$(xrandr --query | grep " connected" | grep -v "[0-9]x[0-9]" | cut -d' ' -f1)
                if [[ -n "$inactive_displays" ]]; then
                    echo "   Inactive displays: $inactive_displays"
                fi
            else
                echo "   ✗ xrandr is not working"
            fi
        fi
    fi
    
    # Check display connections
    echo ""
    echo "5. Display Connection Status:"
    
    if [[ "$XDG_SESSION_TYPE" == "x11" ]] && command -v xrandr >/dev/null 2>&1; then
        xrandr --query | grep -E "(connected|disconnected)" | while read output status rest; do
            echo "   $output: $status"
        done
    elif [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
        local compositor=$(detect_wayland_compositor)
        case "$compositor" in
            "sway")
                if command -v swaymsg >/dev/null 2>&1; then
                    swaymsg -t get_outputs | jq -r '.[] | "   \(.name): \(.active)"'
                fi
                ;;
            *)
                echo "   Wayland compositor: $compositor (manual check required)"
                ;;
        esac
    fi
    
    # Check for common configuration files
    echo ""
    echo "6. Configuration Files:"
    local config_files=(
        "/etc/X11/xorg.conf"
        "/etc/X11/xorg.conf.d/"
        "$HOME/.config/monitors.xml"
        "$HOME/.screenlayout/"
    )
    
    for config in "${config_files[@]}"; do
        if [[ -e "$config" ]]; then
            echo "   ✓ $config exists"
        else
            echo "   - $config not found"
        fi
    done
    
    # Performance check
    echo ""
    echo "7. Performance Indicators:"
    
    # Check GPU temperature (if available)
    if command -v nvidia-smi >/dev/null 2>&1; then
        local temp=$(nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits)
        echo "   GPU Temperature: ${temp}°C"
    elif [[ -f /sys/class/drm/card0/device/hwmon/hwmon0/temp1_input ]]; then
        local temp=$(($(cat /sys/class/drm/card0/device/hwmon/hwmon0/temp1_input) / 1000))
        echo "   GPU Temperature: ${temp}°C"
    fi
    
    # Check for compositor issues
    if command -v glxinfo >/dev/null 2>&1; then
        local renderer=$(glxinfo | grep "OpenGL renderer" | cut -d':' -f2 | xargs)
        echo "   OpenGL Renderer: $renderer"
        
        # Check for software rendering
        if echo "$renderer" | grep -qi "llvmpipe\|software"; then
            echo "   ⚠ Software rendering detected (poor performance)"
        fi
    fi
}

# Fix common display issues
fix_display_issues() {
    echo "Display Issue Auto-Fix"
    echo "====================="
    
    local issue_type="$1"
    
    case "$issue_type" in
        "no_display")
            echo "Fixing no display issue..."
            
            # Try to restart display manager
            echo "Restarting display manager..."
            sudo systemctl restart display-manager
            
            # Reset xrandr if X11
            if [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
                echo "Resetting display configuration..."
                xrandr --auto
            fi
            ;;
            
        "resolution")
            echo "Fixing resolution issues..."
            
            # Get primary display
            local primary_display=""
            if [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
                primary_display=$(xrandr --query | grep " connected primary" | cut -d' ' -f1)
                if [[ -z "$primary_display" ]]; then
                    primary_display=$(xrandr --query | grep " connected" | head -1 | cut -d' ' -f1)
                fi
                
                if [[ -n "$primary_display" ]]; then
                    echo "Setting auto resolution for $primary_display"
                    xrandr --output "$primary_display" --auto
                fi
            fi
            ;;
            
        "multi_monitor")
            echo "Fixing multi-monitor setup..."
            
            if [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
                # Turn on all connected displays
                xrandr --query | grep " connected" | cut -d' ' -f1 | while read output; do
                    echo "Enabling $output"
                    xrandr --output "$output" --auto
                done
                
                # Arrange displays horizontally
                local displays=($(xrandr --query | grep " connected" | cut -d' ' -f1))
                if [[ ${#displays[@]} -gt 1 ]]; then
                    xrandr --output "${displays[0]}" --primary
                    
                    local prev_display="${displays[0]}"
                    for display in "${displays[@]:1}"; do
                        xrandr --output "$display" --right-of "$prev_display"
                        prev_display="$display"
                    done
                fi
            fi
            ;;
            
        "driver")
            echo "Fixing graphics driver issues..."
            
            # Reinstall graphics drivers
            local gpu_vendor=$(lspci | grep -E "(VGA|3D)" | head -1)
            
            if echo "$gpu_vendor" | grep -qi nvidia; then
                echo "Reinstalling NVIDIA drivers..."
                sudo apt purge -y 'nvidia-*'
                sudo apt autoremove -y
                sudo apt install -y nvidia-driver-525
                
            elif echo "$gpu_vendor" | grep -qi intel; then
                echo "Reinstalling Intel drivers..."
                sudo apt install -y --reinstall xserver-xorg-video-intel
                
            elif echo "$gpu_vendor" | grep -qi "amd\|ati"; then
                echo "Reinstalling AMD drivers..."
                sudo apt install -y --reinstall xserver-xorg-video-amdgpu
            fi
            
            echo "Please reboot to complete driver installation"
            ;;
            
        "config")
            echo "Resetting display configuration..."
            
            # Backup existing configs
            local backup_dir="$HOME/.config/display-backup-$(date +%Y%m%d-%H%M%S)"
            mkdir -p "$backup_dir"
            
            # Backup X11 configs
            if [[ -f "$HOME/.config/monitors.xml" ]]; then
                cp "$HOME/.config/monitors.xml" "$backup_dir/"
                rm -f "$HOME/.config/monitors.xml"
            fi
            
            if [[ -d "$HOME/.screenlayout" ]]; then
                cp -r "$HOME/.screenlayout" "$backup_dir/"
                rm -rf "$HOME/.screenlayout"
            fi
            
            # Reset xrandr
            if [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
                xrandr --auto
            fi
            
            echo "Configuration reset complete. Backup saved to: $backup_dir"
            ;;
            
        *)
            echo "Unknown issue type. Available options:"
            echo "  no_display    - Fix when no display is shown"
            echo "  resolution    - Fix resolution problems"
            echo "  multi_monitor - Fix multi-monitor setup"
            echo "  driver        - Reinstall graphics drivers"
            echo "  config        - Reset display configuration"
            ;;
    esac
}

# Display testing utilities
test_display_functionality() {
    echo "Display Functionality Test"
    echo "========================="
    
    # Test pattern display
    echo "1. Testing display patterns..."
    
    if command -v xrandr >/dev/null 2>&1 && [[ "$XDG_SESSION_TYPE" == "x11" ]]; then
        # Create test patterns for each display
        xrandr --query | grep " connected" | cut -d' ' -f1 | while read output; do
            echo "Testing $output..."
            
            # Get current resolution
            local resolution=$(xrandr --query | grep "^$output" | grep -o '[0-9]*x[0-9]*' | head -1)
            
            if [[ -n "$resolution" ]]; then
                # Test with a simple color pattern
                if command -v xwininfo >/dev/null 2>&1; then
                    echo "  Current resolution: $resolution"
                    echo "  Display is responsive"
                else
                    echo "  Cannot test display responsiveness (xwininfo not available)"
                fi
            fi
        done
    fi
    
    # Test OpenGL functionality
    echo ""
    echo "2. Testing OpenGL..."
    
    if command -v glxgears >/dev/null 2>&1; then
        echo "Running glxgears test (5 seconds)..."
        timeout 5 glxgears >/dev/null 2>&1 && echo "✓ OpenGL test passed" || echo "✗ OpenGL test failed"
    else
        echo "glxgears not available (install mesa-utils)"
    fi
    
    # Test video acceleration
    echo ""
    echo "3. Testing hardware acceleration..."
    
    if command -v vainfo >/dev/null 2>&1; then
        echo "VA-API support:"
        vainfo 2>/dev/null | grep -E "(vainfo|Trying|VAProfile)" | head -5
    else
        echo "vainfo not available (install vainfo for VA-API testing)"
    fi
    
    if command -v vdpauinfo >/dev/null 2>&1; then
        echo "VDPAU support:"
        vdpauinfo 2>/dev/null | grep -E "(display|Decoder|description)" | head -5
    else
        echo "vdpauinfo not available"
    fi
}

# Create diagnostic report
create_display_report() {
    local report_file="display_report_$(date +%Y%m%d_%H%M%S).txt"
    
    {
        echo "Linux Display Diagnostic Report"
        echo "Generated on: $(date)"
        echo "User: $(whoami)"
        echo "System: $(uname -a)"
        echo ""
        
        diagnose_display_issues
        
        echo ""
        echo "================================"
        echo "DETAILED INFORMATION"
        echo "================================"
        
        echo ""
        echo "xrandr output:"
        xrandr --query 2>&1 || echo "xrandr not available"
        
        echo ""
        echo "lspci graphics:"
        lspci | grep -E "(VGA|3D|Display)"
        
        echo ""
        echo "Loaded modules:"
        lsmod | grep -E "(drm|video|fb)"
        
        echo ""
        echo "X log errors (last 10):"
        if [[ -f /var/log/Xorg.0.log ]]; then
            grep "(EE)" /var/log/Xorg.0.log | tail -10 || echo "No errors found"
        else
            echo "X log not found"
        fi
        
        echo ""
        echo "dmesg graphics (last 20):"
        dmesg | grep -iE "(drm|graphics|display|hdmi|vga)" | tail -20
        
    } > "$report_file"
    
    echo "Diagnostic report saved to: $report_file"
}
```

This comprehensive Linux display management guide provides enterprise-level knowledge for configuring monitors, troubleshooting graphics issues, and managing complex multi-monitor setups across both X11 and Wayland environments, with advanced automation and diagnostic capabilities.