---
title: "MegaCLI Cheat Sheet: RAID Status, Rebuild and Drive Swap"
date: 2025-05-15T10:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["MegaCLI", "RAID", "DevOps", "Server Management"]
categories:
- DevOps
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "MegaCLI commands for LSI and Dell PERC RAID: check drive and array status, watch a rebuild, replace a failed disk, clear foreign configs, silence alarms."
more_link: "yes"
url: "/megacli-cheat-sheet/"
quick_fix: |
  Check every drive with `megacli -PDList -aALL | grep -E "Slot Number|Firmware state"` and every array with `megacli -LDInfo -Lall -aALL | grep -E "Virtual Drive|State"`. Watch a rebuild with `megacli -PDRbld -ShowProg -PhysDrv [E:S] -a0`, using the enclosure and slot numbers from `-PDList`.
---

MegaCLI manages LSI MegaRAID controllers, including the Dell PERC H700, H710 and H730 family. Its syntax is cryptic, so this cheat sheet collects the commands you actually need when a drive fails: status checks, rebuilds, drive replacement and foreign configurations.

<!--more-->

## Installing MegaCLI

MegaCLI is not in the Debian or Ubuntu archives. Broadcom ships it as an RPM (`MegaCli-8.07.14`), and the community [hwraid repository](https://hwraid.le-vert.net/) packages it for Debian and Ubuntu as `megacli`:

```bash
sudo apt-get install megacli
```

That command only works after you add the hwraid repository. If you install Broadcom's RPM (or convert it with `alien`), the binary is `/opt/MegaRAID/MegaCli/MegaCli64`; link it into your `PATH` so the commands below work as written:

```bash
sudo ln -s /opt/MegaRAID/MegaCli/MegaCli64 /usr/local/bin/megacli
```

> [!NOTE]
> MegaCLI is no longer developed. Broadcom's replacement is StorCLI (`storcli64`), and Dell ships the same tool as PERCCLI (`perccli64`). On newer controllers (PERC H740 and later, LSI 93xx and later) use those instead.

## Common Parameters

### Controller Syntax: `-aN`
- Use this to specify the adapter ID, starting at 0.
- `-aALL` is fine for read-only commands. For changes, name the adapter (`-a0`) to avoid touching every controller.

### Physical Drive: `-PhysDrv [E:S]`
- `E`: Enclosure ID
- `S`: Slot number (starting at 0).
- Retrieve enclosure and slot information with:

```bash
megacli -EncInfo -aALL
megacli -PDList -aALL | grep -E "Enclosure Device ID|Slot Number"
```

### Virtual Drive: `-Lx`
- Use to specify the virtual drive where `x` is a number starting at 0 or the string `all`.

## Information Commands

### Drive and Array Status

- List all physical drives with their state (`Online, Spun Up`, `Failed`, `Rebuild`, `Unconfigured(good)`):
  ```bash
  megacli -PDList -aALL
  ```
- Show virtual drives (arrays) and whether they are `Optimal` or `Degraded`:
  ```bash
  megacli -LDInfo -Lall -aALL
  ```
- Check media and predictive failure counters, which warn you before a drive fails:
  ```bash
  megacli -PDList -aALL | grep -E "Slot Number|Media Error Count|Predictive Failure Count"
  ```

### Controller Information

- Display adapter details:
  ```bash
  megacli -AdpAllInfo -aALL
  ```
- Show RAID configuration:
  ```bash
  megacli -CfgDsply -aALL
  ```
- Check the cache battery (BBU); a failed battery forces write-through and slows writes:
  ```bash
  megacli -AdpBbuCmd -GetBbuStatus -aALL
  ```
- Export event logs:
  ```bash
  megacli -AdpEventLog -GetEvents -f lsi-events.log -a0 -NoLog
  ```

## Common Operations

### Blink a Drive LED

Find the physical disk before you pull it:

```bash
megacli -PDLocate -start -PhysDrv [E:S] -a0
megacli -PDLocate -stop -PhysDrv [E:S] -a0
```

### Replace a Drive

1. Set the drive offline:
   ```bash
   megacli -PDOffline -PhysDrv [E:S] -aN
   ```
2. Mark the drive as missing:
   ```bash
   megacli -PDMarkMissing -PhysDrv [E:S] -aN
   ```
3. Prepare for removal:
   ```bash
   megacli -PDPrpRmv -PhysDrv [E:S] -aN
   ```
4. Replace the drive and assign it to the missing array row (get `Array` and `row` from `megacli -PDGetMissing -aN`):
   ```bash
   megacli -PDGetMissing -aN
   megacli -PdReplaceMissing -PhysDrv [E:S] -ArrayN -rowN -aN
   ```
5. Start the rebuild process:
   ```bash
   megacli -PDRbld -Start -PhysDrv [E:S] -aN
   ```

Most controllers start the rebuild on their own when a new drive goes into a slot that belonged to a degraded array, so check `-PDList` before running steps 4 and 5.

### Watch a Rebuild

```bash
megacli -PDRbld -ShowProg -PhysDrv [E:S] -aN
```

### Add a Hot Spare

```bash
megacli -PDHSP -Set -PhysDrv [E:S] -aN
```

### Fix a "Foreign" Drive

A drive that was part of another array shows as `Foreign`. Scan first, then either import the configuration (keep the data) or clear it (discard it):

- Scan for foreign configurations:
  ```bash
  megacli -CfgForeign -Scan -aALL
  ```
- Import it, if the drive belongs to an array you want back:
  ```bash
  megacli -CfgForeign -Import -aALL
  ```
- Or clear it, then mark the drive as good so it can be reused:
  ```bash
  megacli -CfgForeign -Clear -aALL
  megacli -PDMakeGood -PhysDrv [E:S] -aN
  ```

### Silence or Disable the Alarm

Silence the current alarm only:

```bash
megacli -AdpSetProp AlarmSilence -aALL
```

Disable it permanently (you will no longer hear about the next failure, so make sure monitoring covers it):

```bash
megacli -AdpSetProp AlarmDsbl -aALL
```

## FAQ

### How do I check if a RAID array is degraded with MegaCLI?

Run `megacli -LDInfo -Lall -aALL | grep State`. `Optimal` is healthy; `Degraded` means a member drive failed or is rebuilding; `Offline` means the array has lost too many drives.

### Why does MegaCLI fail with `libncurses.so.5: cannot open shared object file`?

The binary is old and links against ncurses 5. Install `libncurses5` where your distribution still ships it, or use StorCLI or PERCCLI, which do not need it.

### MegaCLI shows "Unconfigured(bad)" for a new drive. What now?

Run `megacli -PDMakeGood -PhysDrv [E:S] -aN` to mark it good, then check for a foreign configuration with `-CfgForeign -Scan`.

## Related Guides

- [Install RACADM on Ubuntu and Debian (Dell iDRAC Tools)](/dell-idrac-racadm-installation-ubuntu-debian-2025/)
- [Re-adding Failed Drives in mdadm: A Complete Recovery Guide](/readding-failed-drive-mdadm/)
- [Dell iDRAC Session Management & Troubleshooting Guide](/idrac-session-management-troubleshooting-guide-2025/)
