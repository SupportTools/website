---
title: "MegaCLI Cheat Sheet"
date: 2025-05-15T10:00:00-05:00
draft: false
tags: ["MegaCLI", "RAID", "DevOps", "Server Management"]
categories:
- DevOps
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "A concise MegaCLI cheat sheet to manage RAID controllers and disks efficiently with common commands and practical examples."
more_link: "yes"
url: "/megacli-cheat-sheet/"
---

Working with RAID controllers can be a daunting task, especially if you only need to do it occasionally. MegaCLI, a powerful command-line tool for managing RAID controllers and disks, can be particularly challenging due to its cryptic syntax. To simplify the process, I’ve compiled this cheat sheet of essential MegaCLI commands and tips for easy reference.

<!--more-->

---

## Installing MegaCLI  

To install MegaCLI on a Debian-based system, use:  

```bash
sudo apt-get install megacli
```

---

## Common Parameters  

### Controller Syntax: `-aN`  
- Use this to specify the adapter ID.  
- Avoid using the `ALL` flag to prevent accidental changes across all controllers.

### Physical Drive: `-PhysDrv [E:S]`  
- `E`: Enclosure ID  
- `S`: Slot number (starting at 0).  
- Retrieve enclosure and slot information with:  

```bash
megacli -EncInfo -aALL
```

### Virtual Drive: `-Lx`  
- Use to specify the virtual drive where `x` is a number starting at 0 or the string `all`.

---

## Information Commands  

### Get Controller Information  

- Display adapter details:  
  ```bash
  megacli -AdpAllInfo -aALL
  ```  
- Show RAID configuration:  
  ```bash
  megacli -CfgDsply -aALL
  ```  
- Export event logs:  
  ```bash
  megacli -adpeventlog -getevents -f lsi-events.log -a0 -nolog
  ```

---

## Common Operations  

### Replace a Drive  

1. Set the drive offline:  
   ```bash
   megacli -PDOffline -PhysDrv[E:S] -aN
   ```
2. Mark the drive as missing:  
   ```bash
   megacli -PDMarkMissing -PhysDrv [E:S] -aN
   ```
3. Prepare for removal:  
   ```bash
   megacli -PDPrpRmv -PhysDrv [E:S] -aN
   ```
4. Replace the drive and assign it:  
   ```bash
   megacli -PdReplaceMissing -PhysDrv[E:S] -ArrayN -rowN -aN
   ```
5. Start the rebuild process:  
   ```bash
   megacli -PDRbld -Start -PhysDrv [E:S] -aN
   ```

### Fix a "Foreign" Drive  

- Mark the drive as good:  
  ```bash
  megacli -PDMakeGood -PhysDrv [E:S] -aALL
  ```  
- Clear the foreign configuration:  
  ```bash
  megacli -CfgForeign -Clear -aALL
  ```

### Disable the Alarm  

If the alarm is causing unnecessary noise, turn it off:  

```bash
megacli -AdpSetProp AlarmDsbl -aALL
```

---

## Why This Matters  

MegaCLI is a powerful yet complex tool, and knowing these commands can save you hours of frustration during critical maintenance tasks. Bookmark this cheat sheet for your next encounter with RAID management!

For more insights and tips, feel free to connect with me on [LinkedIn](https://www.linkedin.com/in/matthewmattox/), [GitHub](https://github.com/mattmattox), or [BlueSky](https://bsky.app/profile/cube8021.bsky.social).  

Happy troubleshooting!
