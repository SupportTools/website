---
title: "Active Directory Domain Controller In-Place Upgrades: Adprep Forest and Domain Preparation Enterprise Guide"
date: 2026-03-17T00:00:00-05:00
draft: false
tags: ["active-directory", "windows-server", "domain-controller", "adprep", "upgrade", "enterprise", "migration"]
categories:
- Active Directory
- Windows Server
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Active Directory domain controller in-place upgrades with comprehensive adprep preparation workflows. Complete guide to forest and domain preparation for Windows Server 2012 through 2025 upgrade paths."
more_link: "yes"
url: "/active-directory-domain-controller-upgrade-adprep-enterprise-guide/"
---

Active Directory domain controller upgrades require meticulous planning and systematic execution to maintain directory service integrity across enterprise forests. This comprehensive guide covers adprep preparation, supported upgrade paths, and production-ready procedures for Windows Server domain controller in-place upgrades.

<!--more-->

# [Active Directory Upgrade Planning](#upgrade-planning)

## Understanding Active Directory Upgrade Requirements

Domain controller upgrades involve multiple preparation phases to extend the Active Directory schema and update domain infrastructure:

```powershell
# Active Directory upgrade component hierarchy
Forest Level Changes:
├── Schema Extensions (adprep /forestprep)
│   ├── New object classes
│   ├── Attribute definitions
│   └── Schema version increments

Domain Level Changes (adprep /domainprep):
├── Security descriptor updates
├── SYSVOL permissions adjustments
└── Infrastructure updates

Infrastructure Changes (adprep /rodcprep):
└── Read-only domain controller support
```

## Supported Upgrade Paths Matrix

Windows Server domain controller upgrade paths from 2008 R2 through 2025:

```
From Version    → To Version         Supported  Notes
───────────────────────────────────────────────────────────────
2008 R2         → 2012               Yes        Direct upgrade
2008 R2         → 2012 R2            Yes        Direct upgrade
2008 R2         → 2016               No         Must upgrade to 2012+ first
2008 R2         → 2019               No         Multi-hop required
2008 R2         → 2022               No         Multi-hop required
2008 R2         → 2025               No         Multi-hop required

2012            → 2012 R2            Yes        Direct upgrade
2012            → 2016               Yes        Direct upgrade
2012            → 2019               Yes        Direct upgrade
2012            → 2022               Yes        Direct upgrade
2012            → 2025               Yes        Direct upgrade

2012 R2         → 2016               Yes        Direct upgrade
2012 R2         → 2019               Yes        Direct upgrade
2012 R2         → 2022               Yes        Direct upgrade
2012 R2         → 2025               Yes        Direct upgrade

2016            → 2019               Yes        Direct upgrade
2016            → 2022               Yes        Direct upgrade
2016            → 2025               Yes        Direct upgrade

2019            → 2022               Yes        Direct upgrade
2019            → 2025               Yes        Direct upgrade

2022            → 2025               Yes        Direct upgrade
```

# [Pre-Upgrade Assessment](#pre-upgrade-assessment)

## Forest and Domain Functional Level Verification

```powershell
# Check current forest functional level
Get-ADForest | Select-Object Name, ForestMode

# Check domain functional level
Get-ADDomain | Select-Object Name, DomainMode

# List all domain controllers and versions
Get-ADDomainController -Filter * | Select-Object Name, OperatingSystem, IPv4Address | Sort-Object Name

# Verify FSMO role holders
Get-ADDomain | Select-Object PDCEmulator, RIDMaster, InfrastructureMaster
Get-ADForest | Select-Object SchemaMaster, DomainNamingMaster

# Check replication health
repadmin /replsummary
repadmin /showrepl

# Verify DNS health
dcdiag /test:dns /v
```

## Active Directory Health Validation

