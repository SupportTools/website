+++
Categories = ["VMware", "ESXi", "Linux"]
Tags = ["vmware", "esxi", "linux"]
date = "2021-09-08T04:53:00+00:00"
more_link = "yes"
title = "Unlock root account on ESXi"
+++

If the root account gets locked out, you will not be able to access ESXi using SSH or vSphere Web client; please follow the below procedure to unlock the account.

Please note you will get an incorrect username/password error even though you are trying to log in with the correct username/password.

By default, the ESXi 6.x password requirements for lockout behavior are:

- A maximum of ten failed attempts is allowed before the account is locked
- Password lockout is active on SSH and the vSphere Web Service SDK
- Password lockout is not active on the Direct Console Interface (DCUI) and the ESXi Shell

<!--more-->
<!--more-->
# [Steps to unlock the ESXi host account at the console](#unlock-account)
- At the console, press CTRL+ALT+F2 to get to the ESXi shell. If a login shows up, continue with step 3; otherwise, continue with step 2.
- Login to the DCUI (to enable the ESXi Shell if not already done)
  - Login with root and the correct password.
  - Go to Troubleshooting Options
  - Select Enable ESXi Shell
  - Press CTRL+ALT+F1
- At the ESXi shell, log in with root and the password
- Run the following commands to show the number of failed attempts:
```
pam_tally2 --user root
```
- Run the following command to unlock the root account:
```
pam_tally2 --user root --reset
reboot -f
```