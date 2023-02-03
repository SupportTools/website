+++
Categories = ["Ubuntu"]
Tags = ["Ubuntu", "dpkg", "APT"]
date = "2020-10-22T10:52:00+00:00"
more_link = "yes"
title = "How to Fix 'E: Could not get lock /var/lib/dpkg/lock-frontend - open (11: Resource temporarily unavailable)'"
+++

In Ubuntu, you may sometimes encounter an error when attempting to run an apt command:

```
E: Could not get lock /var/lib/dpkg/lock-frontend - open (11: Resource temporarily unavailable)
E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?
```

<!--more-->
# [Pre-requisites](#pre-requisites)

- Access to a terminal window/command line
- A user account with sudo or root privileges

# [Fix](#fix)

- Verify apt and/or dpkg isn't running. It's still running; then, you should wait for the process to finish.

```
ps aux | grep -i -E 'apt\|dpkg'
```

- If the process is stuck using the following.

```
kill -9 `ps aux | grep -i -E 'apt\|dpkg' | grep -v grep | awk '{print $2}'`
```

- Remove the lock file.

```
sudo rm /var/lib/dpkg/lock
sudo rm /var/lib/apt/lists/lock
sudo rm /var/cache/apt/archives/lock
```