```powershell
# Comprehensive domain controller diagnostics
dcdiag /v /c /d /e /s:DC01 > C:\Logs\dcdiag-pre-upgrade.txt

# Check Active Directory database integrity
ntdsutil "activate instance ntds" "files" "integrity" quit quit

# Verify SYSVOL replication state
dfsrmig /getglobalstate
dfsrmig /getmigrationstate

# Check tombstone lifetime
(Get-ADObject -Identity "CN=Directory Service,CN=Windows NT,CN=Services,CN=Configuration,$((Get-ADDomain).DistinguishedName)" -Properties tombstoneLifetime).tombstoneLifetime

# Verify no lingering objects
repadmin /removelingeringobjects DC01.domain.com <GUID> DC=domain,DC=com /advisory_mode
```

## Backup Requirements

```powershell
# Perform system state backup before upgrade
wbadmin start systemstatebackup -backupTarget:E: -quiet

# Verify backup completion
wbadmin get versions -backupTarget:E:

# Export Active Directory snapshot (alternative method)
ntdsutil "activate instance ntds" "snapshot" "create" "mount {GUID}" quit quit

# Back up DHCP configuration if hosted on DC
Export-DhcpServer -File "C:\Backup\DHCP-Config.xml" -Leases -Force

# Document current configuration
Get-ADDomainController -Filter * | Export-Csv C:\Backup\DC-Inventory-Pre-Upgrade.csv
Get-ADReplicationSite -Filter * | Export-Csv C:\Backup\AD-Sites-Pre-Upgrade.csv
```

# [Adprep Forest Preparation](#forestprep)

## Locating Adprep.exe

Adprep location varies by Windows Server version:

```powershell
# Windows Server 2012/2012 R2/2016/2019/2022/2025
# Adprep is integrated into installation media
D:\support\adprep\adprep.exe

# Windows Server 2008 R2
# Located in separate folder on installation media
D:\support\adprep\adprep.exe

# Verify adprep version
D:\support\adprep\adprep.exe /?
```

## Forest Preparation Execution

Forest preparation extends the Active Directory schema for the target Windows Server version:

```powershell
# CRITICAL: Run on Schema Master domain controller
# Identify Schema Master
$schemaMaster = (Get-ADForest).SchemaMaster
Write-Host "Schema Master: $schemaMaster" -ForegroundColor Yellow

# Connect to Schema Master
Enter-PSSession -ComputerName $schemaMaster

# Mount installation media
# Assume mounted to D:\

# Execute forestprep (run ONCE per forest)
D:\support\adprep\adprep.exe /forestprep

# Confirm schema extension
# Press 'c' and Enter when prompted

# Wait for completion
# Monitor progress - can take 5-30 minutes depending on forest size

# Verify schema version after completion
$schemaVersion = (Get-ADObject (Get-ADRootDSE).schemaNamingContext -Property objectVersion).objectVersion

# Schema version reference:
# 47 = Windows Server 2008 R2
# 56 = Windows Server 2012
# 69 = Windows Server 2012 R2
# 87 = Windows Server 2016
# 88 = Windows Server 2019
# 88 = Windows Server 2022
# 89 = Windows Server 2025 (expected)

Write-Host "Current Schema Version: $schemaVersion" -ForegroundColor Green

# Verify schema replication
repadmin /syncall /AeD
```

## Post-ForestPrep Validation

```powershell
# Wait for schema replication across all DCs
$domainControllers = (Get-ADDomainController -Filter *).Name

foreach ($dc in $domainControllers) {
    Write-Host "Checking schema replication on $dc" -ForegroundColor Cyan

    $version = Invoke-Command -ComputerName $dc -ScriptBlock {
        (Get-ADObject (Get-ADRootDSE).schemaNamingContext -Property objectVersion).objectVersion
    }

    Write-Host "$dc - Schema Version: $version" -ForegroundColor $(if($version -eq $schemaVersion){'Green'}else{'Red'})
}

# Monitor replication convergence
repadmin /showrepl * /csv | ConvertFrom-Csv | Where-Object {$_.'Number of Failures' -gt 0}
```

