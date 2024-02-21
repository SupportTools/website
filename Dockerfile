FROM supporttools/kube-builder:latest AS builder

WORKDIR /root
COPY hugo_*.tar.gz /root/hugo.tar.gz
RUN tar xvzf hugo.tar.gz && \
    cp hugo /usr/bin/hugo && \
    chmod +x /usr/bin/hugo && \
    rm -rf hugo.tar.gz

COPY ./blog/ /site
WORKDIR /site
RUN hugo


FROM openbridge/nginx:latest
COPY --from=builder /site/public /usr/share/nginx/html
COPY main.conf /etc/nginx/conf.d/default.conf