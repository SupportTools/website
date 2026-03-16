---
title: "PowerShell Infrastructure Automation: Enterprise RDS Deployment from ISO to Production"
date: 2026-10-26T00:00:00-05:00
draft: false
tags: ["powershell", "automation", "windows-server", "rds", "active-directory", "infrastructure-as-code", "virtualization", "devops"]
categories:
- PowerShell
- Windows Server
- Automation
author: "Matthew Mattox - mmattox@support.tools"
description: "Master PowerShell-driven infrastructure automation with comprehensive RDS deployment workflows. Complete guide to automated VM provisioning, domain controller setup, and Remote Desktop Services configuration for enterprise environments."
more_link: "yes"
url: "/powershell-infrastructure-automation-rds-deployment-enterprise-guide/"
---

PowerShell infrastructure automation transforms manual server provisioning into repeatable, version-controlled deployment workflows. This comprehensive guide demonstrates enterprise-grade automation patterns for Remote Desktop Services deployment, from ISO conversion to fully configured production environments.

<!--more-->

# [PowerShell Infrastructure Automation Architecture](#automation-architecture)

## Automated Deployment Pipeline Overview

Modern infrastructure automation requires systematic approaches to VM provisioning, network configuration, and service deployment:

```powershell
# Complete automation pipeline stages
1. Template Creation    → Convert ISO to bootable VHDX
2. VM Provisioning      → Automated virtual machine deployment
3. Network Configuration → Static IP assignment and DNS setup
4. Domain Services      → Domain controller promotion
5. Role Installation    → RDS and application server configuration
6. Service Integration  → DHCP, DNS, and certificate services
```

## Core Automation Components

```powershell
# Infrastructure automation framework
Project-Structure/
├── Templates/
│   ├── Convert-WindowsImage.ps1      # ISO to VHDX conversion
│   └── Unattend.xml                   # Automated Windows setup
├── Deployment/
│   ├── New-LabEnvironment.ps1         # Master deployment script
│   ├── Deploy-DomainController.ps1    # AD DS automation
│   └── Deploy-RDSInfrastructure.ps1   # RDS configuration
├── Configuration/
│   ├── lab-config.json                # Environment parameters
│   └── network-config.json            # Network topology
└── Modules/
    ├── VMManagement.psm1              # Hyper-V automation
    └── ADManagement.psm1              # Active Directory functions
```

# [Template Creation and Image Preparation](#template-creation)

## Windows Server VHDX Generation

Automated conversion of Windows Server ISOs to deployable VHDX templates:

```powershell
# Convert-WindowsImage.ps1 - Enterprise template creation
param(
    [Parameter(Mandatory=$true)]
    [string]$ISOPath,

    [Parameter(Mandatory=$true)]
    [string]$VHDXPath,

    [Parameter(Mandatory=$true)]
    [ValidateSet('2019','2022','2025')]
    [string]$WindowsVersion,

    [Parameter(Mandatory=$false)]
    [string]$Edition = 'ServerDatacenterCore',

    [Parameter(Mandatory=$false)]
    [int64]$SizeBytes = 127GB,

    [Parameter(Mandatory=$false)]
    [string]$UnattendPath
)

# Mount ISO and extract install.wim
$mountResult = Mount-DiskImage -ImagePath $ISOPath -PassThru
$driveLetter = ($mountResult | Get-Volume).DriveLetter
$wimPath = "${driveLetter}:\sources\install.wim"

# Get edition index
$images = Get-WindowsImage -ImagePath $wimPath
$editionIndex = ($images | Where-Object ImageName -like "*$Edition*").ImageIndex

# Create VHDX
$vhdx = New-VHD -Path $VHDXPath -SizeBytes $SizeBytes -Dynamic

# Mount and partition VHDX
$disk = Mount-VHD -Path $VHDXPath -Passthru | Get-Disk
$disk | Initialize-Disk -PartitionStyle GPT
$systemPartition = $disk | New-Partition -Size 350MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'
$windowsPartition = $disk | New-Partition -UseMaximumSize -GptType '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'

# Format partitions
$systemPartition | Format-Volume -FileSystem FAT32 -NewFileSystemLabel "System"
$windowsPartition | Format-Volume -FileSystem NTFS -NewFileSystemLabel "Windows"

# Apply Windows image
$windowsDrive = ($windowsPartition | Get-Volume).DriveLetter
Expand-WindowsImage -ImagePath $wimPath -Index $editionIndex -ApplyPath "${windowsDrive}:\"

# Apply unattend.xml if provided
if ($UnattendPath -and (Test-Path $UnattendPath)) {
    Copy-Item -Path $UnattendPath -Destination "${windowsDrive}:\Windows\Panther\unattend.xml"
}

# Install bootloader
bcdboot "${windowsDrive}:\Windows" /s "${systemPartition.DriveLetter}:" /f UEFI

# Cleanup
Dismount-VHD -Path $VHDXPath
Dismount-DiskImage -ImagePath $ISOPath

Write-Host "VHDX template created successfully: $VHDXPath" -ForegroundColor Green
```

## Unattend.xml Configuration

Automated Windows setup with minimal user interaction:

```xml
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
    <settings pass="windowsPE">
        <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
            <SetupUILanguage>
                <UILanguage>en-US</UILanguage>
            </SetupUILanguage>
            <InputLocale>en-US</InputLocale>
            <SystemLocale>en-US</SystemLocale>
            <UILanguage>en-US</UILanguage>
            <UserLocale>en-US</UserLocale>
        </component>
    </settings>
    <settings pass="specialize">
        <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
            <ComputerName>*</ComputerName>
            <TimeZone>Eastern Standard Time</TimeZone>
        </component>
        <component name="Microsoft-Windows-TerminalServices-LocalSessionManager" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
            <fDenyTSConnections>false</fDenyTSConnections>
        </component>
    </settings>
    <settings pass="oobeSystem">
        <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
            <OOBE>
                <HideEULAPage>true</HideEULAPage>
                <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
                <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
                <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
                <ProtectYourPC>3</ProtectYourPC>
            </OOBE>
            <UserAccounts>
                <AdministratorPassword>
                    <Value>UABhAHMAcwB3AG8AcgBkADEAMgAzACEAQQBkAG0AaQBuAGkAcwB0AHIAYQB0AG8AcgBQAGEAcwBzAHcAbwByAGQA</Value>
                    <PlainText>false</PlainText>
                </AdministratorPassword>
            </UserAccounts>
        </component>
    </settings>
</unattend>
```

# [Automated VM Provisioning](#vm-provisioning)

## Hyper-V Virtual Machine Deployment

```powershell
# New-LabEnvironment.ps1 - Master deployment orchestration
param(
    [Parameter(Mandatory=$true)]
    [string]$ConfigPath
)

# Load configuration
$config = Get-Content -Path $ConfigPath | ConvertFrom-Json

# Create virtual switch if needed
$vSwitch = Get-VMSwitch -Name $config.Network.SwitchName -ErrorAction SilentlyContinue
if (-not $vSwitch) {
    New-VMSwitch -Name $config.Network.SwitchName -SwitchType Internal

    # Configure NAT for internet access
    $natAdapter = Get-NetAdapter | Where-Object Name -like "*$($config.Network.SwitchName)*"
    New-NetIPAddress -IPAddress $config.Network.GatewayIP -PrefixLength $config.Network.SubnetMask -InterfaceIndex $natAdapter.ifIndex
    New-NetNat -Name "LabNAT" -InternalIPInterfaceAddressPrefix "$($config.Network.NetworkPrefix)/$($config.Network.SubnetMask)"
}

# Deploy virtual machines
foreach ($vm in $config.VirtualMachines) {
    Write-Host "Deploying VM: $($vm.Name)" -ForegroundColor Cyan

    # Copy template VHDX
    $vhdxPath = Join-Path $config.VMStorage "$($vm.Name).vhdx"
    Copy-Item -Path $config.TemplateVHDX -Destination $vhdxPath

    # Create VM
    $newVM = New-VM -Name $vm.Name `
                    -MemoryStartupBytes $vm.Memory `
                    -VHDPath $vhdxPath `
                    -Generation 2 `
                    -SwitchName $config.Network.SwitchName

    # Configure processor
    Set-VMProcessor -VM $newVM -Count $vm.ProcessorCount

    # Enable nested virtualization if specified
    if ($vm.NestedVirtualization) {
        Set-VMProcessor -VM $newVM -ExposeVirtualizationExtensions $true
    }

    # Configure dynamic memory
    Set-VMMemory -VM $newVM -DynamicMemoryEnabled $true `
                           -MinimumBytes ($vm.Memory * 0.5) `
                           -MaximumBytes ($vm.Memory * 2)

    # Start VM
    Start-VM -VM $newVM

    Write-Host "VM $($vm.Name) deployed successfully" -ForegroundColor Green
}
```

## JSON Configuration Schema

```json
{
  "VMStorage": "D:\\HyperV\\VMs",
  "TemplateVHDX": "D:\\HyperV\\Templates\\WS2022-Template.vhdx",
  "Network": {
    "SwitchName": "LabSwitch",
    "NetworkPrefix": "192.168.100.0",
    "SubnetMask": 24,
    "GatewayIP": "192.168.100.1",
    "DNSServers": ["192.168.100.10", "8.8.8.8"]
  },
  "Domain": {
    "Name": "lab.internal",
    "NetBIOSName": "LAB",
    "SafeModePassword": "P@ssw0rd123!"
  },
  "VirtualMachines": [
    {
      "Name": "DC01",
      "Role": "DomainController",
      "IPAddress": "192.168.100.10",
      "Memory": 4GB,
      "ProcessorCount": 2,
      "NestedVirtualization": false
    },
    {
      "Name": "RDS01",
      "Role": "RDSHost",
      "IPAddress": "192.168.100.20",
      "Memory": 8GB,
      "ProcessorCount": 4,
      "NestedVirtualization": false
    }
  ]
}
```

# [Network Configuration Automation](#network-automation)

## Remote IP Configuration

```powershell
# Configure-NetworkSettings.ps1
function Set-VMStaticIP {
    param(
        [string]$VMName,
        [string]$IPAddress,
        [int]$PrefixLength,
        [string]$Gateway,
        [string[]]$DNSServers
    )

    # Wait for VM to be responsive
    $timeout = 300
    $elapsed = 0
    while ($elapsed -lt $timeout) {
        $vm = Get-VM -Name $VMName
        if ($vm.Heartbeat -eq 'OkApplicationsHealthy') {
            break
        }
        Start-Sleep -Seconds 5
        $elapsed += 5
    }

    # Get credentials
    $credential = Get-Credential -Message "Enter local administrator credentials"

    # Configure network via PowerShell Direct
    Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock {
        param($IP, $Prefix, $GW, $DNS)

        # Get network adapter
        $adapter = Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1

        # Remove existing IP configuration
        $adapter | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
        $adapter | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue

        # Set static IP
        New-NetIPAddress -InterfaceIndex $adapter.ifIndex `
                        -IPAddress $IP `
                        -PrefixLength $Prefix `
                        -DefaultGateway $GW

        # Set DNS servers
        Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses $DNS

        # Disable IPv6
        Disable-NetAdapterBinding -Name $adapter.Name -ComponentID ms_tcpip6

    } -ArgumentList $IPAddress, $PrefixLength, $Gateway, $DNSServers

    Write-Host "Network configured for $VMName - IP: $IPAddress" -ForegroundColor Green
}
```

# [Active Directory Automation](#active-directory-automation)

## Domain Controller Promotion

```powershell
# Deploy-DomainController.ps1
function Install-DomainController {
    param(
        [string]$VMName,
        [string]$DomainName,
        [string]$NetBIOSName,
        [SecureString]$SafeModePassword,
        [pscredential]$Credential
    )

    Invoke-Command -VMName $VMName -Credential $Credential -ScriptBlock {
        param($Domain, $NetBIOS, $SafePass)

        # Install AD DS role
        Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools

        # Import AD DS deployment module
        Import-Module ADDSDeployment

        # Promote to domain controller
        Install-ADDSForest `
            -DomainName $Domain `
            -DomainNetbiosName $NetBIOS `
            -SafeModeAdministratorPassword $SafePass `
            -InstallDns:$true `
            -CreateDnsDelegation:$false `
            -DatabasePath "C:\Windows\NTDS" `
            -LogPath "C:\Windows\NTDS" `
            -SysvolPath "C:\Windows\SYSVOL" `
            -NoRebootOnCompletion:$false `
            -Force:$true

    } -ArgumentList $DomainName, $NetBIOSName, $SafeModePassword

    # Wait for reboot and domain controller readiness
    Start-Sleep -Seconds 120

    Write-Host "Domain Controller $VMName promoted successfully" -ForegroundColor Green
}
```

## Domain Join Automation

```powershell
# Join-VMToDomain.ps1
function Add-VMToDomain {
    param(
        [string]$VMName,
        [string]$DomainName,
        [pscredential]$DomainCredential,
        [pscredential]$LocalCredential
    )

    Invoke-Command -VMName $VMName -Credential $LocalCredential -ScriptBlock {
        param($Domain, $DomainCred)

        # Join domain
        Add-Computer -DomainName $Domain `
                     -Credential $DomainCred `
                     -Restart -Force

    } -ArgumentList $DomainName, $DomainCredential

    Write-Host "VM $VMName joined to domain $DomainName" -ForegroundColor Green
}
```

# [RDS Infrastructure Deployment](#rds-deployment)

## Remote Desktop Services Configuration

```powershell
# Deploy-RDSInfrastructure.ps1
function Install-RDSDeployment {
    param(
        [string]$ConnectionBroker,
        [string]$WebAccessServer,
        [string[]]$SessionHosts,
        [pscredential]$DomainCredential
    )

    Invoke-Command -ComputerName $ConnectionBroker -Credential $DomainCredential -ScriptBlock {
        param($Broker, $WebAccess, $Hosts)

        # Install RDS roles
        Install-WindowsFeature -Name RDS-Connection-Broker, `
                                     RDS-Web-Access, `
                                     RDS-RD-Server `
                                     -IncludeManagementTools

        # Create RDS deployment
        New-RDSessionDeployment -ConnectionBroker $Broker `
                                -WebAccessServer $WebAccess `
                                -SessionHost $Hosts

        # Configure RDS licensing
        Add-RDServer -Server $Broker -Role RDS-LICENSING -ConnectionBroker $Broker
        Set-RDLicenseConfiguration -LicenseServer $Broker `
                                   -Mode PerUser `
                                   -ConnectionBroker $Broker

        # Create session collection
        New-RDSessionCollection -CollectionName "Production" `
                                -SessionHost $Hosts `
                                -ConnectionBroker $Broker

        # Configure collection properties
        Set-RDSessionCollectionConfiguration -CollectionName "Production" `
                                             -MaxRedirectedMonitors 2 `
                                             -EnableUserProfileDisk $true `
                                             -DiskPath "\\$Broker\UserProfiles" `
                                             -MaxUserProfileDiskSizeGB 50 `
                                             -ConnectionBroker $Broker

    } -ArgumentList $ConnectionBroker, $WebAccessServer, $SessionHosts

    Write-Host "RDS infrastructure deployed successfully" -ForegroundColor Green
}
```

## RDS Certificate Management

```powershell
# Configure-RDSCertificates.ps1
function Set-RDSCertificates {
    param(
        [string]$ConnectionBroker,
        [string]$CertificateThumbprint,
        [pscredential]$Credential
    )

    Invoke-Command -ComputerName $ConnectionBroker -Credential $Credential -ScriptBlock {
        param($Thumbprint)

        # Apply certificate to all RDS roles
        Set-RDCertificate -Role RDGateway `
                         -Thumbprint $Thumbprint `
                         -ConnectionBroker $env:COMPUTERNAME `
                         -Force

        Set-RDCertificate -Role RDWebAccess `
                         -Thumbprint $Thumbprint `
                         -ConnectionBroker $env:COMPUTERNAME `
                         -Force

        Set-RDCertificate -Role RDPublishing `
                         -Thumbprint $Thumbprint `
                         -ConnectionBroker $env:COMPUTERNAME `
                         -Force

        Set-RDCertificate -Role RDRedirector `
                         -Thumbprint $Thumbprint `
                         -ConnectionBroker $env:COMPUTERNAME `
                         -Force

    } -ArgumentList $CertificateThumbprint
}
```

# [Complete Deployment Orchestration](#deployment-orchestration)

## Master Automation Script

```powershell
# Master-Deployment.ps1
param(
    [string]$ConfigPath = ".\lab-config.json"
)

