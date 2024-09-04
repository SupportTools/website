---

title: "Create a Bootable Linux USB from ISO with DD"
date: 2024-09-04T19:26:00-05:00
draft: true
tags: ["Linux", "USB", "dd", "ISO", "bootable"]
categories:
- Linux
- USB
author: "Matthew Mattox - <mmattox@support.tools>."
description: "Learn how to create a bootable USB using the dd command on Linux."
more_link: "yes"
url: "/create-bootable-usb-dd/"
---

Creating a bootable USB drive from an ISO file can be quickly done using the `dd` command on Linux. This method copies the ISO directly onto the USB drive, making it bootable.

### The dd command

The command below copies the content of the ISO file `ubuntu-24.04-desktop-amd64.iso` to the USB device located at `/dev/sdX`. Make sure you've correctly identified the USB device to avoid overwriting critical data.

```bash
sudo dd if=ubuntu-24.04-desktop-amd64.iso of=/dev/sdX bs=1M status=progress && sudo sync
```

This command does the following:

- `if=` specifies the input file (the ISO file).
- `of=` specifies the output file (the USB device).
- `bs=1M` sets the block size to 1 megabyte, optimizing the copy process.
- `status=progress` provides real-time updates on the progress of the operation.
- `&& sudo sync` ensures that the data is fully written to the USB before the command completes.

### Final Thoughts

Depending on the size of the ISO file and the speed of the USB drive, the process may take several minutes. Once complete, your USB drive will be ready to boot into your chosen Linux distribution.
