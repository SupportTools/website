# syntax=docker/dockerfile:1
# Fetch tiers: both images come through Harbor's Docker Hub proxy cache, pinned by
# digest. Modules come from GOPROXY: pass the in-cluster Athens when building on an
# ARC runner; a workstation build falls back to proxy.golang.org (checksummed by
# go.sum). Follow-up: build this image on an ARC job so it always uses Athens.

# CA bundle 20261020-r0 or later: earlier bundles still trust the leaked eMudhra
# emSign ECC Root CA - G3 (USN-8944-1). golang:1.25-alpine ships 20260611-r0.
FROM harbor.support.tools/dockerhub/library/alpine:3.23@sha256:21f3e19bafab57a9ff7aa9dd571dac72f868370472c10f450cc0416cc1aca553 AS certs

FROM harbor.support.tools/dockerhub/library/golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS builder
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY} CGO_ENABLED=0 GOOS=linux
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /out/blog-metrics-exporter ./cmd/blog-metrics-exporter

FROM scratch
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /out/blog-metrics-exporter /blog-metrics-exporter
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/blog-metrics-exporter"]
