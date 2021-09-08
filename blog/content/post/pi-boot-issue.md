+++
Categories = ["Raspberry Pi", "Raspbian", "Linux"]
Tags = ["raspberry", "pi", "raspbian", "linux"]
date = "2021-09-08T04:24:00+00:00"
more_link = "yes"
title = "Raspberry Pi Boot Issue - Root account locked!"
+++

After a power outage, my [Raspberry Pi 400 Keyboard Computer](https://chicagodist.com/products/raspberry-pi-400?variant=32615079739471&gclid=CjwKCAjwvuGJBhB1EiwACU1AiXEUSYXNhjyvm-dqgy78kIz7TkfSkO2iPhVSAZ7CysvXoiDpFhNTGBoCiIwQAvD_BwE) wouldn't boot. The Pi would get stuck at boot with the following error message.

```
Cannot open access to console, the root account is locked.
```

<!--more-->
While not too descriptive, the error message asked me to use sulogin and run journalctl -xb; however, there was no shell to run or list anything.

Note: You will need access to a display, keyboard, and a laptop/desktop to do the following steps

- Retrieve your SD card from the Pi and sing an adapter mount the card to your PC, Mac or Linux.
- You should be able to see the /boot partition of your SD card.
- Locate the file cmdline.txt and add the following at the end of the line init=/bin/sh Note: Do not create a new line; add the above to the end of the current line.
- Load the SD card back to your pi and boot up.
- You should now get a root shell prompt. From here, you can undo the changes to /etc/fstab or whatever else that initially broke your system

In some cases, you will not be able to save your changes, and the system will complain of a read-only file system. If you get that, move to the following sections.

A raspberry pi SD card will have two primary partitions; since we cannot read the partition table directly, you must manually locate the device for your root and boot partitions. You can do this by going to the /dev directory, and you should see something similar to mmcblk0p1 & mmcblk0p2. The second device mmcblk0p2 will be your root partition. You need to remount this with read/write permissions.

```
mount -o remount,rw /dev/mmcblk0p2 /
```

Once this is remounted, go ahead and edit your /etc/fstab and save it.

Before you exit, make sure you revert the change to the cmdline.txt in the /boot partition. You may need to mount that in read/write mode as well before you can change it.

```
mount -o remount,rw /dev/mmcblk0p1 /boot
```

Alternatively, you can revert the change to cmdline.txt on your laptop or desktop.

If everything goes well, you should be able to boot back your Pi in a usual way.