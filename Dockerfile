FROM supporttools/kube-builder:latest AS builder

#ARG HUGO=0.98.0

WORKDIR /root
COPY hugo_*.tar.gz /root/hugo.tar.gz
RUN tar xvzf hugo.tar.gz && \
cp hugo /usr/bin/hugo && \
chmod +x /usr/bin/hugo && \
rm -rf hugo.tar.gz

COPY ./blog/ /site
WORKDIR /site
RUN hugo


FROM ubuntu/nginx:latest

ENV DEBIAN_FRONTEND=noninteractive
RUN apt update && apt install -y \
    wget \
    gzip \
    libmaxminddb0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=anroe/nginx-geoip2:1.19.2-geoip2-3.3 /usr/lib/nginx/modules/ngx_http_geoip2_module.so /usr/lib/nginx/modules/ngx_http_geoip2_module.so
COPY --from=builder /site/public /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf