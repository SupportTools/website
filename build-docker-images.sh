#!/bin/sh

docker login -u $DOCKER_USERNAME -p $DOCKER_PASSWORD docker.io

if [ ! -z "${TAG}" ]
then
  echo "TAG is set to ${TAG}"
  docker pull supporttools/website:${TAG}
  docker tag supporttools/website:${TAG} supporttools/website:${DRONE_BUILD_NUMBER}
  docker push supporttools/website:${DRONE_BUILD_NUMBER}
else
  echo "Building image"
  docker build \
  --platform linux/amd64 \
  --pull \
  --build-arg VERSION=${DRONE_BUILD_NUMBER} \
  --build-arg GIT_COMMIT=${DRONE_COMMIT_SHA} \
  --build-arg BUILD_DATE=`date -u +"%Y-%m-%dT%H:%M:%SZ"` \
  --cache-from supporttools/website:latest \
  -t supporttools/website:${DRONE_BUILD_NUMBER} \
  -f Dockerfile .
  if [ $? -ne 0 ]
  then
    echo "Problem building latest image"
    exit 1
  fi
  echo "Pushing tagged image"
  if ! docker push supporttools/website:${DRONE_BUILD_NUMBER}
  then
    echo "Docker push tagged failed"
    exit 1
  fi
  if ! docker tag supporttools/website:${DRONE_BUILD_NUMBER} supporttools/website:latest
  then
    echo "Problem tagging latest image"
    exit 1
  fi
  if ! docker push supporttools/website:latest
  then
    echo "Docker pushing latest failed"
    exit 1
  fi
fi