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

COPY build.sh /tmp/
RUN chmod u+x /tmp/build.sh && /tmp/build.sh $TARGETARCH

COPY ./blog/ /site
WORKDIR /site
RUN hugo

FROM harbor.support.tools/dockerhub-proxy/wernight/alpine-nginx-pagespeed:latest
COPY ./conf/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /site/public /etc/nginx/html
WORKDIR /var/www/site