# [Adprep Domain Preparation](#domainprep)

## Domain Preparation Requirements

Domain preparation updates security descriptors and permissions for new features:

```powershell
# CRITICAL: Run on Infrastructure Master of each domain
# Identify Infrastructure Master
$infraMaster = (Get-ADDomain).InfrastructureMaster
Write-Host "Infrastructure Master: $infraMaster" -ForegroundColor Yellow

# Connect to Infrastructure Master
Enter-PSSession -ComputerName $infraMaster

# Execute domainprep (run for EACH domain in forest)
D:\support\adprep\adprep.exe /domainprep /gpprep

# Note: /gpprep is included automatically in 2012+
# Separate execution required for 2008 R2 upgrades

# Monitor execution progress
# Typically completes in 2-10 minutes

# Verify domain preparation completion
$domainVersion = (Get-ADObject (Get-ADDomain).DistinguishedName -Property msDS-Behavior-Version).'msDS-Behavior-Version'

Write-Host "Domain Functional Level: $domainVersion" -ForegroundColor Green
```

## RODC Preparation (If Applicable)

```powershell
# Required if deploying Read-Only Domain Controllers
# Run on any writable DC in the forest

D:\support\adprep\adprep.exe /rodcprep

# Verify RODC preparation
Get-ADObject -Filter {objectClass -eq 'nTDSDSA'} -SearchBase "CN=Configuration,$((Get-ADRootDSE).rootDomainNamingContext)" -Properties msDS-IsRODC |
    Where-Object {$_.'msDS-IsRODC' -eq $true}
```

## Post-DomainPrep Validation

```powershell
# Verify domain preparation replication
repadmin /syncall $infraMaster /APed

# Check for replication errors
Get-ADReplicationFailure -Target (Get-ADDomainController -Filter *).Name

# Validate SYSVOL permissions
icacls C:\Windows\SYSVOL\domain

# Check Group Policy infrastructure
gpresult /h C:\Logs\gpresult-post-domainprep.html
```

# [In-Place Upgrade Execution](#upgrade-execution)

## Pre-Upgrade Final Checks

```powershell
# Create pre-upgrade validation report
$report = @{
    Timestamp = Get-Date
    DCName = $env:COMPUTERNAME
    ForestMode = (Get-ADForest).ForestMode
    DomainMode = (Get-ADDomain).DomainMode
    SchemaVersion = (Get-ADObject (Get-ADRootDSE).schemaNamingContext -Property objectVersion).objectVersion
    ReplicationHealth = (repadmin /showrepl 2>&1 | Select-String "error|fail")
    FSMORoles = @{
        PDC = (Get-ADDomain).PDCEmulator
        RID = (Get-ADDomain).RIDMaster
        Infrastructure = (Get-ADDomain).InfrastructureMaster
        Schema = (Get-ADForest).SchemaMaster
        DomainNaming = (Get-ADForest).DomainNamingMaster
    }
    DCDiag = (dcdiag /test:replications /test:services /test:systemlog 2>&1)
}

$report | ConvertTo-Json -Depth 10 | Out-File C:\Logs\pre-upgrade-validation.json
```

## Domain Controller In-Place Upgrade Process

```powershell
# Step 1: Disable antivirus and monitoring agents temporarily
Stop-Service -Name "Windows Defender" -Force
Set-Service -Name "Windows Defender" -StartupType Disabled

# Step 2: Mount Windows Server installation media
# Assume mounted to D:\

# Step 3: Launch setup with compatibility check
D:\setup.exe /auto upgrade /dynamicupdate disable /compat scanonly

# Review compatibility report
Start-Process "C:\Windows\Panther\setupact.log"

# Step 4: Execute in-place upgrade
D:\setup.exe /auto upgrade /dynamicupdate disable

# Upgrade process stages:
# 1. Copying Windows files (20-30%)
# 2. Getting files ready for installation (30-40%)
# 3. Installing features and drivers (40-75%)
# 4. Configuring settings (75-95%)
# 5. Finalizing (95-100%)

# System will reboot multiple times automatically
# Total upgrade time: 45-90 minutes typical
```

