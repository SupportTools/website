IMAGE ?= harbor.support.tools/supporttools/blog-metrics-exporter
GOPROXY ?= https://proxy.golang.org,direct

.PHONY: test image

# -count=1: the bot-filter drift test reads ../../analytics/bot-filter.hogql,
# which Go's test cache does not track.
test:
	go vet ./...
	go test -count=1 ./...

image: test
	@test -n "$(TAG)" || { echo "usage: make image TAG=x.y.z"; exit 1; }
	docker build --build-arg GOPROXY=$(GOPROXY) -t $(IMAGE):$(TAG) .
	docker push $(IMAGE):$(TAG)
