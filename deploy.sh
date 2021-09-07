#!/bin/bash

echo "customizing Deployment files..."
mkdir /drone/src/deployment-ready/
cd /drone/src/deployment-ready/
for file in `ls *.yaml`
do
  echo "Working on $file"
  cat $file | sed "s/BUILD_NUMBER/${CI_BUILD_NUMBER}/g" > /drone/src/deployment-ready/"$file"
done

ls -l /drone/src/deployment-ready/
cat /drone/src/ingress/master.yaml | sed "s/BUILD_NUMBER/${CI_BUILD_NUMBER}/g" > /drone/src/ingress/master.yaml-tmp
mv /drone/src/ingress/master.yaml-tmp /drone/src/ingress/master.yaml
