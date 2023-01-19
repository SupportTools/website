#!/bin/sh

if [ ! -z "${TAG}" ]
then
  echo "TAG is set to ${TAG}"
  docker pull harbor.support.tools/supporttools/website:${TAG}
  docker tag harbor.support.tools/supporttools/website:${TAG} harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER}
  docker push harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER}
else
  echo "Building image"
  #docker pull harbor.support.tools/supporttools/website:latest
  if ! docker build -t harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER} --cache-from harbor.support.tools/supporttools/website:latest -f Dockerfile .
  then
    echo "Problem building latest image"
    exit 1
  fi
  echo "Pushing tagged image"
  if ! docker push harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER}
  then
    echo "Docker push tagged failed"
    exit 1
  fi
  if ! docker tag harbor.support.tools/supporttools/website:${DRONE_BUILD_NUMBER} harbor.support.tools/supporttools/website:latest
  then
    echo "Problem tagging latest image"
    exit 1
  fi
  if ! docker push harbor.support.tools/supporttools/website:latest
  then
    echo "Docker pushing latest failed"
    exit 1
  fi
fi