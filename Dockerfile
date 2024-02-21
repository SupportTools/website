FROM thegeeklab/hugo:0.122.0 AS builder

COPY ./blog/ /site
WORKDIR /site
RUN hugo --minify --gc --cleanDestinationDir --destination /site/public

FROM nginx:alpine-slim
COPY --from=builder /site/public /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf