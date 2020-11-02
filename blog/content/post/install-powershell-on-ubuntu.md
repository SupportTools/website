+++
Categories = ["Ubuntu", "PowerShell"]
Tags = ["Ubuntu", "PowerShell"]
date = "2019-11-20T11:06:00+00:00"
more_link = "yes"
title = "Install PowerShell on Ubuntu"
+++

As part of my DevOps process, I needed to create some DNS records on my Windows DNS server. In order to script this out, I needed to install PowerShell on my Jenkins server which is running Ubuntu 18.04.

<!--more-->
# [Install on Ubuntu 16.04](#install-ubuntu-16-04)

## Ubuntu 16.04 - Repo
<code>
wget -q https://packages.microsoft.com/config/ubuntu/16.04/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
sudo apt-get update -y
sudo add-apt-repository universe
sudo apt-get install powershell -y
</code>

## Ubuntu 16.04 - Direct
<code>
wget https://github.com/PowerShell/PowerShell/releases/download/v6.2.3/powershell_6.2.3-1.ubuntu.16.04_amd64.deb
sudo apt-get install -f
</code>

# [Install on Ubuntu 18.04](#install-ubuntu-18-04)

## Ubuntu 18.04 - Repo
<code>
wget -q https://packages.microsoft.com/config/ubuntu/18.04/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
sudo apt update -y
sudo add-apt-repository universe
sudo apt install powershell -y
</code>

## Ubuntu 18.04 - Direct
<code>
wget https://github.com/PowerShell/PowerShell/releases/download/v6.2.3/powershell_6.2.3-1.ubuntu.18.04_amd64.deb
sudo apt install -f
</code>
