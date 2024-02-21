FROM hugomods/hugo:exts AS builder

COPY ./blog/ /site
WORKDIR /site
RUN hugo

FROM openbridge/nginx:latest
COPY --from=builder /site/public /usr/share/nginx/html
COPY main.conf /etc/nginx/conf.d/default.conf