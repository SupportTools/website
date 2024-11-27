# Stage 1: Build Hugo site
FROM thegeeklab/hugo:latest AS hugo-builder

# Copy the source code
COPY ./blog/ /site

# Set the working directory
WORKDIR /site

# Build the site
RUN hugo --minify --gc --cleanDestinationDir --baseURL https://support.tools

# Stage 2: Build the Go application and prepare runtime environment
FROM golang:1.22.4-alpine3.20 AS go-builder

# Install git if your project requires
RUN apk update && apk add --no-cache git

# Set the Current Working Directory inside the container
WORKDIR /src

# Copy the source code into the container
COPY . .

# Fetch dependencies using go mod if your project uses Go modules
RUN go mod download

# Version and Git Commit build arguments
ARG VERSION
ARG GIT_COMMIT
ARG BUILD_DATE

# Build the Go app with versioning information
RUN GOOS=linux GOARCH=amd64 go build -ldflags "-X github.com/supporttools/website/pkg/version.Version=$VERSION -X github.com/supporttools/website/pkg/version.GitCommit=$GIT_COMMIT -X github.com/supporttools/website/pkg/version.BuildTime=$BUILD_DATE" -o /bin/webserver
RUN chmod +x /bin/webserver

# Stage 3: Prepare final runtime image
FROM ubuntu AS runtime

# Set the working directory to /app
WORKDIR /app

# Create a non-root user and group to run the app
RUN useradd -m appuser

# Create the /var/log directory and access.log file
RUN mkdir -p /var/log && touch /var/log/access.log && chown appuser:appuser /var/log/access.log

# Copy the built binary from the go-builder stage
COPY --from=go-builder /bin/webserver /app/webserver

# Copy the website from the hugo-builder stage
COPY --from=hugo-builder /site/public /app/public

# Set ownership of the /app directory to appuser
RUN chown -R appuser:appuser /app

# Set environment variables for local dev (optional)
ENV LOG_FILE_PATH=/var/log/access.log

# User appuser to run the container securely
USER appuser

# Set the binary as the entrypoint of the container
ENTRYPOINT ["/app/webserver"]
