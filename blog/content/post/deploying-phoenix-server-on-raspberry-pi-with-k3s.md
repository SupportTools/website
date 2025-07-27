---
title: "Deploying a Phoenix Server on Raspberry Pi with k3s"
date: 2024-05-18T02:26:00-05:00
draft: false
tags: ["k3s", "Raspberry Pi", "Docker", "Elixir", "Phoenix"]
categories:
- DevOps
- Scripting
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to deploy a Phoenix server on Raspberry Pi using k3s and Docker, from app creation to Kubernetes deployment."
more_link: "yes"
---

Learn how to deploy a Phoenix server on Raspberry Pi using k3s and Docker, from app creation to Kubernetes deployment. This guide provides detailed steps for setting up your environment and deploying your application.

<!--more-->

# [Deploying a Phoenix Server on Raspberry Pi with k3s](#deploying-a-phoenix-server-on-raspberry-pi-with-k3s)

In this guide, we'll deploy a Phoenix server on a Raspberry Pi using K3s and Docker. This setup is similar to deploying a Node.js server.

## [Creating the Phoenix App](#creating-the-phoenix-app)

You can create the app inside the Docker container or on a different machine, but we'll do it locally. First, install Erlang, Elixir, and Phoenix:

```bash
mix phx.new phoenix_server --no-ecto
```

If you answer 'Y' to the "Fetch and install dependencies?" prompt, it will take a while but save time during the Docker build step.

## [Dockerfile](#dockerfile)

Create a Dockerfile with the following content:

```dockerfile
# Use an official Elixir runtime as a parent image
FROM elixir:latest

# Install hex, rebar, and phoenix.
RUN mix local.hex --force \
    && mix local.rebar --force \
    && mix archive.install --force hex phx_new 1.4.12

# Install nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.35.2/install.sh | bash

# Install node
ENV NODE_VERSION=v12.14.1
RUN set -e \
    && NVM_DIR="$HOME/.nvm" \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install $NODE_VERSION

# Create an app directory and copy the Elixir projects into it
RUN mkdir /app
COPY . /app
WORKDIR /app

# Compile the project
RUN mix do deps.get, compile

RUN set -e \
    && NVM_DIR="$HOME/.nvm" \
    && . "$NVM_DIR/nvm.sh" \
    && cd assets \
    && npm install \
    && node node_modules/webpack/bin/webpack.js --mode development

EXPOSE 4000

CMD ["/app/docker-entrypoint.sh"]
```

## [docker-entrypoint.sh](#docker-entrypoint-sh)

Create a `docker-entrypoint.sh` script with the following content:

```bash
#!/bin/bash

set -e

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

cd /app
exec mix phx.server
```

Make it executable:

```bash
chmod +x docker-entrypoint.sh
```

Note that the above script runs the Phoenix app in development mode.

## [Creating the Docker Image](#creating-the-docker-image)

Build the Docker image using:

```bash
docker build -t phoenix-server .
```

## [Pushing to a Private Docker Repository](#pushing-to-a-private-docker-repository)

Tag and push the Docker image to your private repository:

```bash
docker tag phoenix-server rpi201:5000/phoenix-server
docker push rpi201:5000/phoenix-server
```

## [Creating a Deployment](#creating-a-deployment)

Create a deployment in Kubernetes:

```bash
sudo kubectl create deployment phoenix-server --image=rpi201:5000/phoenix-server
```

## [Exposing the Deployment](#exposing-the-deployment)

Expose the deployment to make it accessible:

```bash
sudo kubectl expose deployment phoenix-server --port 4000
```

## [Checking the Deployment](#checking-the-deployment)

Verify that the deployment is working:

```bash
sudo kubectl get endpoints phoenix-server
curl 10.42.3.15:4000
```

For more details, refer to the [PSPDFKit blog post](https://pspdfkit.com/blog/2018/how-to-run-your-phoenix-application-with-docker/).

Following these steps, you can successfully deploy a Phoenix server on Raspberry Pi using k3s and Docker.
