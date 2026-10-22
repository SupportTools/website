# syntax=docker/dockerfile:1
# Base images come through Harbor's Docker Hub proxy cache. Modules come from
# GOPROXY: pass the in-cluster Athens when building on an ARC runner; a
# workstation build falls back to proxy.golang.org (checksummed by go.sum).
FROM harbor.support.tools/dockerhub/library/golang:1.25-alpine AS builder
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY} CGO_ENABLED=0 GOOS=linux
WORKDIR /src
RUN apk add --no-cache ca-certificates && apk upgrade --no-cache ca-certificates-bundle
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /out/blog-metrics-exporter ./cmd/blog-metrics-exporter

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /out/blog-metrics-exporter /blog-metrics-exporter
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/blog-metrics-exporter"]
