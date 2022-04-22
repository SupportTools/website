FROM supporttools/kube-builder:latest AS builder

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /root
COPY hugo_*.tar.gz /root/
RUN tar xvzf hugo_*.tar.gz && \
cp hugo /usr/bin/hugo && \
chmod +x /usr/bin/hugo && \
rm -rf hugo_*.tar.gz

COPY ./blog/ /site
WORKDIR /site
RUN hugo

FROM nginx:latest
COPY --from=builder /site/public /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf