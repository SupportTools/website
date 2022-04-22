FROM ubuntu:latest AS builder

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

RUN wget --no-check-certificate https://github.com/gohugoio/hugo/releases/download/v0.97.3/hugo_0.97.3_Linux-64bit.tar.gz && \
tar xvzf hugo_*.tar.gz && \
cp hugo /usr/bin/hugo && \
chmod +x /usr/bin/hugo && \
rm -rf hugo_*.tar.gz

COPY ./blog/ /site
WORKDIR /site
RUN hugo

FROM nginx:latest
COPY --from=builder /site/public /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf