FROM alpine as build
LABEL maintainer Matthew Mattox mmattox@support.tools

ENV HUGO_VERSION 0.18
ENV HUGO_BINARY hugo_${HUGO_VERSION}_Linux-64bit.tar.gz

RUN sed -i 's/http\:\/\/dl-cdn.alpinelinux.org/https\:\/\/alpine.global.ssl.fastly.net/g' /etc/apk/repositories
RUN set -x && \
  apk add --update wget ca-certificates && \
  wget https://github.com/spf13/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_Linux-64bit.tar.gz && \
  tar xvzf hugo_${HUGO_VERSION}_Linux-64bit.tar.gz && \
  cp hugo_${HUGO_VERSION}_linux_amd64/hugo_${HUGO_VERSION}_linux_amd64 /usr/bin/hugo && \
  rm -rf hugo_${HUGO_VERSION}_linux_amd64*

COPY ./blog/ /site
WORKDIR /site
RUN /usr/bin/hugo
FROM nginx:alpine
LABEL maintainer Matthew Mattox mmattox@support.tools
COPY ./conf/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site/public /var/www/site
WORKDIR /var/www/site
