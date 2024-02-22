FROM thegeeklab/hugo:0.122.0 AS builder

# Copy the source code
COPY ./blog/ /site

# Set the working directory
WORKDIR /site

# Build the site
RUN hugo

# Use the Nginx image
FROM nginx:alpine-slim

# Create a group and user
RUN addgroup -S www && adduser -S www -G www

# Set the working directory
WORKDIR /usr/share/nginx/html

# Copy the built site
COPY --from=builder /site/public .

# Copy the Nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Change the ownership of the Nginx web root to the non-root user
RUN chown -R www:www /usr/share/nginx/html /var/cache/nginx /var/run /var/log/nginx /etc/nginx/on

# Use the non-root user to run Nginx
USER www

# Expose your desired port
EXPOSE 8080

# Start Nginx
CMD ["nginx", "-c", "/etc/nginx/nginx.conf", "-g", "daemon off;"]
