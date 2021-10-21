FROM harbor.support.tools/dockerhub-proxy/library/ubuntu:latest AS builder

ARG TARGETPLATFORM
ARG TARGETARCH
#ARG TARGETVARIANT
#RUN printf "I'm building for TARGETPLATFORM=${TARGETPLATFORM}" \
#    && printf ", TARGETARCH=${TARGETARCH}" \
#    && printf ", TARGETVARIANT=${TARGETVARIANT} \n" \
#    && printf "With uname -s : " && uname -s \
#    && printf "and  uname -m : " && uname -mm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -yq --no-install-recommends \
    apt-utils \
    curl \
    wget \
    openssl \
    nano \
    git \
    bash \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN if [[ ${TARGETARCH} == "amd64" ]]; then wget --no-check-certificate https://github.com/gohugoio/hugo/releases/download/v0.88.1/hugo_0.88.1_Linux-64bit.tar.gz; fi
RUN if [[ ${TARGETARCH} == "arm64" ]]; then wget --no-check-certificate https://github.com/gohugoio/hugo/releases/download/v0.88.1/hugo_0.88.1_Linux-ARM64.tar.gz; fi
RUN set -x && \
  tar xvzf hugo_*.tar.gz && \
  cp hugo /usr/bin/hugo && \
  chmod +x /usr/bin/hugo && \
  rm -rf hugo_*.tar.gz

COPY ./blog/ /site
WORKDIR /site
RUN hugo

FROM harbor.support.tools/dockerhub-proxy/wernight/alpine-nginx-pagespeed:latest
COPY ./conf/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /site/public /etc/nginx/html
WORKDIR /var/www/site