---
categories: ["VMware", "ESXi"]
tags: ["vmware", "esxi"]
date: "2021-09-08T04:53:00+00:00"
more_link: "yes"
title: "Unlock Root Account on ESXi"
---

If the root account gets locked out, you won't be able to access ESXi using SSH or the vSphere Web Client. Follow the steps below to unlock the account.

### Common Symptoms
- You receive an "incorrect username/password" error even though the credentials are correct.
- By default, ESXi 6.x has the following lockout behavior:
  - **Maximum Attempts**: After 10 failed login attempts, the account is locked.
  - **Lockout Applies To**: SSH and the vSphere Web Services SDK.
  - **Lockout Does Not Apply To**: Direct Console User Interface (DCUI) and the ESXi Shell.

<!--more-->

## Steps to Unlock the Root Account

Follow these steps to unlock the root account from the console:

1. **Access the ESXi Console**
   - At the physical console of the ESXi host, press `CTRL+ALT+F2` to switch to the ESXi shell.
   - If a login prompt appears, skip to Step 3. Otherwise, proceed to Step 2.

2. **Enable the ESXi Shell (if not already enabled)**
   - Log in to the **Direct Console User Interface (DCUI)** with the `root` user and the correct password.
   - Navigate to `Troubleshooting Options`.
   - Select **Enable ESXi Shell**.
   - Return to the shell by pressing `CTRL+ALT+F1`.

3. **Log in to the ESXi Shell**
   - Use the `root` account and the correct password to log in.

4. **Check Failed Login Attempts**
   - Run the following command to check the number of failed login attempts:
     ```bash
     pam_tally2 --user root
     ```

5. **Reset the Failed Login Counter**
   - Run the following command to unlock the root account:
     ```bash
     pam_tally2 --user root --reset
     ```

6. **Reboot the Host**
   - Execute the following command to reboot the host:
     ```bash
     reboot -f
     ```

Once the system reboots, you should be able to access the ESXi host using the root account.

---

### Notes
- Make sure to follow best practices for account security, including using a strong password and limiting access to the ESXi host.
- Consider reviewing login logs to investigate the source of failed login attempts.
