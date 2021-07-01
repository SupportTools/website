FROM alpine:latest as build
LABEL maintainer Matthew Mattox mmattox@support.tools

ENV HUGO_VERSION 0.18
ENV HUGO_BINARY hugo_${HUGO_VERSION}_Linux-64bit.tar.gz

##RUN sed -i 's/http\:\/\/dl-cdn.alpinelinux.org/https\:\/\/alpine.global.ssl.fastly.net/g' /etc/apk/repositories
##RUN apk add --update wget ca-certificates
##RUN wget https://github.com/spf13/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_Linux-64bit.tar.gz
WORKDIR /root/
COPY hugo_0.18_Linux-64bit.tar.gz /root/
RUN tar xvzf hugo_0.18_Linux-64bit.tar.gz
RUN cp hugo_0.18_linux_amd64/hugo_0.18_linux_amd64 /usr/bin/hugo

COPY ./blog/ /site
WORKDIR /site
RUN /usr/bin/hugo
FROM nginx:alpine
LABEL maintainer Matthew Mattox mmattox@support.tools
COPY ./conf/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site/public /var/www/site
WORKDIR /var/www/site
