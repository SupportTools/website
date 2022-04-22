#!/bin/sh

echo "Setting docker environment"
docker login -u $DOCKER_USERNAME -p $DOCKER_PASSWORD harbor.support.tools

if [[ -z "${TAG}" ]];
then
docker pull harbor.support.tools/supporttools/website:latest
echo "Building..."
if ! docker build -t harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER} --cache-from harbor.support.tools/supporttools/website:latest -f Dockerfile .
then
    echo "Docker build failed"
    exit 127
fi
else
echo "Pulling..."
if ! docker pull harbor.support.tools/supporttools/website:${TAG}
then
    echo "Docker pull failed"
    exit 125
fi
echo "Retagging..."
if ! docker tag harbor.support.tools/supporttools/website:${TAG} harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER}
then
    echo "Docker tag failed"
    exit 124
fi
fi
if ! docker push harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER}
then
echo "Docker push failed"
exit 126
fi
echo "Tagging to latest and pushing..."
if ! docker tag harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER} harbor.support.tools/supporttools/website:latest
then
echo "Docker tag failed"
exit 123
fi
if ! docker push harbor.support.tools/supporttools/website:latest
then
echo "Docker push failed"
exit 122
fi