# Load configuration
$config = Get-Content -Path $ConfigPath | ConvertFrom-Json

# Stage 1: Deploy VMs
Write-Host "`n=== Stage 1: VM Deployment ===" -ForegroundColor Yellow
.\New-LabEnvironment.ps1 -ConfigPath $ConfigPath

# Stage 2: Configure networking
Write-Host "`n=== Stage 2: Network Configuration ===" -ForegroundColor Yellow
foreach ($vm in $config.VirtualMachines) {
    Set-VMStaticIP -VMName $vm.Name `
                   -IPAddress $vm.IPAddress `
                   -PrefixLength $config.Network.SubnetMask `
                   -Gateway $config.Network.GatewayIP `
                   -DNSServers $config.Network.DNSServers
}

# Stage 3: Deploy Domain Controller
Write-Host "`n=== Stage 3: Domain Controller Deployment ===" -ForegroundColor Yellow
$dcVM = $config.VirtualMachines | Where-Object Role -eq 'DomainController'
$safeModePass = ConvertTo-SecureString $config.Domain.SafeModePassword -AsPlainText -Force
Install-DomainController -VMName $dcVM.Name `
                         -DomainName $config.Domain.Name `
                         -NetBIOSName $config.Domain.NetBIOSName `
                         -SafeModePassword $safeModePass

# Stage 4: Join remaining VMs to domain
Write-Host "`n=== Stage 4: Domain Join ===" -ForegroundColor Yellow
$domainCred = Get-Credential -Message "Enter domain admin credentials"
foreach ($vm in $config.VirtualMachines | Where-Object Role -ne 'DomainController') {
    Add-VMToDomain -VMName $vm.Name `
                   -DomainName $config.Domain.Name `
                   -DomainCredential $domainCred
}

