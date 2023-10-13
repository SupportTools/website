---
title: "Using a resized block volume in Longhorn.IO"
date: 2023-10-13T13:45:00-05:00
draft: false
tags: ["Longhorn.IO", "Storage", "Kubernetes", "RKE2", "Dell R720xd"]
categories:
- Longhorn
- Storage
- Kubernetes
author: "Matthew Mattox - mattox@support.tools."
description: "Managing resized block volumes in Longhorn.IO with RKE2 on Dell R720xd servers."
---

For my RKE2 clusters, but because I'm running on physical servers (3 x Dell R720xd with 12x3TB SAS drives), I have to use Longhorn.IO for storage. I have a few block volumes that I need to resize.

## Resizing a Longhorn Block Volume

To resize a Longhorn block volume, you'll need to do the following:

- **Resize the PVC:** Resize the volume using the `kubectl` command-line tool. For example, to resize a volume named `my-volume` to 100GB, use the following command:

```bash
kubectl patch persistentvolumeclaim my-volume -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'
```

NOTE: The volume may take a few minutes to resize and reflect the new size in the Longhorn UI. You should restart the pod that uses the volume for the new size to be reflected in the pod.

## References

- [Longhorn.IO Documentation](https://longhorn.io/docs/)
- [Longhorn Expansion Documentation](https://longhorn.io/docs/1.5.1/volumes-and-nodes/expansion/)