## Post-Upgrade Verification

```powershell
# Verify operating system version
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsHardwareAbstractionLayer

# Check Active Directory services
Get-Service -Name NTDS, DNS, Netlogon, W32Time | Select-Object Name, Status, StartType

# Verify domain controller functionality
dcdiag /v > C:\Logs\dcdiag-post-upgrade.txt

# Check DNS functionality
dcdiag /test:dns /v > C:\Logs\dns-post-upgrade.txt

# Verify SYSVOL share
Get-SmbShare | Where-Object Name -like "*SYSVOL*"

# Test authentication
nltest /sc_query:domain.com

# Verify replication
repadmin /replsum
repadmin /showrepl

# Check event logs for errors
Get-WinEvent -FilterHashtable @{LogName='Directory Services';Level=1,2,3;StartTime=(Get-Date).AddHours(-2)} |
    Select-Object TimeCreated, Id, LevelDisplayName, Message |
    Format-Table -AutoSize
```

# [Multi-Domain Forest Upgrades](#multi-domain-upgrades)

## Coordinated Upgrade Strategy

```powershell
# Recommended upgrade sequence for multi-domain forests:
# 1. Forest root domain first
# 2. Child domains in dependency order
# 3. Tree root domains last

# Upgrade order script
$upgradeSequence = @(
    @{Domain="root.com"; DC="DC01-ROOT"; Priority=1},
    @{Domain="child1.root.com"; DC="DC01-CHILD1"; Priority=2},
    @{Domain="child2.root.com"; DC="DC01-CHILD2"; Priority=3},
    @{Domain="tree.com"; DC="DC01-TREE"; Priority=4}
)

# Execute adprep /forestprep ONCE on Schema Master
# Execute adprep /domainprep on Infrastructure Master of EACH domain

foreach ($domain in $upgradeSequence | Sort-Object Priority) {
    Write-Host "`n=== Processing Domain: $($domain.Domain) ===" -ForegroundColor Yellow

    # Connect to domain controller
    $session = New-PSSession -ComputerName $domain.DC

    # Run domainprep
    Invoke-Command -Session $session -ScriptBlock {
        param($MediaPath)
        & "$MediaPath\support\adprep\adprep.exe" /domainprep
    } -ArgumentList "D:"

    # Verify completion
    Invoke-Command -Session $session -ScriptBlock {
        dcdiag /test:replications
    }

    Remove-PSSession $session

    # Wait for replication before proceeding
    Start-Sleep -Seconds 300
}
```

## Cross-Domain Replication Monitoring

```powershell
# Monitor inter-domain replication during upgrade window
function Test-ForestReplication {
    $allDCs = (Get-ADForest).Domains | ForEach-Object {
        Get-ADDomainController -Filter * -Server $_
    }

    $results = @()

    foreach ($dc in $allDCs) {
        $replStatus = repadmin /showrepl $dc.HostName 2>&1

        $results += [PSCustomObject]@{
            DC = $dc.Name
            Domain = $dc.Domain
            Site = $dc.Site
            HasErrors = ($replStatus | Select-String "error|fail").Count -gt 0
            LastReplication = (Get-ADReplicationPartnerMetadata -Target $dc.HostName |
                              Sort-Object LastReplicationSuccess |
                              Select-Object -First 1).LastReplicationSuccess
        }
    }

    return $results | Format-Table -AutoSize
}

# Run replication test every 15 minutes during upgrade window
while ($true) {
    Test-ForestReplication
    Start-Sleep -Seconds 900
}
```

# [Functional Level Raises](#functional-level-raises)

## Raising Domain Functional Level

```powershell
# After ALL domain controllers upgraded to target version
# Verify all DCs are upgraded
$targetOS = "Windows Server 2022"  # Adjust as needed
$allDCs = Get-ADDomainController -Filter *

