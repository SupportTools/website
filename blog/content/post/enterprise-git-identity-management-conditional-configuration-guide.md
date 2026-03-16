---
title: "Enterprise Git Identity Management: Multi-Account Configuration and Conditional Workflows Guide"
date: 2026-06-28T00:00:00-05:00
draft: false
tags: ["Git", "Identity Management", "Enterprise", "SSH", "DevOps", "Version Control", "Security"]
categories: ["DevOps", "Development", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master enterprise Git identity management with conditional configurations, SSH key strategies, and automated workflow patterns for managing multiple Git accounts across complex organizational structures."
more_link: "yes"
url: "/enterprise-git-identity-management-conditional-configuration-guide/"
---

Enterprise development environments frequently require developers to maintain multiple Git identities across different organizations, projects, and security contexts. Managing these identities effectively while maintaining security isolation and preventing credential leakage represents one of the most critical aspects of modern development workflow configuration.

Traditional approaches to multi-identity Git management often result in configuration conflicts, credential exposure, and operational complexity that impacts developer productivity. Understanding advanced Git configuration patterns, conditional includes, and automated identity switching enables teams to build robust development workflows that seamlessly handle complex organizational requirements.

<!--more-->

## Executive Summary

Enterprise Git identity management requires sophisticated configuration strategies that balance security, usability, and operational efficiency. This comprehensive guide covers conditional Git configuration, SSH key management, automated identity switching, and enterprise-scale workflow patterns that ensure proper identity isolation while maintaining developer productivity across complex multi-account scenarios.

## Git Identity Architecture and Configuration Model

### Understanding Conditional Configuration

Git's conditional include mechanism provides powerful capabilities for context-aware configuration management:

```bash
# Primary Git configuration (~/.gitconfig)
[user]
    name = John Developer
    email = john@personal.domain

# Conditional includes for different contexts
[includeIf "gitdir:~/Work/"]
    path = ~/Work/.gitconfig

[includeIf "gitdir:~/Projects/Enterprise/"]
    path = ~/Projects/Enterprise/.gitconfig

[includeIf "gitdir:~/OpenSource/"]
    path = ~/OpenSource/.gitconfig

[includeIf "gitdir:/opt/client-projects/"]
    path = /opt/client-projects/.gitconfig

# Advanced conditional patterns
[includeIf "gitdir/i:~/Work/**/.git"]
    path = ~/Work/.gitconfig-work

[includeIf "hasconfig:remote.*.url:git@github.com-work:*/**"]
    path = ~/.gitconfig-github-work

[includeIf "hasconfig:remote.*.url:git@gitlab.company.internal:*/**"]
    path = ~/.gitconfig-gitlab-internal

# Global settings that apply everywhere
[core]
    editor = vim
    autocrlf = false
    filemode = true

[init]
    defaultBranch = main

[pull]
    rebase = true

[push]
    default = current
    autoSetupRemote = true

[merge]
    tool = vimdiff
    conflictstyle = diff3

[diff]
    algorithm = histogram
    colorMoved = default

[log]
    abbrevCommit = true
    decorate = short

[status]
    showUntrackedFiles = all

[branch]
    autosetupmerge = always
    autosetuprebase = always
```

### Environment-Specific Configuration Files

Create comprehensive configuration files for different working contexts:

```bash
# Work configuration (~/.gitconfig-work)
[user]
    name = John Developer
    email = john.developer@company.com
    signingkey = ~/.ssh/id_work.pub

[core]
    sshCommand = ssh -i ~/.ssh/id_work -o IdentitiesOnly=yes -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa

[commit]
    gpgsign = true
    template = ~/Work/.gitmessage-work

[url "git@github.com-work:"]
    insteadOf = https://github.com/
    insteadOf = git@github.com:

[url "git@gitlab.company.internal:"]
    insteadOf = https://gitlab.company.internal/

# Work-specific aliases
[alias]
    work-status = "!git status --porcelain | grep -E '^(M|A|D|R|C|U)' | wc -l | xargs echo 'Modified files:'"
    work-log = log --oneline --graph --decorate -10
    work-sync = "!f() { git fetch origin && git rebase origin/$(git branch --show-current); }; f"

# Enterprise security settings
[protocol]
    version = 2

[transfer]
    fsckobjects = true

[fetch]
    fsckobjects = true

[receive]
    fsckObjects = true

# Advanced work configuration
[branch "main"]
    remote = origin
    merge = refs/heads/main
    rebase = true

[branch "develop"]
    remote = origin
    merge = refs/heads/develop
    rebase = true
```

```bash
# Personal configuration (~/.gitconfig-personal)
[user]
    name = John Developer
    email = john@personal.domain
    signingkey = ~/.ssh/id_personal.pub

[core]
    sshCommand = ssh -i ~/.ssh/id_personal -o IdentitiesOnly=yes

[commit]
    gpgsign = true
    template = ~/.gitmessage-personal

[url "git@github.com-personal:"]
    insteadOf = https://github.com/
    insteadOf = git@github.com:

# Personal development aliases
[alias]
    personal-log = log --pretty=format:'%h %ad | %s%d [%an]' --graph --date=short
    personal-amend = commit --amend --no-edit
    personal-force = push --force-with-lease

# Relaxed settings for personal projects
[pull]
    ff = only

[merge]
    ff = false
```

```bash
# Client project configuration (/opt/client-projects/.gitconfig)
[user]
    name = John Developer - ClientCorp Contractor
    email = john.developer@contractor.clientcorp.com
    signingkey = ~/.ssh/id_client.pub

[core]
    sshCommand = ssh -i ~/.ssh/id_client -o IdentitiesOnly=yes -o HostKeyAlgorithms=+ssh-rsa

[commit]
    gpgsign = true
    template = /opt/client-projects/.gitmessage-client

[url "git@client-gitlab.clientcorp.internal:"]
    insteadOf = https://client-gitlab.clientcorp.internal/

# Client-specific workflow aliases
[alias]
    client-prepare = "!f() { git fetch && git rebase origin/$(git branch --show-current) && git push --force-with-lease; }; f"
    client-review = "!f() { git log --oneline origin/$(git branch --show-current)..HEAD; }; f"

# Strict client security requirements
[protocol]
    version = 2

[transfer]
    fsckobjects = true

[fetch]
    fsckobjects = true

[receive]
    fsckObjects = true
```

## SSH Key Management and Configuration

### Comprehensive SSH Key Generation Strategy

Generate and manage SSH keys for different organizational contexts:

```bash
#!/bin/bash
# Script: generate-git-ssh-keys.sh
# Purpose: Generate SSH keys for different Git identities

set -euo pipefail

# Configuration
SSH_DIR="$HOME/.ssh"
KEY_TYPE="ed25519"
KEY_SIZE="256"  # For ed25519
BACKUP_DIR="$SSH_DIR/backups"

# Identity contexts
declare -A IDENTITIES=(
    ["work"]="john.developer@company.com"
    ["personal"]="john@personal.domain"
    ["client"]="john.developer@contractor.clientcorp.com"
    ["opensource"]="john.developer@opensource.community"
    ["github-enterprise"]="john.developer@github.company.com"
)

# Host configurations
declare -A HOST_CONFIGS=(
    ["work"]="github.com-work gitlab.company.internal"
    ["personal"]="github.com-personal"
    ["client"]="client-gitlab.clientcorp.internal"
    ["opensource"]="github.com-opensource gitlab.com-opensource"
    ["github-enterprise"]="github.company.com"
)

function generate_ssh_key() {
    local context="$1"
    local email="${IDENTITIES[$context]}"
    local key_name="id_${context}"
    local key_path="$SSH_DIR/$key_name"

    echo "🔑 Generating SSH key for $context ($email)"

    # Create backup if key exists
    if [[ -f "$key_path" ]]; then
        mkdir -p "$BACKUP_DIR"
        local timestamp=$(date +%Y%m%d_%H%M%S)
        cp "$key_path" "$BACKUP_DIR/${key_name}_${timestamp}"
        cp "$key_path.pub" "$BACKUP_DIR/${key_name}.pub_${timestamp}"
        echo "💾 Backed up existing key to $BACKUP_DIR"
    fi

    # Generate new key
    ssh-keygen -t "$KEY_TYPE" -f "$key_path" -N "" -C "$email"

    # Set proper permissions
    chmod 600 "$key_path"
    chmod 644 "$key_path.pub"

    echo "✅ Generated SSH key: $key_path"
    echo "🔑 Fingerprint: $(ssh-keygen -lf "$key_path")"
    echo "📋 Public key:"
    cat "$key_path.pub"
    echo ""
}

function update_ssh_config() {
    local context="$1"
    local key_name="id_${context}"
    local hosts="${HOST_CONFIGS[$context]}"
    local config_file="$SSH_DIR/config"
    local temp_config=$(mktemp)

    echo "⚙️  Updating SSH configuration for $context"

    # Preserve existing configuration, remove old entries for this context
    if [[ -f "$config_file" ]]; then
        awk -v context="$context" '
            BEGIN { skip=0; context_pattern="^Host.*-" context "$" }
            $0 ~ context_pattern { skip=1; next }
            /^Host / && skip { skip=0 }
            !skip { print }
        ' "$config_file" > "$temp_config"
    fi

    # Add configuration for each host
    for host in $hosts; do
        cat >> "$temp_config" <<EOF

Host $host
    HostName $(echo "$host" | cut -d'-' -f1)
    User git
    IdentityFile ~/.ssh/$key_name
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    HashKnownHosts yes
    ServerAliveInterval 60
    ServerAliveCountMax 3
    TCPKeepAlive yes
    Compression yes
EOF

        # Add special configuration for enterprise hosts
        if [[ "$host" == *"company"* || "$host" == *"internal"* ]]; then
            cat >> "$temp_config" <<EOF
    HostKeyAlgorithms +ssh-rsa
    PubkeyAcceptedKeyTypes +ssh-rsa
    KexAlgorithms diffie-hellman-group14-sha256,diffie-hellman-group16-sha512
EOF
        fi
    done

    # Replace configuration
    mv "$temp_config" "$config_file"
    chmod 600 "$config_file"

    echo "✅ SSH configuration updated for $context"
}

function test_ssh_connectivity() {
    local context="$1"
    local hosts="${HOST_CONFIGS[$context]}"

    echo "🧪 Testing SSH connectivity for $context"

    for host in $hosts; do
        local hostname=$(echo "$host" | cut -d'-' -f1)
        echo "Testing $hostname via $host..."

        if ssh -T "$host" 2>&1 | grep -q "successfully authenticated\|Welcome"; then
            echo "✅ $hostname: Connection successful"
        else
            echo "⚠️  $hostname: Connection failed or key not configured"
        fi
    done
}

function display_public_keys() {
    echo "📋 Public Keys for Repository Configuration"
    echo "==========================================="

    for context in "${!IDENTITIES[@]}"; do
        local key_name="id_${context}"
        local key_path="$SSH_DIR/$key_name.pub"

        if [[ -f "$key_path" ]]; then
            echo ""
            echo "Context: $context (${IDENTITIES[$context]})"
            echo "Key: $key_name"
            echo "Fingerprint: $(ssh-keygen -lf "$key_path" 2>/dev/null || echo 'Invalid key')"
            echo "Public Key:"
            cat "$key_path"
        fi
    done
}

function audit_ssh_keys() {
    echo "📊 SSH Key Audit Report"
    echo "======================"

    for context in "${!IDENTITIES[@]}"; do
        local key_name="id_${context}"
        local key_path="$SSH_DIR/$key_name"

        echo ""
        echo "Context: $context"
        echo "Email: ${IDENTITIES[$context]}"

        if [[ -f "$key_path" ]]; then
            local creation_date=$(stat -c %y "$key_path" 2>/dev/null || echo "Unknown")
            local fingerprint=$(ssh-keygen -lf "$key_path" 2>/dev/null || echo "Invalid key")

            echo "Status: ✅ Present"
            echo "Created: $creation_date"
            echo "Fingerprint: $fingerprint"

            # Check key strength
            if echo "$fingerprint" | grep -q "ED25519"; then
                echo "Security: ✅ Strong (ED25519)"
            elif echo "$fingerprint" | grep -qE "409[0-9]|[0-9]{4,}.*RSA"; then
                echo "Security: ✅ Strong (RSA 4096+)"
            else
                echo "Security: ⚠️  Consider upgrading to ED25519 or RSA 4096+"
            fi
        else
            echo "Status: ❌ Missing"
        fi
    done
}

# Main execution
case "${1:-help}" in
    "generate")
        if [[ -n "${2:-}" && "${IDENTITIES[${2}]+x}" ]]; then
            generate_ssh_key "$2"
            update_ssh_config "$2"
        else
            echo "Generating all SSH keys..."
            for context in "${!IDENTITIES[@]}"; do
                generate_ssh_key "$context"
                update_ssh_config "$context"
            done
        fi
        ;;
    "test")
        if [[ -n "${2:-}" && "${IDENTITIES[${2}]+x}" ]]; then
            test_ssh_connectivity "$2"
        else
            for context in "${!IDENTITIES[@]}"; do
                test_ssh_connectivity "$context"
            done
        fi
        ;;
    "show-keys")
        display_public_keys
        ;;
    "audit")
        audit_ssh_keys
        ;;
    "list")
        echo "Available identity contexts:"
        for context in "${!IDENTITIES[@]}"; do
            echo "  $context: ${IDENTITIES[$context]}"
        done
        ;;
    *)
        echo "Usage: $0 {generate|test|show-keys|audit|list} [context]"
        echo ""
        echo "Available contexts: ${!IDENTITIES[*]}"
        echo ""
        echo "Commands:"
        echo "  generate [context] - Generate SSH keys for context (or all)"
        echo "  test [context]     - Test SSH connectivity for context (or all)"
        echo "  show-keys          - Display all public keys"
        echo "  audit              - Audit all SSH keys"
        echo "  list               - List available contexts"
        ;;
esac
```

## Advanced Directory Structure and Workflow Patterns

### Organized Development Environment

Create a structured approach to organizing repositories:

```bash
#!/bin/bash
# Script: setup-git-workspace.sh
# Purpose: Set up organized Git workspace with identity management

set -euo pipefail

# Workspace configuration
WORKSPACE_ROOT="$HOME/Development"
WORK_ROOT="$HOME/Work"
CLIENT_ROOT="/opt/client-projects"

# Directory structure
declare -A WORKSPACE_DIRS=(
    ["personal"]="$WORKSPACE_ROOT/Personal"
    ["opensource"]="$WORKSPACE_ROOT/OpenSource"
    ["experiments"]="$WORKSPACE_ROOT/Experiments"
    ["work"]="$WORK_ROOT"
    ["work-internal"]="$WORK_ROOT/Internal"
    ["work-external"]="$WORK_ROOT/External"
    ["client"]="$CLIENT_ROOT"
    ["client-active"]="$CLIENT_ROOT/Active"
    ["client-archived"]="$CLIENT_ROOT/Archived"
)

function create_workspace_structure() {
    echo "🏗️  Creating workspace directory structure"

    for context in "${!WORKSPACE_DIRS[@]}"; do
        local dir="${WORKSPACE_DIRS[$context]}"
        echo "Creating: $dir"
        mkdir -p "$dir"

        # Set appropriate permissions
        if [[ "$dir" == *"client"* ]]; then
            chmod 750 "$dir"
        else
            chmod 755 "$dir"
        fi
    done

    # Create additional organizational directories
    for context in personal work client; do
        local base_dir="${WORKSPACE_DIRS[$context]}"
        for subdir in "active" "archived" "forks" "contrib"; do
            mkdir -p "$base_dir/$subdir"
        done
    done

    echo "✅ Workspace structure created"
}

function setup_context_configurations() {
    echo "⚙️  Setting up context-specific Git configurations"

    # Personal configuration
    cat > "${WORKSPACE_DIRS[personal]}/.gitconfig" <<EOF
[user]
    name = John Developer
    email = john@personal.domain
    signingkey = ~/.ssh/id_personal.pub

[core]
    sshCommand = ssh -i ~/.ssh/id_personal -o IdentitiesOnly=yes

[commit]
    gpgsign = true

[url "git@github.com-personal:"]
    insteadOf = https://github.com/
    insteadOf = git@github.com:

[alias]
    personal-quick-commit = "!f() { git add -A && git commit -m \"\$1\" && git push; }; f"
    personal-sync = "!git fetch origin && git rebase origin/\$(git branch --show-current)"
EOF

    # Work configuration
    cat > "${WORKSPACE_DIRS[work]}/.gitconfig" <<EOF
[user]
    name = John Developer
    email = john.developer@company.com
    signingkey = ~/.ssh/id_work.pub

[core]
    sshCommand = ssh -i ~/.ssh/id_work -o IdentitiesOnly=yes -o HostKeyAlgorithms=+ssh-rsa

[commit]
    gpgsign = true
    template = ${WORKSPACE_DIRS[work]}/.gitmessage

[url "git@github.com-work:"]
    insteadOf = https://github.com/
    insteadOf = git@github.com:

[url "git@gitlab.company.internal:"]
    insteadOf = https://gitlab.company.internal/

[alias]
    work-review = "!f() { git log --oneline --graph --decorate origin/\$(git branch --show-current)..HEAD; }; f"
    work-prepare = "!f() { git fetch && git rebase origin/\$(git branch --show-current); }; f"
EOF

    # Client configuration
    cat > "${WORKSPACE_DIRS[client]}/.gitconfig" <<EOF
[user]
    name = John Developer - ClientCorp Contractor
    email = john.developer@contractor.clientcorp.com
    signingkey = ~/.ssh/id_client.pub

[core]
    sshCommand = ssh -i ~/.ssh/id_client -o IdentitiesOnly=yes

[commit]
    gpgsign = true
    template = ${WORKSPACE_DIRS[client]}/.gitmessage

[url "git@client-gitlab.clientcorp.internal:"]
    insteadOf = https://client-gitlab.clientcorp.internal/

[alias]
    client-status = "!git status --porcelain | wc -l | xargs echo 'Modified files:'"
    client-sync = "!git fetch origin && git rebase origin/\$(git branch --show-current)"
EOF

    echo "✅ Context configurations created"
}

function create_commit_templates() {
    echo "📝 Creating commit message templates"

    # Work commit template
    cat > "${WORKSPACE_DIRS[work]}/.gitmessage" <<EOF
# [TICKET-123] Brief description of changes
#
# Longer description of what was changed and why
#
# - Bullet points for detailed changes
# - Reference any related tickets or issues
#
# Closes: #123
# Fixes: TICKET-456
# Related: EPIC-789
EOF

    # Client commit template
    cat > "${WORKSPACE_DIRS[client]}/.gitmessage" <<EOF
# [CLIENT-TICKET] Brief description of changes
#
# Business justification and impact
#
# Technical changes:
# - Specific implementation details
# - Performance implications
# - Security considerations
#
# Testing:
# - Unit tests added/updated
# - Integration tests verified
# - Manual testing completed
#
# Closes: CLIENT-123
# Approved-by: Client Representative
EOF

    echo "✅ Commit templates created"
}

function setup_workspace_scripts() {
    echo "🔧 Setting up workspace utility scripts"

    # Create workspace switcher
    cat > "$WORKSPACE_ROOT/../git-switch-context.sh" <<'EOF'
#!/bin/bash
# Git context switcher utility

set -euo pipefail

CONTEXTS=(
    "personal:$HOME/Development/Personal"
    "work:$HOME/Work"
    "client:/opt/client-projects"
    "opensource:$HOME/Development/OpenSource"
)

function switch_context() {
    local context="$1"

    for ctx_info in "${CONTEXTS[@]}"; do
        local ctx_name="${ctx_info%%:*}"
        local ctx_path="${ctx_info##*:}"

        if [[ "$ctx_name" == "$context" ]]; then
            echo "🔄 Switching to $context context"
            echo "📁 Directory: $ctx_path"
            cd "$ctx_path"

            # Display current Git configuration
            echo "👤 Git identity:"
            git config user.name 2>/dev/null || echo "  Name: Not configured"
            git config user.email 2>/dev/null || echo "  Email: Not configured"

            exec "$SHELL"
            return 0
        fi
    done

    echo "❌ Unknown context: $context"
    echo "Available contexts: $(printf '%s ' "${CONTEXTS[@]}" | sed 's/:.*//g')"
    return 1
}

# Main execution
if [[ $# -eq 0 ]]; then
    echo "Available contexts:"
    for ctx_info in "${CONTEXTS[@]}"; do
        local ctx_name="${ctx_info%%:*}"
        local ctx_path="${ctx_info##*:}"
        echo "  $ctx_name -> $ctx_path"
    done
else
    switch_context "$1"
fi
EOF

    chmod +x "$WORKSPACE_ROOT/../git-switch-context.sh"

    # Create repository cloner with context awareness
    cat > "$WORKSPACE_ROOT/../git-smart-clone.sh" <<'EOF'
#!/bin/bash
# Smart Git clone with automatic context detection

set -euo pipefail

function smart_clone() {
    local repo_url="$1"
    local target_dir="${2:-}"

    # Determine context based on URL
    local context=""
    local base_dir=""

    if [[ "$repo_url" == *"github.com-work"* || "$repo_url" == *"gitlab.company.internal"* ]]; then
        context="work"
        base_dir="$HOME/Work"
    elif [[ "$repo_url" == *"github.com-personal"* ]]; then
        context="personal"
        base_dir="$HOME/Development/Personal"
    elif [[ "$repo_url" == *"client-gitlab.clientcorp.internal"* ]]; then
        context="client"
        base_dir="/opt/client-projects"
    else
        context="opensource"
        base_dir="$HOME/Development/OpenSource"
    fi

    # Extract repository name
    local repo_name=$(basename "$repo_url" .git)

    # Set target directory
    if [[ -z "$target_dir" ]]; then
        target_dir="$base_dir/$repo_name"
    else
        target_dir="$base_dir/$target_dir"
    fi

    echo "🔄 Cloning to $context context"
    echo "📁 Target: $target_dir"

    # Clone repository
    git clone "$repo_url" "$target_dir"

    # Navigate to repository and display configuration
    cd "$target_dir"
    echo "✅ Repository cloned successfully"
    echo "👤 Git identity:"
    git config user.name
    git config user.email
}

# Main execution
if [[ $# -eq 0 ]]; then
    echo "Usage: $0 <repository-url> [target-directory]"
    echo ""
    echo "Context detection based on URL:"
    echo "  *github.com-work*, *gitlab.company.internal* -> work"
    echo "  *github.com-personal* -> personal"
    echo "  *client-gitlab.clientcorp.internal* -> client"
    echo "  Default -> opensource"
else
    smart_clone "$@"
fi
EOF

    chmod +x "$WORKSPACE_ROOT/../git-smart-clone.sh"

    echo "✅ Workspace scripts created"
}

# Main execution
case "${1:-setup}" in
    "setup")
        create_workspace_structure
        setup_context_configurations
        create_commit_templates
        setup_workspace_scripts
        echo "🎉 Workspace setup completed"
        ;;
    "structure")
        create_workspace_structure
        ;;
    "configs")
        setup_context_configurations
        ;;
    "templates")
        create_commit_templates
        ;;
    "scripts")
        setup_workspace_scripts
        ;;
    *)
        echo "Usage: $0 {setup|structure|configs|templates|scripts}"
        ;;
esac
```

## Automated Identity Validation and Monitoring

### Git Hook Implementation

Implement comprehensive Git hooks for identity validation:

```bash
#!/bin/bash
# Script: setup-git-hooks.sh
# Purpose: Set up Git hooks for identity validation

set -euo pipefail

function install_pre_commit_hook() {
    local repo_dir="$1"
    local hook_file="$repo_dir/.git/hooks/pre-commit"

    cat > "$hook_file" <<'EOF'
#!/bin/bash
# Pre-commit hook for Git identity validation

set -euo pipefail

# Get current Git configuration
CURRENT_NAME=$(git config user.name 2>/dev/null || echo "")
CURRENT_EMAIL=$(git config user.email 2>/dev/null || echo "")

# Detect repository context based on path
REPO_PATH=$(pwd)
CONTEXT=""

if [[ "$REPO_PATH" == *"/Work/"* ]]; then
    CONTEXT="work"
    EXPECTED_DOMAIN="company.com"
elif [[ "$REPO_PATH" == *"/client-projects/"* ]]; then
    CONTEXT="client"
    EXPECTED_DOMAIN="clientcorp.com"
elif [[ "$REPO_PATH" == *"/Personal/"* ]]; then
    CONTEXT="personal"
    EXPECTED_DOMAIN="personal.domain"
else
    CONTEXT="opensource"
    EXPECTED_DOMAIN=""
fi

# Validate identity
function validate_identity() {
    if [[ -z "$CURRENT_NAME" || -z "$CURRENT_EMAIL" ]]; then
        echo "❌ Git identity not configured"
        echo "Current directory: $REPO_PATH"
        echo "Expected context: $CONTEXT"
        echo ""
        echo "Configure your identity with:"
        echo "  git config user.name 'Your Name'"
        echo "  git config user.email 'your.email@domain.com'"
        return 1
    fi

    if [[ -n "$EXPECTED_DOMAIN" && "$CURRENT_EMAIL" != *"$EXPECTED_DOMAIN"* ]]; then
        echo "⚠️  Email domain mismatch detected"
        echo "Context: $CONTEXT"
        echo "Current email: $CURRENT_EMAIL"
        echo "Expected domain: $EXPECTED_DOMAIN"
        echo ""
        echo "Continue anyway? (y/N)"
        read -r response
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            return 1
        fi
    fi

    echo "✅ Git identity validated"
    echo "Context: $CONTEXT"
    echo "Name: $CURRENT_NAME"
    echo "Email: $CURRENT_EMAIL"
    return 0
}

# Check for sensitive information in commits
function check_sensitive_content() {
    local staged_files=$(git diff --cached --name-only)
    local sensitive_patterns=(
        "password\s*=\s*['\"].*['\"]"
        "api[_-]?key\s*=\s*['\"].*['\"]"
        "secret\s*=\s*['\"].*['\"]"
        "token\s*=\s*['\"].*['\"]"
        "aws_access_key_id"
        "aws_secret_access_key"
        "-----BEGIN PRIVATE KEY-----"
        "-----BEGIN RSA PRIVATE KEY-----"
    )

    for file in $staged_files; do
        if [[ -f "$file" ]]; then
            for pattern in "${sensitive_patterns[@]}"; do
                if grep -qiE "$pattern" "$file"; then
                    echo "🚨 Potential sensitive information detected in $file"
                    echo "Pattern: $pattern"
                    echo ""
                    echo "Review the file and remove sensitive information before committing."
                    return 1
                fi
            done
        fi
    done

    return 0
}

# Main validation
validate_identity || exit 1
check_sensitive_content || exit 1

echo "🎉 Pre-commit validation passed"
EOF

    chmod +x "$hook_file"
    echo "✅ Pre-commit hook installed in $repo_dir"
}

function install_commit_msg_hook() {
    local repo_dir="$1"
    local hook_file="$repo_dir/.git/hooks/commit-msg"

    cat > "$hook_file" <<'EOF'
#!/bin/bash
# Commit message hook for format validation

set -euo pipefail

COMMIT_MSG_FILE="$1"
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Get repository context
REPO_PATH=$(pwd)
CONTEXT=""

if [[ "$REPO_PATH" == *"/Work/"* ]]; then
    CONTEXT="work"
elif [[ "$REPO_PATH" == *"/client-projects/"* ]]; then
    CONTEXT="client"
else
    CONTEXT="personal"
fi

function validate_commit_message() {
    local msg="$1"

    # Skip merge commits
    if [[ "$msg" =~ ^Merge ]]; then
        return 0
    fi

    # Context-specific validation
    case "$CONTEXT" in
        "work")
            # Require ticket reference for work commits
            if [[ ! "$msg" =~ \[.*-[0-9]+\] ]]; then
                echo "❌ Work commits must include ticket reference"
                echo "Format: [TICKET-123] Description"
                echo ""
                echo "Current message:"
                echo "$msg"
                return 1
            fi
            ;;
        "client")
            # Require client ticket reference
            if [[ ! "$msg" =~ \[CLIENT-.*\] ]]; then
                echo "❌ Client commits must include CLIENT ticket reference"
                echo "Format: [CLIENT-TICKET] Description"
                echo ""
                echo "Current message:"
                echo "$msg"
                return 1
            fi
            ;;
    esac

    # General validation
    local first_line=$(echo "$msg" | head -1)
    if [[ ${#first_line} -gt 72 ]]; then
        echo "⚠️  First line is longer than 72 characters (${#first_line})"
        echo "Consider shortening the summary line"
    fi

    return 0
}

validate_commit_message "$COMMIT_MSG" || exit 1
echo "✅ Commit message validated"
EOF

    chmod +x "$hook_file"
    echo "✅ Commit message hook installed in $repo_dir"
}

function setup_global_git_hooks() {
    local hooks_dir="$HOME/.git-templates/hooks"
    mkdir -p "$hooks_dir"

    # Set up global hook template directory
    git config --global init.templateDir "$HOME/.git-templates"

    # Create global pre-commit hook
    install_pre_commit_hook "$HOME/.git-templates"
    install_commit_msg_hook "$HOME/.git-templates"

    echo "✅ Global Git hooks configured"
    echo "New repositories will automatically include these hooks"
}

# Main execution
case "${1:-global}" in
    "global")
        setup_global_git_hooks
        ;;
    "install")
        if [[ -n "${2:-}" && -d "$2" ]]; then
            install_pre_commit_hook "$2"
            install_commit_msg_hook "$2"
        else
            echo "Usage: $0 install <repository-directory>"
        fi
        ;;
    *)
        echo "Usage: $0 {global|install} [repository-directory]"
        ;;
esac
```

## Enterprise Integration and Automation

### CI/CD Pipeline Integration

Integrate Git identity management with CI/CD systems:

```yaml
# .github/workflows/git-identity-validation.yml
name: Git Identity Validation

on:
  push:
    branches: [main, develop, staging]
  pull_request:
    branches: [main]

jobs:
  validate-git-identity:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Validate Git Identity Consistency
        run: |
          echo "🔍 Validating Git identity consistency"

          # Check commit author consistency
          AUTHORS=$(git log --format='%ae' origin/main..HEAD | sort -u)
          AUTHOR_COUNT=$(echo "$AUTHORS" | wc -l)

          if [[ $AUTHOR_COUNT -gt 1 ]]; then
            echo "⚠️  Multiple authors detected in this PR:"
            echo "$AUTHORS"
            echo ""
            echo "Ensure consistent Git identity configuration"
          fi

          # Validate author email domain
          EXPECTED_DOMAIN="${{ vars.EXPECTED_EMAIL_DOMAIN }}"
          if [[ -n "$EXPECTED_DOMAIN" ]]; then
            for author in $AUTHORS; do
              if [[ "$author" != *"$EXPECTED_DOMAIN"* ]]; then
                echo "❌ Invalid email domain: $author"
                echo "Expected domain: $EXPECTED_DOMAIN"
                exit 1
              fi
            done
          fi

          echo "✅ Git identity validation passed"

      - name: Check for Sensitive Information
        run: |
          echo "🔒 Scanning for sensitive information"

          SENSITIVE_PATTERNS=(
            'password\s*=\s*['"'"'"].*['"'"'"]'
            'api[_-]?key\s*=\s*['"'"'"].*['"'"'"]'
            'secret\s*=\s*['"'"'"].*['"'"'"]'
            'token\s*=\s*['"'"'"].*['"'"'"]'
            'aws_access_key_id'
            'aws_secret_access_key'
            '-----BEGIN PRIVATE KEY-----'
            '-----BEGIN RSA PRIVATE KEY-----'
          )

          VIOLATIONS=0
          for pattern in "${SENSITIVE_PATTERNS[@]}"; do
            if git log -p origin/main..HEAD | grep -qiE "$pattern"; then
              echo "🚨 Potential sensitive information detected: $pattern"
              VIOLATIONS=$((VIOLATIONS + 1))
            fi
          done

          if [[ $VIOLATIONS -gt 0 ]]; then
            echo "❌ $VIOLATIONS sensitive information violations detected"
            exit 1
          fi

          echo "✅ No sensitive information detected"

      - name: Validate Commit Message Format
        run: |
          echo "📝 Validating commit message format"

          COMMIT_MESSAGES=$(git log --format='%s' origin/main..HEAD)
          INVALID_COMMITS=0

          while IFS= read -r message; do
            # Skip merge commits
            if [[ "$message" =~ ^Merge ]]; then
              continue
            fi

            # Check for ticket reference (adjust pattern as needed)
            if [[ ! "$message" =~ ^\[[A-Z]+-[0-9]+\] ]]; then
              echo "⚠️  Commit missing ticket reference: $message"
              INVALID_COMMITS=$((INVALID_COMMITS + 1))
            fi

            # Check message length
            if [[ ${#message} -gt 72 ]]; then
              echo "⚠️  Commit message too long (${#message} chars): $message"
            fi
          done <<< "$COMMIT_MESSAGES"

          if [[ $INVALID_COMMITS -gt 0 ]]; then
            echo "💡 Consider using conventional commit format with ticket references"
          fi

          echo "✅ Commit message validation completed"
```

### Advanced Configuration Management

Implement enterprise-grade configuration management:

```bash
#!/bin/bash
# Script: enterprise-git-config-manager.sh
# Purpose: Enterprise Git configuration management

set -euo pipefail

# Configuration sources
CONFIG_REPO="git@github.com-work:company/git-configurations.git"
CONFIG_DIR="$HOME/.git-enterprise-configs"
BACKUP_DIR="$HOME/.git-config-backups"

# Organization settings
declare -A ORG_CONFIGS=(
    ["company"]="work"
    ["client-corp"]="client"
    ["personal"]="personal"
    ["opensource"]="opensource"
)

function sync_enterprise_configs() {
    echo "🔄 Syncing enterprise Git configurations"

    # Clone or update configuration repository
    if [[ -d "$CONFIG_DIR" ]]; then
        cd "$CONFIG_DIR"
        git pull origin main
    else
        git clone "$CONFIG_REPO" "$CONFIG_DIR"
        cd "$CONFIG_DIR"
    fi

    echo "✅ Enterprise configurations synchronized"
}

function backup_current_config() {
    echo "💾 Backing up current Git configuration"

    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$BACKUP_DIR/gitconfig_$timestamp"

    mkdir -p "$BACKUP_DIR"

    if [[ -f "$HOME/.gitconfig" ]]; then
        cp "$HOME/.gitconfig" "$backup_file"
        echo "Current .gitconfig backed up to: $backup_file"
    fi

    # Backup SSH configuration
    if [[ -f "$HOME/.ssh/config" ]]; then
        cp "$HOME/.ssh/config" "$BACKUP_DIR/ssh_config_$timestamp"
        echo "SSH config backed up to: $BACKUP_DIR/ssh_config_$timestamp"
    fi

    echo "✅ Configuration backup completed"
}

function apply_enterprise_config() {
    local org="$1"

    if [[ ! "${ORG_CONFIGS[$org]+x}" ]]; then
        echo "❌ Unknown organization: $org"
        echo "Available organizations: ${!ORG_CONFIGS[*]}"
        return 1
    fi

    local config_type="${ORG_CONFIGS[$org]}"
    local config_file="$CONFIG_DIR/configs/$config_type.gitconfig"

    echo "🔧 Applying $config_type configuration for $org"

    if [[ ! -f "$config_file" ]]; then
        echo "❌ Configuration file not found: $config_file"
        return 1
    fi

    # Backup current configuration
    backup_current_config

    # Apply new configuration
    cp "$config_file" "$HOME/.gitconfig"

    # Apply SSH configuration if available
    local ssh_config_file="$CONFIG_DIR/ssh/$config_type-ssh-config"
    if [[ -f "$ssh_config_file" ]]; then
        mkdir -p "$HOME/.ssh"

        # Merge SSH configurations
        if [[ -f "$HOME/.ssh/config" ]]; then
            cat "$HOME/.ssh/config" "$ssh_config_file" > "$HOME/.ssh/config.tmp"
            mv "$HOME/.ssh/config.tmp" "$HOME/.ssh/config"
        else
            cp "$ssh_config_file" "$HOME/.ssh/config"
        fi

        chmod 600 "$HOME/.ssh/config"
    fi

    echo "✅ Configuration applied successfully"
    echo "Organization: $org"
    echo "Config type: $config_type"

    # Display current configuration
    echo ""
    echo "📋 Current Git identity:"
    git config user.name 2>/dev/null || echo "  Name: Not configured"
    git config user.email 2>/dev/null || echo "  Email: Not configured"
}

function validate_configuration() {
    echo "🔍 Validating Git configuration"

    # Check basic configuration
    local name=$(git config --global user.name 2>/dev/null || echo "")
    local email=$(git config --global user.email 2>/dev/null || echo "")

    if [[ -z "$name" || -z "$email" ]]; then
        echo "⚠️  Basic Git identity not configured"
        return 1
    fi

    echo "✅ Basic configuration valid"
    echo "Name: $name"
    echo "Email: $email"

    # Validate SSH key availability
    local ssh_command=$(git config --global core.sshCommand 2>/dev/null || echo "")
    if [[ -n "$ssh_command" ]]; then
        local key_file=$(echo "$ssh_command" | grep -o '\-i [^ ]*' | cut -d' ' -f2)
        if [[ -f "$key_file" ]]; then
            echo "✅ SSH key available: $key_file"
            local fingerprint=$(ssh-keygen -lf "$key_file" 2>/dev/null || echo "Invalid")
            echo "Fingerprint: $fingerprint"
        else
            echo "⚠️  SSH key not found: $key_file"
        fi
    fi

    # Test connectivity
    echo "🧪 Testing Git connectivity"
    if git ls-remote origin HEAD >/dev/null 2>&1; then
        echo "✅ Git connectivity successful"
    else
        echo "⚠️  Git connectivity test failed"
    fi

    return 0
}

function list_available_configs() {
    echo "📋 Available Enterprise Configurations"
    echo "====================================="

    if [[ ! -d "$CONFIG_DIR/configs" ]]; then
        echo "❌ Configuration directory not found. Run 'sync' first."
        return 1
    fi

    for org in "${!ORG_CONFIGS[@]}"; do
        local config_type="${ORG_CONFIGS[$org]}"
        local config_file="$CONFIG_DIR/configs/$config_type.gitconfig"

        echo ""
        echo "Organization: $org"
        echo "Config type: $config_type"

        if [[ -f "$config_file" ]]; then
            echo "Status: ✅ Available"

            # Extract basic info from config
            local name=$(grep "name =" "$config_file" | head -1 | sed 's/.*= //' || echo "Not set")
            local email=$(grep "email =" "$config_file" | head -1 | sed 's/.*= //' || echo "Not set")

            echo "Name: $name"
            echo "Email: $email"
        else
            echo "Status: ❌ Missing"
        fi
    done
}

# Main execution
case "${1:-help}" in
    "sync")
        sync_enterprise_configs
        ;;
    "apply")
        if [[ -n "${2:-}" ]]; then
            apply_enterprise_config "$2"
        else
            echo "Usage: $0 apply <organization>"
            echo "Available organizations: ${!ORG_CONFIGS[*]}"
        fi
        ;;
    "validate")
        validate_configuration
        ;;
    "list")
        list_available_configs
        ;;
    "backup")
        backup_current_config
        ;;
    *)
        echo "Enterprise Git Configuration Manager"
        echo "===================================="
        echo ""
        echo "Usage: $0 {sync|apply|validate|list|backup}"
        echo ""
        echo "Commands:"
        echo "  sync              - Sync enterprise configurations from repository"
        echo "  apply <org>       - Apply configuration for organization"
        echo "  validate          - Validate current Git configuration"
        echo "  list              - List available configurations"
        echo "  backup            - Backup current configuration"
        echo ""
        echo "Available organizations: ${!ORG_CONFIGS[*]}"
        ;;
esac
```

## Troubleshooting and Debugging

### Identity Resolution Diagnostics

Comprehensive troubleshooting tools for Git identity issues:

```bash
#!/bin/bash
# Script: git-identity-diagnostics.sh
# Purpose: Diagnose Git identity and configuration issues

set -euo pipefail

function analyze_git_configuration() {
    echo "🔍 Analyzing Git Configuration"
    echo "============================="

    # Global configuration
    echo ""
    echo "📋 Global Configuration:"
    if git config --global --list 2>/dev/null; then
        echo "✅ Global configuration found"
    else
        echo "⚠️  No global configuration found"
    fi

    # Local configuration
    echo ""
    echo "📋 Local Configuration (current repository):"
    if git config --local --list 2>/dev/null; then
        echo "✅ Local configuration found"
    else
        echo "⚠️  No local configuration or not in a Git repository"
    fi

    # System configuration
    echo ""
    echo "📋 System Configuration:"
    if git config --system --list 2>/dev/null; then
        echo "✅ System configuration found"
    else
        echo "⚠️  No system configuration found"
    fi

    # Effective configuration
    echo ""
    echo "📋 Effective Configuration:"
    git config --list --show-origin 2>/dev/null | grep -E "(user\.|core\.sshCommand)" || echo "No user configuration found"
}

function check_identity_resolution() {
    echo ""
    echo "👤 Identity Resolution Analysis"
    echo "=============================="

    local current_dir=$(pwd)
    echo "Current directory: $current_dir"

    # Check conditional includes
    echo ""
    echo "🔍 Checking conditional includes:"
    git config --list --show-origin | grep "includeif\|includepath" || echo "No conditional includes found"

    # Current effective identity
    echo ""
    echo "📋 Current Effective Identity:"
    local name=$(git config user.name 2>/dev/null || echo "Not configured")
    local email=$(git config user.email 2>/dev/null || echo "Not configured")
    local signing_key=$(git config user.signingkey 2>/dev/null || echo "Not configured")

    echo "Name: $name"
    echo "Email: $email"
    echo "Signing Key: $signing_key"

    # SSH configuration
    echo ""
    echo "🔍 SSH Configuration:"
    local ssh_command=$(git config core.sshCommand 2>/dev/null || echo "Default")
    echo "SSH Command: $ssh_command"

    # Test identity in different directories
    echo ""
    echo "🧪 Testing identity resolution in different directories:"

    local test_dirs=(
        "$HOME/Work"
        "$HOME/Development/Personal"
        "/opt/client-projects"
        "$HOME/Development/OpenSource"
    )

    for test_dir in "${test_dirs[@]}"; do
        if [[ -d "$test_dir" ]]; then
            echo ""
            echo "Testing: $test_dir"
            cd "$test_dir" 2>/dev/null || continue

            local test_name=$(git config user.name 2>/dev/null || echo "Not configured")
            local test_email=$(git config user.email 2>/dev/null || echo "Not configured")

            echo "  Name: $test_name"
            echo "  Email: $test_email"
        else
            echo "Directory not found: $test_dir"
        fi
    done

    # Return to original directory
    cd "$current_dir"
}

function validate_ssh_configuration() {
    echo ""
    echo "🔐 SSH Configuration Validation"
    echo "==============================="

    local ssh_config_file="$HOME/.ssh/config"

    if [[ -f "$ssh_config_file" ]]; then
        echo "✅ SSH config file found: $ssh_config_file"

        # List configured hosts
        echo ""
        echo "📋 Configured SSH hosts:"
        grep "^Host " "$ssh_config_file" || echo "No hosts found"

        # Check key files
        echo ""
        echo "🔑 SSH key files:"
        local key_files=$(grep "IdentityFile" "$ssh_config_file" | awk '{print $2}' | sed 's|~|'"$HOME"'|g' | sort -u)

        for key_file in $key_files; do
            if [[ -f "$key_file" ]]; then
                local fingerprint=$(ssh-keygen -lf "$key_file" 2>/dev/null || echo "Invalid key")
                echo "  ✅ $key_file: $fingerprint"
            else
                echo "  ❌ $key_file: Not found"
            fi
        done
    else
        echo "⚠️  SSH config file not found: $ssh_config_file"
    fi

    # Test SSH connectivity
    echo ""
    echo "🧪 Testing SSH connectivity:"
    local ssh_hosts=("github.com" "gitlab.com")

    for host in "${ssh_hosts[@]}"; do
        echo "Testing $host..."
        if ssh -T "git@$host" 2>&1 | grep -q "successfully authenticated\|Welcome"; then
            echo "  ✅ $host: Connection successful"
        else
            echo "  ⚠️  $host: Connection failed or key not configured"
        fi
    done
}

function check_repository_specific_issues() {
    echo ""
    echo "📁 Repository-Specific Analysis"
    echo "=============================="

    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "⚠️  Not inside a Git repository"
        return 0
    fi

    # Repository information
    echo "Repository root: $(git rev-parse --show-toplevel)"
    echo "Current branch: $(git branch --show-current 2>/dev/null || echo 'Detached HEAD')"

    # Remote configuration
    echo ""
    echo "📡 Remote configuration:"
    git remote -v 2>/dev/null || echo "No remotes configured"

    # Recent commits and their authors
    echo ""
    echo "👥 Recent commit authors:"
    git log --format='%h %an <%ae> %s' -10 2>/dev/null || echo "No commits found"

    # Check for inconsistent authors
    echo ""
    echo "🔍 Checking for author inconsistencies:"
    local unique_authors=$(git log --format='%ae' --since="30 days ago" | sort -u)
    local author_count=$(echo "$unique_authors" | wc -l)

    if [[ $author_count -gt 1 ]]; then
        echo "⚠️  Multiple authors detected in recent commits:"
        echo "$unique_authors"
    else
        echo "✅ Consistent authorship detected"
    fi
}

function generate_diagnostic_report() {
    echo ""
    echo "📊 Generating Diagnostic Report"
    echo "==============================="

    local report_file="git-identity-diagnostic-$(date +%Y%m%d_%H%M%S).txt"

    {
        echo "Git Identity Diagnostic Report"
        echo "Generated: $(date)"
        echo "System: $(uname -a)"
        echo "Git version: $(git --version)"
        echo ""

        analyze_git_configuration
        check_identity_resolution
        validate_ssh_configuration
        check_repository_specific_issues

    } > "$report_file"

    echo "📄 Diagnostic report saved: $report_file"
}

# Main execution
case "${1:-full}" in
    "config")
        analyze_git_configuration
        ;;
    "identity")
        check_identity_resolution
        ;;
    "ssh")
        validate_ssh_configuration
        ;;
    "repo")
        check_repository_specific_issues
        ;;
    "report")
        generate_diagnostic_report
        ;;
    "full")
        analyze_git_configuration
        check_identity_resolution
        validate_ssh_configuration
        check_repository_specific_issues
        ;;
    *)
        echo "Git Identity Diagnostics Tool"
        echo "============================"
        echo ""
        echo "Usage: $0 {config|identity|ssh|repo|report|full}"
        echo ""
        echo "Commands:"
        echo "  config   - Analyze Git configuration"
        echo "  identity - Check identity resolution"
        echo "  ssh      - Validate SSH configuration"
        echo "  repo     - Repository-specific analysis"
        echo "  report   - Generate diagnostic report"
        echo "  full     - Run all diagnostics"
        ;;
esac
```

## Conclusion

Enterprise Git identity management requires sophisticated configuration strategies that seamlessly handle multiple contexts while maintaining security and operational efficiency. By implementing conditional configurations, automated SSH key management, and comprehensive workflow patterns, development teams can build robust systems that scale across complex organizational structures.

The key to successful multi-identity Git management lies in understanding the configuration hierarchy, properly organizing development environments, and implementing automated validation systems that prevent identity-related issues before they impact productivity. As your development infrastructure grows, these patterns provide a solid foundation for maintaining security isolation while supporting the diverse authentication needs of modern enterprise development workflows.

Regular monitoring, automated validation, and comprehensive troubleshooting capabilities ensure your Git identity management system remains reliable and secure while adapting to evolving organizational requirements and security policies.