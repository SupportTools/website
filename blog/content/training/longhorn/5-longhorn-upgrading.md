---
title: "Upgrading Longhorn"
date: 2025-01-06T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Upgrade"]
categories:
- Longhorn
- Kubernetes
- Upgrade
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to upgrading Longhorn, covering planning, the upgrade process, and rollback options."
more_link: "yes"
url: "/training/longhorn/upgrading/"
---

In this section of the **Longhorn Basics** course, we will cover the steps for upgrading Longhorn, including planning, the upgrade process, and rollback options.

<!--more-->

# Upgrading Longhorn

## Course Agenda

This section is divided into three parts:

1. **Planning an Upgrade**
2. **Longhorn Upgrade Process**
3. **Longhorn Rollback Process**

---

## Planning an Upgrade

Proper planning is essential to prevent downtime or data loss during an upgrade. Follow these steps:

### 1. Read the Release Notes
- Review the release notes for the target version to understand breaking changes and new features.

### 2. Check Version Compatibility
- Follow Longhorn’s versioning compatibility rules.
  - Example: You cannot upgrade directly from v1.0 to v1.5. Upgrade incrementally (v1.0 → v1.1 → v1.2 → ...).
  - Versioning rules are documented in the [Longhorn documentation](https://longhorn.io/docs/).

### 3. Review Feature Changes
- Understand changes between versions that may impact your environment.
  - Example: Older versions used an older NFS server model, while newer versions use a `share manager statefulset` for better performance and scalability.

### 4. Test in a Non-Production Environment
- Perform the upgrade in a test environment first.
- Allow sufficient time for testing before upgrading production systems.

---

## Longhorn Upgrade Process

Upgrades should follow the same method used for installation. For example:

- **Rancher Apps & Marketplace**: Upgrade using Rancher.
- **Helm**: Upgrade using Helm.

The upgrade process itself remains consistent, regardless of the method used.

### Upgrading Longhorn Using Helm

If Longhorn was installed using Helm, follow these steps:

1. Use the following command to upgrade:
   ```bash
   helm upgrade longhorn longhorn/longhorn --namespace longhorn-system --version <target_version>
   ```

2. **Note**:
   - The command is similar to the Helm install command, with `install` replaced by `upgrade`.
   - Always document installation commands for easy reference during upgrades.

---

## Longhorn Rollback Process

Longhorn does not officially support rolling back to a previous version. The recommended method is to restore from a backup. However, rollbacks may be possible under specific conditions.

### 1. Version Compatibility
- Rollbacks must follow versioning compatibility rules.
  - Example: Roll back from v1.5 to v1.4, then to v1.3 if needed.

### 2. Best-Effort Testing
- Rollbacks are not tested for every release. They may not work as expected in all cases.

### 3. Engine Data Structure Changes
- If Longhorn engine data structures have been upgraded, rollbacks may not be possible.
- In such cases, restoring from a backup is the only option.

---

## Summary

Upgrading Longhorn requires careful planning, execution, and fallback strategies. Always:

1. Review release notes and versioning rules.
2. Test upgrades in a non-production environment.
3. Document installation and upgrade commands for future reference.
4. Be prepared to restore from backups if a rollback is not feasible.

In the next section, we will explore more advanced Longhorn features and functionalities.

