---
title: "Increasing max_user_watches for Large Workspaces in Visual Studio Code"
date: 2024-05-22T12:45:00-05:00
draft: false
tags: ["max_user_watches", "Ubuntu", "Visual Studio Code", "VS Code", "File Watching"]
categories:
- DevOps
- Scripting
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to increase the max_user_watches value on Ubuntu to handle large workspaces in Visual Studio Code."
more_link: "yes"
---

Learn how to increase the max_user_watches value on Ubuntu to handle large workspaces in Visual Studio Code. This guide will help you resolve file-watching issues in VS Code.

<!--more-->

# [Increasing max_user_watches for Large Workspaces in Visual Studio Code](#increasing-max-user-watches-for-large-workspaces-in-visual-studio-code)

Visual Studio Code may encounter issues watching for file changes in large workspaces. To resolve this, we must increase Ubuntu's' `max_user_watches` value.

## [Understanding the Issue](#understanding-the-issue)

Visual Studio Code might need help monitoring file changes when working with large workspaces due to the limited number of inotify watches. This can be fixed by increasing the `max_user_watches` value.

## [Visual Studio Code Documentation](#visual-studio-code-documentation)

For more details on file watching and related settings, refer to the [VS Code documentation](https://code.visualstudio.com/docs).

## [Configuring max_user_watches](#configuring-max_user_watches)

Rather than editing `/etc/sysctl.conf`, we will create a new configuration file:

```bash
sudo nano /etc/sysctl.d/60-fs-inotify.conf
```

Add the following content to the file:

```ini
fs.inotify.max_user_watches = 524288
```

## [Reloading the Configuration](#reloading-the-configuration)

To apply the changes, reload the system configuration with:

```bash
sudo sysctl --system
```

Following these steps can increase the `max_user_watches` value, allowing Visual Studio Code to handle large workspaces more effectively.
