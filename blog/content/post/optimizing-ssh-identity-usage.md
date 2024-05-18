---
title: "Optimizing SSH Identity Usage in Docker Builds"
date: 2024-05-18
draft: false
tags: ["docker", "SSH"]
categories:
- Docker
- SSH
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to efficiently manage SSH identities in Docker builds to avoid conflicts and streamline your workflow."
more_link: "yes"
url: "/optimizing-ssh-identity-usage/"
---

# [Optimizing SSH Identity Usage in Docker Builds](#optimizing-ssh-identity-usage-in-docker-builds)

Discover how to optimize and streamline your Docker build process by effectively managing multiple SSH identities within your workflow.

<!--more-->

In previous posts, I shared tips on SSH forwarding with `docker build` and utilizing multiple SSH identities with Git. While these techniques are invaluable individually, combining them can lead to conflicts. Specifically, when using SSH in a Docker build, the first SSH identity in `ssh-agent` is utilized, potentially causing discrepancies. Here's how I tackled this issue effectively.

To address this concern, we must instruct SSH, operating within a Docker build, on the specific identity to utilize.

To begin, it's crucial to make the private key accessible to `docker build`. This can be achieved using a secret:

```sh
docker build \
    --ssh default \
    --secret id=ssh_id,src=$(HOME)/.ssh/id_other \
    --build-arg GIT_SSH_COMMAND="ssh -i /run/secrets/ssh_id -o IdentitiesOnly=yes" \
    .
```

Subsequently, the `Dockerfile` needs to be modified to specify the desired identity for SSH:

```dockerfile
# Set the GIT_SSH_COMMAND environment variable.
ARG GIT_SSH_COMMAND

# Mount the ssh-agent *and* the private key secret, then execute 'npm install' (or equivalent)
RUN --mount=type=ssh \
    --mount=type=secret,id=ssh_id \
    npm install
```

For greater transparency, omit the `--secret` and `--build-arg` options when running the `docker build` command for individuals or CI pipelines not leveraging multiple identities:

```sh
docker build \
    --ssh default \
    .
```

In a Makefile context, the implementation would resemble this:

```makefile
# If you're using more than one SSH identity, set DOCKER_SSH_ID_SECRET to point to the ~/.ssh/id_whatever file.
ifdef DOCKER_SSH_ID_SECRET
_DOCKER_BUILD_SECRET_ARG = --secret id=ssh_id,src=$(DOCKER_SSH_ID_SECRET)
_DOCKER_BUILD_GIT_CONFIG_ARG = --build-arg GIT_SSH_COMMAND="ssh -i /run/secrets/ssh_id -o IdentitiesOnly=yes"
endif

docker-image:
 docker build \
  $(_DOCKER_BUILD_SECRET_ARG) \
  $(_DOCKER_BUILD_GIT_CONFIG_ARG) \
  --ssh default \
  .
```
