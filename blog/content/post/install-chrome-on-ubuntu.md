---
title: "How to Install Google Chrome on Ubuntu Desktop"
date: 2022-07-11T19:26:00-05:00
draft: false
tags: ["Ubuntu", "Google Chrome"]
categories:
- Linux
author: "Matthew Mattox - mmattox@support.tools."
description: "This guide explains how to install Google Chrome on a Ubuntu desktop."
more_link: "yes"
---

Google Chrome is a popular web browser developed by Google. In this guide, we will show you how to install Google Chrome on your Ubuntu desktop.

<!--more-->
# [Install](#install)
Step 1 - Update Package Lists

Before installing any new software on your Ubuntu system, it is a good idea to update the package lists to ensure that you have the latest versions of all packages. To update the package lists, open a terminal and run the following command:
    
```bash
sudo apt update
```

Step 2 - Install Google Chrome

- Download the latest version of Google Chrome for Ubuntu from the official website at https://www.google.com/chrome/.
- Once the download is complete, open the terminal and navigate to the directory where the downloaded file is saved.
- Install the Google Chrome package by running the following command:

```bash
sudo apt install ./google-chrome-stable_current_amd64.deb
```
Note that the file name may vary depending on the version of Google Chrome you downloaded.

- The installation process will begin, and you will be prompted to enter your user password to authenticate the installation.
- Once the installation is complete, you can launch Google Chrome by searching for it in the applications menu or by running the following command in the terminal:

Step 3 - Verify Installation

To verify that Google Chrome was installed successfully, open a terminal and run the following command:

```bash
google-chrome-stable --version
```

You should see the following output:

```bash
Google Chrome 91.0.4472.114
```