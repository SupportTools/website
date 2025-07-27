---
title: "Get Rid of Ubuntu Pro Advertisement When Updating Apt"  
date: 2024-09-07T19:26:00-05:00  
draft: false  
tags: ["Ubuntu", "Apt", "Linux", "Ubuntu Pro", "Package Management"]  
categories:  
- Linux  
- Ubuntu  
- Package Management  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to remove the Ubuntu Pro advertisement when updating your system using apt."  
more_link: "yes"  
url: "/remove-ubuntu-pro-advertisement-apt-update/"  
---

If you're using Ubuntu and have recently noticed the promotional message for Ubuntu Pro while updating your system with `apt`, you’re not alone. While Ubuntu Pro is useful for certain users, many prefer a clean update process without ads. In this guide, we’ll cover how to disable those Ubuntu Pro advertisements.

<!--more-->

### The Problem

Each time you run `sudo apt update` or `sudo apt upgrade`, Ubuntu displays promotional messages encouraging you to enable Ubuntu Pro. While this might be useful for some, it can be distracting or unwanted for many users.

### The Solution

Ubuntu Pro advertisements are controlled by the `ubuntu-advantage-tools` package. To remove the ads without affecting your package management, you can adjust or remove this package.

### Option 1: Disable Ubuntu Pro Notices

One option is to disable the notices using a configuration setting in the `ubuntu-advantage-tools` package.

1. Open the configuration file for `ubuntu-advantage-tools`:

    ```bash
    sudo nano /etc/apt/apt.conf.d/20apt-esm-hook.conf
    ```

2. Inside the file, find the `enabled` setting and change it from `true` to `false`:

    ```plaintext
    // Enable/disable advertising for Ubuntu Pro.
    APT::Update::Post-Invoke-Success:: "ubuntu-security-status || true";
    ```

    Change the setting to:

    ```plaintext
    APT::Update::Post-Invoke-Success:: "/bin/true";
    ```

3. Save and exit the file (`Ctrl + X`, then `Y` and `Enter`).

After this, you should no longer see Ubuntu Pro messages when using `apt`.

### Option 2: Remove the `ubuntu-advantage-tools` Package

If you'd prefer a more permanent solution, you can remove the `ubuntu-advantage-tools` package entirely.

1. Uninstall the package with the following command:

    ```bash
    sudo apt-get remove ubuntu-advantage-tools
    ```

2. Confirm the removal when prompted.

After removing this package, the Ubuntu Pro advertisement will no longer appear when using `apt`.

### Final Thoughts

Ubuntu Pro is a useful service for enterprise users, but not everyone needs the frequent reminders. Whether you choose to disable the ad through configuration or remove the related package entirely, you can now enjoy a cleaner and distraction-free `apt` update experience.
