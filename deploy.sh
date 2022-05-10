#!/bin/bash -x

if [[ "$1" == 'dev' ]];
then
  cluster='a0-rke2-devops'
  namespace='website-dev'
  imagetag=${BUILD_NUMBER}
  purge=false
  hpa=false
  minReplicas=1
  maxReplicas=1
  ingress='dev.support.tools'
elif [[ "$1" == 'stg' ]];
then
  cluster='a1-rke2-devops'
  namespace='website-stg'
  imagetag=${BUILD_NUMBER}
  purge=false
  hpa=true
  minReplicas=3
  maxReplicas=5
  ingress='stg.support.tools'
elif [[ "$1" == 'prd' ]];
then
  cluster='a1-rke2-devops'
  namespace='website'
  imagetag=${BUILD_NUMBER}
  purge=false
  hpa=true
  minReplicas=3
  maxReplicas=7
  ingress='support.tools'
else
  cluster='a0-rke2-devops'
  namespace=portal-${DRONE_BUILD_NUMBER}
  imagetag=${DRONE_BUILD_NUMBER}
  purge=true
  hpa=true
  minReplicas=1
  maxReplicas=1
  ingress=`echo "master-${DRONE_BUILD_NUMBER}.support.tools"`
fi

echo "Cluster:" ${cluster}
echo "Deploying to namespace: ${namespace}"
echo "Image tag: ${imagetag}"
echo "Purge: ${purge}"
echo "HPA: ${hpa}"

bash /usr/local/bin/init-kubectl

echo "Settings up project, namespace, and kubeconfig"
wget -O rancher-projects https://raw.githubusercontent.com/SupportTools/rancher-projects/main/rancher-projects.sh
chmod +x rancher-projects
mv rancher-projects /usr/local/bin/
rancher-projects --cluster-name ${cluster} --project-name Portal --namespace ${namespace} --create-project true --create-namespace true --create-kubeconfig true --kubeconfig ~/.kube/config
if ! kubectl cluster-info
then
  echo "Problem connecting to the cluster"
  exit 1
fi

echo "Adding labels to namespace"
kubectl label ns ${namespace} team=SupportTools --overwrite
kubectl label ns ${namespace} app=website --overwrite
kubectl label ns ${namespace} ns-purge=${purge} --overwrite

echo "Creating registry secret"
kubectl -n ${namespace} create secret docker-registry harbor-registry-secret \
--docker-server=harbor.support.tools \
--docker-username=${DOCKER_USERNAME} \
--docker-password=${DOCKER_PASSWORD} \
--dry-run=client -o yaml | kubectl apply -f -

echo "Creating S3 secret"
kubectl -n ${namespace} create secret generic s3-secret \
--from-literal=s3_accesskey=${s3_accesskey} \
--from-literal=s3_secretkey=${s3_secretkey} \
--dry-run=client -o yaml | kubectl apply -f -

echo "Deploying website"
helm upgrade --install website ./chart \
--namespace ${namespace} \
-f ./chart/values.yaml \
--set image.tag=${DRONE_BUILD_NUMBER} \
--set ingress.host=${ingress} \
--set autoscaling.minReplicas=${maxReplicas} \
--set autoscaling.maxReplicas=${maxReplicas}

echo "Waiting for deploying to become ready..."

echo "Checking Deployments"
for deployment in `kubectl -n ${namespace} get deployment -o name`
do
  echo "Checking ${deployment}"
  kubectl -n ${namespace} rollout status ${deployment}
done