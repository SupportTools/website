---
title: "How to password protect a file in Linux"
date: 2022-07-11T19:37:00-05:00
draft: false
tags: ["Linux"]
categories:
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "How to password protect a file in Linux"
more_link: "yes"
---

You can password-protect any type of file in Linux, which is useful if you want to store it in the cloud or carry it around in a USB stick.

<!--more-->
# [Steps](#steps)
With Linux, we will encrypt a file using gpg, which is part of GnuPG.

```bash
gpg -c filename.txt
```

Consider the following scenario: I have a file called my-personal-info.txt

```bash
gpg -c my-personal-info.txt
```

Upon running the command, the following output is displayed:
    
```bash
$ gpg -c my-personal-info.txt 
Enter passphrase:
Repeat passphrase:
```

gpg has now created a file called my-personal-info.txt.gpg, which has been encrypted. The original file is still there, so you may want to erase it, transport only the encrypted file, or e-mail the encrypted file.

To decrypt a file just enter this command.

```bash
gpg -d my-personal-info.txt.gpg
```

A new copy of the file will be created after you enter your password or passphrase. The idea of storing passwords to important sites in this way is a good one.