# Stage 5: Deploy RDS infrastructure
Write-Host "`n=== Stage 5: RDS Deployment ===" -ForegroundColor Yellow
$rdsHosts = ($config.VirtualMachines | Where-Object Role -eq 'RDSHost').Name
Install-RDSDeployment -ConnectionBroker $rdsHosts[0] `
                      -WebAccessServer $rdsHosts[0] `
                      -SessionHosts $rdsHosts `
                      -DomainCredential $domainCred

Write-Host "`n=== Deployment Complete ===" -ForegroundColor Green
Write-Host "Domain: $($config.Domain.Name)" -ForegroundColor Cyan
Write-Host "RDS Access: https://$($rdsHosts[0])/rdweb" -ForegroundColor Cyan
```

# [Monitoring and Validation](#monitoring-validation)

## Deployment Validation Script

```powershell
# Test-LabDeployment.ps1
function Test-LabInfrastructure {
    param(
        [string]$ConfigPath
    )

    $config = Get-Content -Path $ConfigPath | ConvertFrom-Json
    $results = @()

    # Test VM status
    foreach ($vm in $config.VirtualMachines) {
        $vmObject = Get-VM -Name $vm.Name
        $results += [PSCustomObject]@{
            Component = "VM: $($vm.Name)"
            Status = if ($vmObject.State -eq 'Running') { 'Healthy' } else { 'Failed' }
            Details = "State: $($vmObject.State), Heartbeat: $($vmObject.Heartbeat)"
        }
    }

    # Test domain controller
    $dcVM = $config.VirtualMachines | Where-Object Role -eq 'DomainController'
    $dcTest = Invoke-Command -VMName $dcVM.Name -Credential $credential -ScriptBlock {
        Get-ADDomainController -Discover
    }

    $results += [PSCustomObject]@{
        Component = "Domain Controller"
        Status = if ($dcTest) { 'Healthy' } else { 'Failed' }
        Details = $dcTest.HostName
    }

    # Test RDS deployment
    $rdsVM = ($config.VirtualMachines | Where-Object Role -eq 'RDSHost')[0]
    $rdsTest = Invoke-Command -ComputerName $rdsVM.Name -Credential $credential -ScriptBlock {
        Get-RDSessionCollection
    }

    $results += [PSCustomObject]@{
        Component = "RDS Deployment"
        Status = if ($rdsTest) { 'Healthy' } else { 'Failed' }
        Details = $rdsTest.CollectionName -join ', '
    }

    return $results | Format-Table -AutoSize
}
```

# [Conclusion](#conclusion)

PowerShell infrastructure automation delivers consistent, repeatable deployment workflows for enterprise Windows environments. The patterns demonstrated in this guide enable:

- **Template-Based Provisioning**: Automated VHDX creation from ISO media
- **Network Automation**: Scripted IP configuration via PowerShell Direct
- **Directory Services**: Automated domain controller promotion and forest deployment
- **Role Installation**: Unattended RDS infrastructure configuration
- **Orchestration**: Master scripts coordinating multi-stage deployments

This automation framework reduces deployment time from hours to minutes while ensuring configuration consistency across environments. The JSON-driven configuration approach enables version control, peer review, and infrastructure-as-code practices for Windows Server deployments.

For production implementations, extend these patterns with error handling, logging, backup procedures, and integration with enterprise configuration management systems like DSC or Ansible.
