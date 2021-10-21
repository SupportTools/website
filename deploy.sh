#!/bin/bash

if [[ -z $BUILD_NUMBER ]]
then
  BUILD_NUMBER=${CI_BUILD_NUMBER}
fi

echo "customizing Deployment files..."
mkdir /drone/src/deployment-ready/
cd /drone/src/deployment/
for file in `ls *.yaml`
do
  echo "Working on $file"
  cat $file | sed "s/BUILD_NUMBER/${BUILD_NUMBER}/g" > /drone/src/deployment-ready/"$file"
done