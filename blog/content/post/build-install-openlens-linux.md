---
title: "Build and Install OpenLens on Linux"  
date: 2024-09-04T19:26:00-05:00  
draft: false  
tags: ["OpenLens", "Linux", "Kubernetes", "Lens", "Build"]  
categories:  
- Kubernetes  
- Linux  
- Open Source  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to build and install OpenLens on Linux, an open-source alternative to Lens."  
more_link: "yes"  
url: "/build-install-openlens-linux/"  
---

If you're managing Kubernetes daily, OpenLens can give you valuable insights into your clusters. This post will guide you through building and installing OpenLens on a Linux system as an open-source alternative to Lens.

<!--more-->

### The Problem

Lens, a popular Kubernetes IDE, now requires users to create a Lens ID, which was not required before. This change has pushed many users to seek alternatives. More details about this issue can be found on GitHub: [Lens GitHub Issue #5444](https://github.com/lensapp/lens/issues/5444).

### The Solution

OpenLens is the open-source equivalent of Lens, free from proprietary components and licensed under MIT. Here’s how to build and install OpenLens on Linux.

### Automated Process

If you want to automate the process, follow these steps to install OpenLens:

1. Install `git`:

   ```bash
   sudo apt-get install -y git
   ```

2. Clone the build script from GitHub and compile the OpenLens package:

   ```bash
   git clone https://github.com/lisenet/openlens-linux-install.git
   cd ./openlens-linux-install
   ./install_openlens.sh
   ```

This will build and install OpenLens from source.

### Manual Process: Install Dependencies

For users who prefer a manual installation process, follow the steps below to build OpenLens:

#### 1. Install Build Dependencies

Install the required build dependencies for a Debian-based OS:

```bash
sudo apt-get install -y curl g++ make tar
```

#### 2. Install NVM (Node Version Manager)

To manage Node.js versions, install NVM:

```bash
curl -sS -o install_nvm.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh
bash ./install_nvm.sh
export NVM_DIR="${HOME}/.nvm"
source "${NVM_DIR}/nvm.sh"
```

#### 3. Get OpenLens Source Code

Download the OpenLens source code:

```bash
curl -sL -o openlens.tgz https://github.com/lensapp/lens/archive/refs/tags/v6.1.0.tar.gz
tar xf ./openlens.tgz
mv ./lens-* ./lens
```

Since we’re building on a Debian-based OS, we can remove the RPM build steps:

```bash
sed -i '/\"rpm\"\,/d' ./lens/package.json
```

#### 4. Build and Install OpenLens

To compile and install the OpenLens package, follow these steps:

```bash
cd ./lens
nvm install 16 && nvm use 16 && npm install -g yarn
make build
```

After building, install the generated `.deb` package:

```bash
find ./dist/ -type f -name "*.deb" -exec sudo apt-get install {} \;
```

#### 5. Clean Up

Once installed, clean up the temporary files:

```bash
cd ../
rm -rf ./lens
rm -f ./install_nvm.sh ./openlens.tgz
```

Now you can enjoy using OpenLens, the open-source version of Lens IDE!

### Final Thoughts

Migrating from Lens to OpenLens offers a license-friendly, open-source solution without the need for a Lens ID. With OpenLens, you maintain the same Kubernetes insights without any proprietary components.

## [Build and Install OpenLens on Linux](#build-and-install-openlens-on-linux)

Follow this guide to build and install OpenLens on Linux, a powerful Kubernetes IDE free of proprietary restrictions.