$osCheck = $allDCs | Select-Object Name, OperatingSystem |
           Where-Object {$_.OperatingSystem -notlike "*$targetOS*"}

if ($osCheck) {
    Write-Warning "The following DCs are not yet upgraded:"
    $osCheck | Format-Table
    exit
}

# Raise domain functional level
Set-ADDomainMode -Identity domain.com -DomainMode Windows2016Domain

# Confirm new level
(Get-ADDomain).DomainMode
```

## Raising Forest Functional Level

```powershell
# After ALL domains raised to target functional level
# Verify all domains
$allDomains = (Get-ADForest).Domains
$targetLevel = "Windows2016Domain"

foreach ($domain in $allDomains) {
    $level = (Get-ADDomain -Server $domain).DomainMode
    Write-Host "$domain - Level: $level" -ForegroundColor $(if($level -eq $targetLevel){'Green'}else{'Red'})
}

# Raise forest functional level (IRREVERSIBLE)
Set-ADForestMode -Identity root.com -ForestMode Windows2016Forest

# Confirm new level
(Get-ADForest).ForestMode

# Document change
$auditEntry = @{
    Timestamp = Get-Date
    Action = "Forest Functional Level Raised"
    OldLevel = "Previous Level"
    NewLevel = (Get-ADForest).ForestMode
    Administrator = $env:USERNAME
} | ConvertTo-Json

$auditEntry | Out-File C:\Logs\forest-level-raise-audit.json
```

# [Troubleshooting Common Issues](#troubleshooting)

## Adprep Failures

```powershell
# Check adprep log files
Get-Content C:\Windows\Debug\adprep\logs\adprep.log -Tail 100

# Common issues and resolutions:

# Issue: Schema Master not reachable
# Resolution: Verify network connectivity and LDAP port 389
Test-NetConnection -ComputerName $schemaMaster -Port 389

# Issue: Insufficient permissions
# Resolution: Verify Schema Admins and Enterprise Admins group membership
Get-ADGroupMember -Identity "Schema Admins"
Get-ADGroupMember -Identity "Enterprise Admins"

# Issue: Lingering objects prevent schema extension
# Resolution: Remove lingering objects
repadmin /removelingeringobjects DC01.domain.com <DC-GUID> DC=domain,DC=com

# Issue: SYSVOL not ready
# Resolution: Verify DFSR or FRS replication
dfsrmig /getglobalstate
```

## Post-Upgrade Replication Issues

```powershell
# Force replication convergence
repadmin /syncall /AdeP

# Identify replication failures
repadmin /showrepl * /csv | ConvertFrom-Csv |
    Where-Object {$_.'Number of Failures' -gt 0} |
    Format-Table Source*, Destination*, "Number of Failures"

# Reset secure channel
nltest /sc_reset:domain.com

# Rebuild SYSVOL if corrupted
# CRITICAL: Only on single DC, then force replication
dfsrdiag pollad
dfsrdiag syncnow /partner:DC02.domain.com /RGName:"Domain System Volume" /Time:1
```

# [Conclusion](#conclusion)

Active Directory domain controller in-place upgrades demand systematic preparation and methodical execution. The adprep procedures and upgrade paths detailed in this guide ensure:

- **Schema Integrity**: Proper forest preparation with /forestprep
- **Domain Readiness**: Security descriptor updates via /domainprep
- **Supported Paths**: Validated upgrade sequences from Windows Server 2008 R2 through 2025
- **Replication Health**: Continuous monitoring and validation throughout upgrade process
- **Functional Level Management**: Coordinated raises after verification

Always maintain comprehensive backups, validate replication health, and test procedures in non-production environments before production execution. The irreversible nature of schema extensions and functional level raises demands thorough planning and precise execution.

For complex multi-domain forests, coordinate upgrades across organizational boundaries and schedule maintenance windows to accommodate replication convergence times. Post-upgrade monitoring should continue for 48-72 hours to ensure directory service stability.
