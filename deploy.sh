#!/bin/bash

echo "customizing Deployment files..."
mkdir /drone/src/k8s/deployment-ready/
cd /drone/src/k8s/deployment-ready/
for file in `ls *.yaml`
do
  echo "Working on $file"
  cat $file | sed "s/BUILD_NUMBER/${CI_BUILD_NUMBER}/g" > /drone/src/k8s/deployment-ready/"$file"
done

ls -l /drone/src/k8s/deployment-ready/
cat /drone/src/k8s/ingress/master.yaml | sed "s/BUILD_NUMBER/${CI_BUILD_NUMBER}/g" > /drone/src/k8s/ingress/master.yaml-tmp
mv /drone/src/k8s/ingress/master.yaml-tmp /drone/src/k8s/ingress/master.yaml