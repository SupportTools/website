---
title: "Setting up an AP7930 PDU with Home Assistant"
date: 2024-10-30T10:00:00-05:00
draft: false
tags: ["Home Assistant", "PDU", "Automation", "SNMP"]
categories:
- Home Automation
- Network Devices
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to integrate an AP7930 Power Distribution Unit (PDU) with Home Assistant for remote control and automation of power outlets."
more_link: "yes"
url: "/setup-ap7930-pdu-home-assistant/"
---

## Overview  

Managing multiple devices efficiently can be challenging, especially on a workbench filled with projects. This guide walks through integrating a used **AP7930 PDU** with **Home Assistant**. The AP7930 allows for **remote control of power outlets** and **load monitoring**, making it a great tool for power management, even though it’s likely overkill!

---

## Selecting a PDU  

Here are key considerations when selecting a PDU:

- **Input Voltage**: Ensure it matches your power system (120V for most North American homes).  
- **Plug Type**: The AP7930 uses a **NEMA L5-20P plug**—you may need an adapter or a matching outlet.  
- **Features**: Look for **metered** (monitors power usage) and **switched** (remote on/off control) PDUs. These features may increase the PDU’s power consumption but are essential for automation.

> **Note**: Always consult an electrician if you're uncertain about power wiring and code compliance.

---

## Performing a Factory Reset  

The **AP7930 reset process** is tricky. Here’s a simplified method if the serial cable doesn’t work:

1. **Find the IP address** using DHCP leases or **Wireshark** by filtering for the MAC address on the PDU label.
2. If you can access the PDU via a browser using the default credentials (`username: apc` / `password: apc`), skip to the **firmware update** step.
3. **Install SNMP MIBs**:

    ```bash
    sudo apt-get install snmp-mibs-downloader
    sudo sed -i 's/mibs :/# mibs :/g' /etc/snmp/snmp.conf
    sudo wget "https://fossies.org/linux/misc/netxms-4.1.377.tar.gz/netxms-4.1.377/contrib/mibs/PowerNet-MIB.txt?m=b" -O /usr/share/snmp/mibs/PowerNet-MIB.txt
    ```

4. Verify the default SNMP string:

    ```bash
    snmpget -v 1 -c private $IP SNMPv2-MIB::sysDescr.0
    ```

5. Set up a **TFTP server** to apply the following configuration (`config.ini`):

    ```ini
    [NetworkTCP/IP]
    SystemIP = 0.0.0.0
    SubnetMask = 0.0.0.0
    DefaultGateway = 0.0.0.0
    ```

6. Use SNMP to upload and apply the configuration:

    ```bash
    snmpset -v 1 -c private $DEVICEIP PowerNet-MIB::mfiletransferConfigTFTPServerAddress.0 s $SERVERIP
    snmpset -v 1 -c private $DEVICEIP PowerNet-MIB::mfiletransferConfigSettingsFilename.0 s /config.ini
    ```

---

## Updating the Firmware  

To ensure optimal performance:

1. Download the latest firmware [here](https://www.apc.com/us/en/product/SFRPDU374_390/).  
2. Run the **executable** to update the PDU. If needed, you can manually upload the `.bin` files via **FTP**.

---

## Securing the PDU  

- Change the **default passwords** under `Administration -> Security -> Local Users`.
- Disable access for untrusted accounts.
- Use **SNMPv1** for Home Assistant (as SNMPv3 may not work with the default integration).

---

## Configuring Home Assistant  

To control the AP7930 via **Home Assistant**, update the `configuration.yaml`:

```yaml
switch:
  - platform: snmp
    name: PDU Outlet 1
    host: your_pdu_IP
    community: your_community_string
    baseoid: 1.3.6.1.4.1.318.1.1.4.4.2.1.3.1
    payload_on: 1
    payload_off: 2

sensor:
  - platform: snmp
    name: PDU Load
    host: your_pdu_IP
    community: your_community_string
    baseoid: 1.3.6.1.4.1.318.1.1.12.2.3.1.1.2.1
    unit_of_measurement: A
    value_template: "{{((value | float) / 10) | float}}"
```

- **Switches**: Control individual outlets.
- **Sensors**: Monitor power consumption.

Restart Home Assistant, and you can now automate the PDU!

---

## Conclusion  

With the **AP7930 PDU** integrated into Home Assistant, you can remotely manage power outlets, automate switching, and monitor energy usage. This setup not only adds convenience but also optimizes power management on your workbench.
