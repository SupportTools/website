FROM supporttools/kube-builder:latest AS builder

ARG HUGO=0.98.0
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /root
RUN wget https://github.com/gohugoio/hugo/releases/download/v${HUGO}/hugo_${HUGO}_Linux-64bit.tar.gz && \
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