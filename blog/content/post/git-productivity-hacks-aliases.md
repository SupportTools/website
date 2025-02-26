---
title: "Git Productivity Hacks: Essential Aliases and Time-Saving Techniques"
date: 2025-08-30T09:00:00-06:00
draft: false
tags: ["Git", "DevOps", "Productivity", "Version Control", "Command Line", "Automation"]
categories:
- Git
- DevOps
- Productivity
author: "Matthew Mattox - mmattox@support.tools"
description: "Boost your Git workflow efficiency with powerful aliases and productivity hacks. Learn time-saving techniques that will streamline your version control process."
more_link: "yes"
url: "/git-productivity-hacks-aliases/"
---

Master the art of Git productivity with these essential aliases and time-saving techniques that will streamline your daily workflow.

<!--more-->

# Git Productivity Hacks and Aliases

## Essential Git Aliases

### 1. Basic Workflow Aliases

```bash
# ~/.gitconfig
[alias]
    # Status shortcuts
    s = status -s
    st = status

    # Commit shortcuts
    ci = commit
    cm = commit -m
    ca = commit --amend
    cane = commit --amend --no-edit

    # Branch management
    br = branch
    co = checkout
    cob = checkout -b
    
    # Log viewing
    lg = log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit
    ll = log --pretty=format:"%C(yellow)%h%Cred%d\\ %Creset%s%Cblue\\ [%cn]" --decorate --numstat
```

### 2. Advanced Workflow Aliases

```bash
[alias]
    # Stash operations
    sl = stash list
    sa = stash apply
    ss = stash save
    sp = stash pop

    # Reset operations
    r = reset
    r1 = reset HEAD^
    r2 = reset HEAD^^
    rh = reset --hard
    rh1 = reset HEAD^ --hard
    rh2 = reset HEAD^^ --hard

    # Clean working directory
    clean-branches = "!git branch --merged | grep -v '\\*' | xargs -n 1 git branch -d"
    purge = "!git clean -df && git reset --hard"
```

## Time-Saving Functions

### 1. Smart Commit Functions

```bash
[alias]
    # Commit with ticket number from branch name
    ticket-commit = "!f() { ticket=$(git rev-parse --abbrev-ref HEAD | grep -Eo '[A-Z]+-[0-9]+'); if [ \"$ticket\" ]; then git commit -m \"$ticket: $1\"; else git commit -m \"$1\"; fi; }; f"

    # Quick fixup
    fixup = "!f() { git commit --fixup=$1; git rebase -i --autosquash $1~1; }; f"
```

### 2. Branch Management Functions

```bash
[alias]
    # Create feature branch
    feature = "!f() { git checkout -b feature/$1; }; f"
    
    # Create bugfix branch
    bugfix = "!f() { git checkout -b bugfix/$1; }; f"
    
    # Delete merged branches
    cleanup = "!git branch --merged | grep -v '\\*' | grep -v 'master' | grep -v 'main' | grep -v 'develop' | xargs -n 1 git branch -d"
```

## Advanced Git Configurations

### 1. Global Git Configuration

```bash
[core]
    # Use VSCode as default editor
    editor = code --wait
    
    # Improve diff output
    pager = delta

[diff]
    # Use better diff algorithm
    algorithm = histogram
    
    # Enable better word diff
    wordRegex = [^[:space:]]

[pull]
    # Avoid merge commits on pull
    rebase = true

[push]
    # Push only current branch
    default = current
```

### 2. Git Hooks Setup

```bash
#!/bin/bash
# .git/hooks/prepare-commit-msg

# Auto-add ticket number from branch name
BRANCH_NAME=$(git rev-parse --abbrev-ref HEAD)
TICKET=$(echo $BRANCH_NAME | grep -Eo '[A-Z]+-[0-9]+')

if [ ! -z "$TICKET" ]; then
    sed -i.bak -e "1s/^/$TICKET: /" $1
fi
```

## Productivity Scripts

### 1. Git Workflow Automation

```bash
#!/bin/bash
# git-workflow.sh

function git_sync() {
    git fetch origin
    git rebase origin/main
    git push origin HEAD
}

function git_cleanup() {
    git fetch -p
    git branch -vv | grep ': gone]' | awk '{print $1}' | xargs git branch -D
}

function git_release() {
    local version=$1
    git tag -a "v$version" -m "Release version $version"
    git push origin "v$version"
}
```

### 2. Project-Specific Scripts

```bash
#!/bin/bash
# project-setup.sh

function setup_git_hooks() {
    # Copy hooks to .git/hooks
    cp hooks/* .git/hooks/
    chmod +x .git/hooks/*
}

function setup_git_config() {
    # Set project-specific git config
    git config user.email "team@company.com"
    git config commit.template .gitmessage
}
```

## Integration with Development Tools

### 1. VSCode Integration

```json
// settings.json
{
    "git.enableSmartCommit": true,
    "git.confirmSync": false,
    "git.autofetch": true,
    "git.pruneOnFetch": true,
    "gitlens.statusBar.enabled": true
}
```

### 2. Terminal Integration

```bash
# Add to .bashrc or .zshrc
source /usr/share/git/completion/git-completion.bash
source /usr/share/git/completion/git-prompt.sh

# Customize prompt with git info
PS1='[\u@\h \W$(__git_ps1 " (%s)")]\$ '
```

## Best Practices

1. **Alias Organization**
   - Group related aliases
   - Document complex aliases
   - Use consistent naming

2. **Function Naming**
   - Use descriptive names
   - Follow naming conventions
   - Add usage comments

3. **Configuration Management**
   - Version control configs
   - Document settings
   - Share team standards

4. **Maintenance**
   - Regular cleanup
   - Update aliases
   - Review unused items

Remember to customize these aliases and functions to match your workflow and team practices. Regular review and updates ensure they continue to enhance your productivity.
