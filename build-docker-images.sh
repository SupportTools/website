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
  #docker pull supporttools/website:latest
  if ! docker build -t supporttools/website:${DRONE_BUILD_NUMBER} --cache-from supporttools/website:latest -f Dockerfile .
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