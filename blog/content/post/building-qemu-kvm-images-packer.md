---
title: "Building Qemu KVM Images with Packer"  
date: 2024-10-05T19:26:00-05:00  
draft: false  
tags: ["Qemu", "KVM", "Packer", "Virtualization", "Infrastructure"]  
categories:  
- Virtualization  
- Infrastructure  
- Automation  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to use Packer to automate the creation of Qemu KVM images, streamlining your infrastructure deployments with custom-built virtual machine images."  
more_link: "yes"  
url: "/building-qemu-kvm-images-packer/"  
---

Building custom Qemu KVM images with Packer is an efficient way to automate the creation of virtual machine images, enabling you to define repeatable, version-controlled images for your infrastructure. Packer allows you to automate image building across multiple platforms, ensuring consistency and reliability in your virtual machine environment. In this post, we’ll explore how to create a Qemu KVM image using Packer and customize it for your specific needs.

<!--more-->

### Why Use Packer for Building Qemu KVM Images?

Packer streamlines the process of creating custom VM images. By using Packer, you can automate the building process, maintain consistent configurations, and reduce the time spent manually managing image creation. Whether you're deploying to a production environment or managing a homelab, Packer helps ensure that your virtual machines are built the same way every time.

### Step 1: Install Packer and Qemu

#### 1. **Install Packer**

Packer is available for most platforms. To install it, download the latest version from [HashiCorp’s Packer website](https://www.packer.io/downloads) and follow the installation instructions for your operating system.

For Linux:

```bash
curl -LO https://releases.hashicorp.com/packer/1.x.x/packer_1.x.x_linux_amd64.zip
unzip packer_1.x.x_linux_amd64.zip
sudo mv packer /usr/local/bin/
```

#### 2. **Install Qemu and KVM**

Install Qemu and KVM on your system if they are not already installed. For Debian/Ubuntu-based distributions:

```bash
sudo apt-get update
sudo apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils virt-manager
```

For RedHat/CentOS-based distributions:

```bash
sudo yum install -y qemu-kvm libvirt libvirt-python libguestfs-tools virt-install
```

### Step 2: Configure the Packer Template

Packer templates define how to build your Qemu KVM image. Create a `packer-qemu-template.json` file with the following structure:

```json
{
  "builders": [
    {
      "type": "qemu",
      "iso_url": "http://releases.ubuntu.com/24.04/ubuntu-24.04-live-server-amd64.iso",
      "iso_checksum": "sha256:your-checksum-here",
      "output_directory": "output-qemu",
      "shutdown_command": "echo 'ubuntu' | sudo -S shutdown -P now",
      "disk_size": 10000,
      "format": "qcow2",
      "accelerator": "kvm",
      "ssh_username": "ubuntu",
      "ssh_password": "password",
      "ssh_wait_timeout": "20m",
      "vm_name": "ubuntu-kvm",
      "http_directory": "http",
      "boot_wait": "10s",
      "boot_command": [
        "<esc><wait>",
        "linux /casper/vmlinuz --- autoinstall ds=nocloud-net;s=http://{{ .HTTPIP }}:{{ .HTTPPort }}/ <enter>"
      ]
    }
  ],

  "provisioners": [
    {
      "type": "shell",
      "inline": [
        "sudo apt-get update",
        "sudo apt-get install -y nginx"
      ]
    }
  ]
}
```

This template specifies a few key components:

- **ISO URL**: URL of the OS image to use (in this case, Ubuntu 24.04).
- **Disk Size**: Size of the disk in MB.
- **SSH Settings**: Username, password, and SSH timeout settings for connecting to the VM.
- **Provisioners**: The steps to install packages or customize the VM. In this case, we’re installing `nginx`.

### Step 3: Start the Packer Build

Once the template is ready, run the following command to start the Packer build:

```bash
packer build packer-qemu-template.json
```

Packer will boot the VM from the provided ISO, install the operating system, and run any provisioning scripts. After the build process completes, the Qemu image will be saved in the specified output directory (`output-qemu`).

### Step 4: Customize the Image

You can further customize your Qemu KVM image by adding additional provisioners to the Packer template. For example, you can install Docker, configure networking, or apply security patches.

Add a shell provisioner to install Docker:

```json
{
  "type": "shell",
  "inline": [
    "curl -fsSL https://get.docker.com -o get-docker.sh",
    "sh get-docker.sh"
  ]
}
```

This allows you to build images that are ready for your specific workloads, such as containerized applications, databases, or CI/CD environments.

### Step 5: Use the Built Image

Once Packer finishes building the image, you can use the `.qcow2` image file in your KVM environment. Start a new VM using `virt-manager` or `virsh` with the custom image:

```bash
virt-install --name ubuntu-vm --memory 2048 --vcpus 2 --disk path=output-qemu/ubuntu-kvm.qcow2 --import --os-type linux --os-variant ubuntu20.04
```

This command creates a new VM using the Qemu image built by Packer.

### Final Thoughts

Using Packer to build Qemu KVM images automates and simplifies the process of creating custom virtual machine images for your infrastructure. By defining the image creation process in code, you can ensure consistency, repeatability, and scalability in your virtualized environments. Whether you're deploying VMs in a production environment or setting up a homelab, Packer and Qemu offer a flexible and powerful solution.
