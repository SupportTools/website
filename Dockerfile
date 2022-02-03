FROM ubuntu:latest AS builder

ARG TARGETPLATFORM
ARG TARGETARCH

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

COPY build.sh /tmp/
RUN chmod u+x /tmp/build.sh && /tmp/build.sh $TARGETARCH

COPY ./blog/ /site
WORKDIR /site
RUN hugo

FROM wernight/alpine-nginx-pagespeed:latest
COPY ./conf/default.conf /etc/nginx/conf.d/default.conf
COPY ./conf/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /site/public /etc/nginx/html
WORKDIR /var/www/site

EXPOSE 8080
EXPOSE 8443