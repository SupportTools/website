FROM alpine:latest as build
WORKDIR /root/
COPY hugo_0.18_Linux-64bit.tar.gz /root/
RUN tar xvzf hugo_0.18_Linux-64bit.tar.gz
RUN cp hugo_0.18_linux_amd64/hugo_0.18_linux_amd64 /usr/bin/hugo
COPY ./blog/ /site
WORKDIR /site
RUN /usr/bin/hugo
FROM nginx:alpine
COPY ./conf/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site/public /var/www/site
WORKDIR /var/www/site