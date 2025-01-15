---
title: "Run Your Python Script as a Linux Daemon: A Step-by-Step Guide"
date: 2025-06-15T00:00:00-05:00
draft: false
tags: ["Linux", "Daemon", "Services", "Python", "Programming"]
categories:
- Linux
- System Administration
- Python
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to run your Python scripts as Linux daemons using systemd services for continuous background execution."
more_link: "yes"
url: "/run-python-script-linux-daemon/"
---

Do you have a Python script that needs to run continuously in the background? Converting your script into a Linux daemon ensures it operates reliably without manual intervention. In this guide, we'll walk you through the process of turning your Python script into a systemd service, allowing it to run as a daemon on your Linux system.

<!--more-->

# [Run Your Python Script as a Linux Daemon](#run-your-python-script-as-a-linux-daemon)

## Section 1: Understanding Linux Daemons  

A **daemon** is a background process that runs continuously and performs specific tasks without direct user interaction. Common examples include `sshd` for SSH connections and `cron` for scheduled tasks. Running your Python script as a daemon ensures it starts on boot and restarts automatically if it crashes.

## Section 2: Scenario Overview  

Imagine you have a Python script named `testdaemon.py` that executes every 30 seconds and writes output to a file. You want this script to:

- Run continuously in the background.
- Start automatically on system boot.
- Restart automatically if it stops unexpectedly.

## Section 3: Creating a systemd Service  

We'll use **systemd**, the default init system on most modern Linux distributions, to create a service that runs your Python script as a daemon.

### Step 1: Prepare Your Python Script  

Ensure your Python script is executable and functioning as intended. For example:

**`/home/username/scripts/testdaemon.py`**
```python
#!/usr/bin/env python3
import time

while True:
    with open("/home/username/log.txt", "a") as f:
        f.write("Daemon is running...\n")
    time.sleep(30)
```

- Make the script executable:
  ```bash
  chmod +x /home/username/scripts/testdaemon.py
  ```

### Step 2: Create the systemd Service File  

Create a new service file in the `/etc/systemd/system/` directory.

```bash
sudo nano /etc/systemd/system/testdaemon.service
```

**Add the following content:**

```ini
[Unit]
Description=Test Daemon Service
After=network.target

[Service]
Type=simple
Restart=always
WorkingDirectory=/home/username/scripts
ExecStart=/usr/bin/env python3 /home/username/scripts/testdaemon.py

[Install]
WantedBy=multi-user.target
```

- **Description**: A brief description of the service.
- **After**: Specifies service start order.
- **Type**: `simple` is suitable for most scripts.
- **Restart**: Ensures the service restarts if it fails.
- **WorkingDirectory**: Directory where the script is located.
- **ExecStart**: Command to execute the script.
- **WantedBy**: Defines the target that this service wants to be active for.

> **Note**: Replace `/home/username/scripts` with the actual path to your script, and ensure the `ExecStart` line points to the correct Python interpreter and script location.

### Step 3: Reload systemd and Start the Service  

Reload the systemd manager configuration to recognize the new service:

```bash
sudo systemctl daemon-reload
```

Start the service:

```bash
sudo systemctl start testdaemon.service
```

Enable the service to start on boot:

```bash
sudo systemctl enable testdaemon.service
```

### Step 4: Verify the Service Status  

Check the status of your service to ensure it's running correctly:

```bash
sudo systemctl status testdaemon.service
```

**Sample Output:**

```
● testdaemon.service - Test Daemon Service
     Loaded: loaded (/etc/systemd/system/testdaemon.service; enabled; vendor preset: enabled)
     Active: active (running) since Sat 2024-06-15 10:00:00 EDT; 5s ago
   Main PID: 1234 (python3)
      Tasks: 1 (limit: 4676)
     Memory: 10.5M
     CGroup: /system.slice/testdaemon.service
             └─1234 /usr/bin/python3 /home/username/scripts/testdaemon.py
```

### Step 5: Check the Output  

Verify that your script is functioning by checking the output file:

```bash
cat /home/username/log.txt
```

You should see entries like:

```
Daemon is running...
Daemon is running...
```

## Section 4: Managing the Daemon  

You can control the daemon using standard `systemctl` commands:

- **Stop the service**:
  ```bash
  sudo systemctl stop testdaemon.service
  ```
- **Restart the service**:
  ```bash
  sudo systemctl restart testdaemon.service
  ```
- **Disable the service from starting on boot**:
  ```bash
  sudo systemctl disable testdaemon.service
  ```

## Section 5: Conclusion  

Running your Python script as a Linux daemon using systemd ensures it operates smoothly in the background, starts on boot, and restarts automatically if it fails. This method provides robust management capabilities, allowing you to focus on what your script does best.

---
