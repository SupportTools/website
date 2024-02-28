FROM thegeeklab/hugo:0.122.0 AS hugo-builder

# Copy the source code
COPY ./blog/ /site

# Set the working directory
WORKDIR /site

# Build the site
RUN hugo

# Use a full-featured base image for building
FROM golang:1.21.6-alpine3.18 AS go-builder

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
RUN GOOS=linux go build -ldflags "-X github.com/supporttools/website/pkg/health.version=$VERSION -X github.com/supporttools/website/pkg/health.GitCommit=$GIT_COMMIT -X github.com/supporttools/website/pkg/health.BuildTime=$BUILD_DATE" -o /bin/webserver

# Start from scratch for the runtime stage
FROM scratch

# Set the working directory to /app
WORKDIR /app

# Copy the built binary and config file from the builder stage
COPY --from=go-builder /bin/webserver /app/webserver

# Copy the website from the hugo-builder stage
COPY --from=hugo-builder /site/public /app/public

# Copy the /etc/passwd file from the builder stage to run as a non-root user
COPY --from=0 /etc/passwd /etc/passwd
USER appuser

# Set the binary as the entrypoint of the container
ENTRYPOINT ["/app/webserver"]