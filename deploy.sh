#!/bin/bash -x

if [[ "$1" == 'dev' ]];
then
  cluster='a0-rke2-devops'
  namespace='supporttools-dev'
  imagetag=${BUILD_NUMBER}
  purge=false
  hpa=false
  minReplicas=1
  maxReplicas=1
  ingress='dev.support.tools'
  class="dev"
  synccdn=false
elif [[ "$1" == 'qas' ]];
then
  cluster='a0-rke2-devops'
  namespace='supporttools-qas'
  imagetag=${BUILD_NUMBER}
  purge=false
  hpa=true
  minReplicas=3
  maxReplicas=5
  ingress='qas.support.tools'
  class="qas"
  synccdn=true
elif [[ "$1" == 'tst' ]];
then
  cluster='a0-rke2-devops'
  namespace='supporttools-tst'
  imagetag=${BUILD_NUMBER}
  purge=false
  hpa=true
  minReplicas=3
  maxReplicas=5
  ingress='tst.support.tools'
  class="tst"
  synccdn=true
elif [[ "$1" == 'stg' ]];
then
  cluster='a1-rke2-devops'
  namespace='supporttools-stg'
  imagetag=${BUILD_NUMBER}
  purge=false
  hpa=true
  minReplicas=3
  maxReplicas=5
  ingress='stg.support.tools'
  class="stg"
  synccdn=true
elif [[ "$1" == 'prd' ]];
then
  cluster='a1-rke2-devops'
  namespace='supporttools-prd'
  imagetag=${BUILD_NUMBER}
  purge=false
  hpa=true
  minReplicas=3
  maxReplicas=7
  ingress='support.tools'
  class="prd"
  synccdn=true
else
  cluster='a0-rke2-devops'
  namespace='supporttools-mst'
  imagetag=${DRONE_BUILD_NUMBER}
  purge=false
  hpa=true
  minReplicas=1
  maxReplicas=1
  ingress='mst.support.tools'
  class="mst"
  synccdn=false
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
rancher-projects --cluster-name ${cluster} --project-name SupportTools --namespace ${namespace} --create-project true --create-namespace true --create-kubeconfig true --kubeconfig ~/.kube/config
export KUBECONFIG=~/.kube/config

echo "##################################################################################"
echo "Kubeconfig ~/.kube/config"
cat ${KUBECONFIG}
echo "##################################################################################"

if ! kubectl cluster-info
then
  echo "Problem connecting to the cluster"
  exit 1
fi

echo "Adding labels to namespace"
kubectl label ns ${namespace} team=SupportTools --overwrite
kubectl label ns ${namespace} app=website --overwrite
kubectl label ns ${namespace} ns-purge=${purge} --overwrite
kubectl label ns ${namespace} class=${class} --overwrite

echo "Creating registry secret"
kubectl -n ${namespace} create secret docker-registry harbor-registry-secret \
--docker-server=harbor.support.tools \
--docker-username=${DOCKER_USERNAME} \
--docker-password=${DOCKER_PASSWORD} \
--dry-run=client -o yaml | kubectl apply -f -

echo "Deploying website"
helm upgrade --install website ./chart \
--namespace ${namespace} \
-f ./chart/values.yaml \
--set image.tag=${DRONE_BUILD_NUMBER} \
--set ingress.host=${ingress} \
--set autoscaling.minReplicas=${maxReplicas} \
--set autoscaling.maxReplicas=${maxReplicas} \
--force

echo "Waiting for pods to become ready..."
echo "Checking Deployments"
for deployment in `kubectl -n ${namespace} get deployment -o name`
do
  echo "Checking ${deployment}"
  kubectl -n ${namespace} rollout status ${deployment}
done

if [ ${synccdn} == true ];
then
  echo "Syncing files to S3..."
  aws s3 sync ./cdn.support.tools/ s3://cdn.support.tools/ --endpoint-url=https://s3.us-east-1.wasabisys.com
else
  echo "Skipping S3 sync"
fi
