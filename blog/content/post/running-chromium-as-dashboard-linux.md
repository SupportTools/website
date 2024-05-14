---
title: "Running Chromium as a Grafana Dashboard"
date: 2024-05-14T19:26:00-05:00
draft: false
tags: ["Chromium", "Dashboard", "Linux", "Grafana"]
categories:
- Chromium
- Dashboard
- Linux
- Grafana
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to set up Chromium in kiosk mode to run a Grafana dashboard on a TV stand in your office, displaying important metrics automatically."
more_link: "yes"
---

Learn how to set up Chromium in kiosk mode to run a Grafana dashboard on a TV stand in your office, displaying important metrics automatically.

<!--more-->
# [Running Chromium as a Grafana Dashboard](#running-chromium-as-a-grafana-dashboard)

In my office, I have a dedicated TV stand displaying a Grafana dashboard that serves as an “information radiator.” This setup shows various critical metrics such as the status of Jenkins jobs, clocks for different time zones (since Electric Imp operates globally), and more.

The dashboard is powered by an Acer nettop running Chromium in kiosk mode. Here’s how I configured it to start everything automatically.

## Setting Up the Dashboard Web Server

The Grafana dashboard is hosted using Dashing, and I use an Upstart script (located at `/etc/init/dashing.conf`) to ensure it starts at boot:

```
#!upstart
description "Dashing dashboards"
author "Roger Lipscombe"

respawn
start on runlevel [23]

setuid dashboard
setgid dashboard

script
  cd /home/dashboard/dashboard/
  dashing start
end script
```

Ensure you have a `dashboard` user and that Dashing is installed at `/home/dashboard/dashboard`.

## Launching X

With the web server set up, I needed a way to display the Grafana dashboard. This involves running an X session on the device.

This is handled by creating two files. The first file, `/etc/init/startx.conf`, starts the X session:

```
#!upstart
description "Start X without a display manager or a window manager"
author "Roger Lipscombe"

# start/stop lifted from Mint's mdm.conf:
start on ((filesystem
           and runlevel [!06]
           and started dbus
           and (drm-device-added card0 PRIMARY_DEVICE_FOR_DISPLAY=1
                or stopped udev-fallback-graphics))
          or runlevel PREVLEVEL=S)

stop on runlevel [016]

script
    USER="dashboard"
    exec /bin/su -s /bin/sh -l -c "/usr/bin/startx" $USER
end script
```

## Running Chromium

Chromium is launched from `/home/dashboard/.xinitrc`:

```
#!/bin/sh

# Disable screen blanking and power saving
xset s off
xset -dpms

# Optionally rotate the screen
xrandr --output HDMI-1 --rotate left

# Hide the mouse cursor
unclutter -grab &

# Start the web browser with the dashboard URL...
while true; do
    # Pause to allow the network to stabilize and to perform remote maintenance if needed
    sleep 5

    # Ensure Chromium exits cleanly
    sed -i 's/"exited_cleanly": false/"exited_cleanly": true/' \
        ~/.config/chromium/Default/Preferences

    # Launch Chromium in kiosk mode
    chromium-browser --kiosk https://grafana.support.local/
done
```

By following these steps, you can set up an automated Grafana dashboard using Chromium in kiosk mode, displaying key information on a TV stand in your office.

For more tips and guides on Linux system setup and management, keep an eye on my blog!
