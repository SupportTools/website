---
title: "Detecting Malicious RDP Activity: Key Indicators of Compromise (IOCs)"
date: 2024-12-07T10:00:00-05:00
draft: false
tags: ["RDP Security", "Indicators of Compromise", "Cybersecurity", "Vulnerability Management", "Remote Desktop Protocol"]
categories:
- Cybersecurity
- Threat Detection
author: "Matthew Mattox"
description: "Learn how to identify malicious RDP activity with key indicators of compromise (IOCs). Proactively secure your systems by recognizing unusual behavior and taking action."
more_link: "yes"
url: "/detecting-malicious-rdp-activity-iocs/"
---

# Detecting Malicious RDP Activity: Key Indicators of Compromise (IOCs)

Remote Desktop Protocol (RDP) can be a valuable tool for managing systems remotely but is also a frequent target for attackers. Identifying potential RDP compromises early can help prevent data breaches and unauthorized access. This guide outlines common Indicators of Compromise (IOCs) to help you monitor, detect, and secure your RDP infrastructure.

---

## **1. Network Indicators**

- **Unusual RDP Port Activity**: RDP typically operates on TCP/3389. Monitor for traffic on non-standard ports, which may indicate attempts to bypass detection.
- **IP Addresses from Suspicious Locations**: Connections from unexpected or flagged geolocations can indicate malicious access attempts.
- **High Volume of RDP Sessions**: A large number of RDP sessions in a short timeframe or during unusual hours might signal brute-force attacks or lateral movement.
- **Failed Login Attempts**: Repeated failures can indicate a brute-force attack or credential stuffing attempt.

---

## **2. File-Based IOCs**

- **Malicious `.rdp` Files**: Be cautious of files with:
  - Unknown or external IPs in the `full address` field.
  - Enabled redirections (`redirectdrives:i:1`, `redirectclipboard:i:1`) that may facilitate data theft.
- **Unexpected Executables**: Look for unfamiliar executables in sensitive directories like `C:\Windows\Temp\`.

---

## **3. Account Indicators**

- **Unknown User Accounts**: Watch for newly created accounts, especially those with administrative privileges.
- **Privilege Escalation**: Monitor for accounts with altered permissions, particularly elevated privileges.

---

## **4. Behavioral Indicators**

- **Abnormal System Activity**: High CPU/RAM usage and unusual system processes can indicate malicious activity, such as malware execution.
- **Unusual Outbound Connections**: Monitor for outbound traffic to command-and-control (C2) servers, which may signal remote control or data exfiltration.

---

## **5. Log Analysis IOCs**

### Windows Event Logs to Monitor:
- **Event ID 4625**: Repeated failed login attempts, often signaling brute-force attacks.
- **Event ID 4624**: Successful logins from unexpected locations or times.
- **Event ID 4648**: Logons using explicit credentials, possibly indicating lateral movement.
- **Event ID 4720**: Creation of new user accounts.
- **Event IDs 4732/4733**: Addition or removal of users in privileged groups like Administrators.
- **Event ID 7045**: Installation of new services, often used for persistence by attackers.

---

## **6. Registry Keys (Persistence Mechanisms)**

Attackers often manipulate registry keys for persistence or to disable security tools:
- **Startup Keys**:
  - `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
- **RDP-Specific Keys**:
  - `HKLM\SYSTEM\CurrentControlSet\Services\TermService`

---

## **7. Additional Artifacts**

- **Remote Management Tools**: Look for the presence of tools like PsExec or Mimikatz, which attackers use for privilege escalation.
- **Newly Configured Scheduled Tasks**: Investigate scheduled tasks created without your knowledge, as they are often used for maintaining unauthorized access.

---

## **Conclusion**

RDP is a powerful tool, but when left unsecured, it becomes a significant risk. By monitoring the above Indicators of Compromise, organizations can detect malicious activity early and mitigate potential damage. Combining proactive monitoring with best practices will strengthen your network's defenses against RDP-based threats.

For further reading, consider these resources:
- [CISA's Cybersecurity Advisory on RDP](https://www.cisa.gov/news-events/cybersecurity-advisories/aa19-168a)
- [Microsoft’s Guide to Protecting Against BlueKeep](https://www.microsoft.com/en-us/security/blog/2019/08/08/protect-against-bluekeep/)
- [BlueKeep Vulnerability Overview](https://en.wikipedia.org/wiki/BlueKeep)

---
