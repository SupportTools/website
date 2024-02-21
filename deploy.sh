#!/bin/bash -x

if [[ "$1" == 'dev' ]];
then
  cluster='a1-ops-dev'
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
  cluster='a1-ops-dev'
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
  cluster='a1-ops-dev'
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
  cluster='a1-ops-prd'
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
  cluster='a1-ops-prd'
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
  cluster='a1-ops-dev'
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

if [ ! -z "${TAG}" ]
then
  echo "Using tag ${TAG}"
  imagetag=${TAG}
fi

echo "Cluster:" ${cluster}
echo "Deploying to namespace: ${namespace}"
echo "Image tag: ${imagetag}"
echo "Purge: ${purge}"
echo "HPA: ${hpa}"

echo "Installing kubectl"
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

echo "Installing helm"
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3
chmod 700 get_helm.sh
bash get_helm.sh

echo "Installing rancher-projects"
curl -fsSL -o rancher-projects.tar.gz https://github.com/SupportTools/rancher-projects/releases/download/v0.2.1/rancher-projects_0.2.2_linux_amd64.tar.gz
tar -xvf rancher-projects.tar.gz
chmod +x rancher-projects
mv rancher-projects /usr/local/bin/rancher-projects

echo "Settings up project, namespace, and kubeconfig"
rancher-projects \
--rancher-server ${CATTLE_SERVER} \
--rancher-access-key ${CATTLE_ACCESS_KEY} \
--rancher-secret-key ${CATTLE_SECRET_KEY} \
--cluster-name ${cluster} \
--project-name "SupportTools" \
--namespace ${namespace} \
--create-kubeconfig \
--kubeconfig "kubeconfig"
export KUBECONFIG=kubeconfig

if ! kubectl cluster-info
then
  echo "Problem connecting to the cluster"
  exit 1
fi

echo "#############################################################################"
echo "Node information"
kubectl get nodes -o wide
echo "#############################################################################"

echo "Adding labels to namespace"
kubectl label ns ${namespace} team=SupportTools --overwrite
kubectl label ns ${namespace} app=website --overwrite
kubectl label ns ${namespace} ns-purge=${purge} --overwrite
kubectl label ns ${namespace} class=${class} --overwrite

echo "Deploying website"
helm upgrade --install website ./chart \
--namespace ${namespace} \
-f ./chart/values.yaml \
--set image.tag=${imagetag} \
--set ingress.host=${ingress} \
--set autoscaling.minReplicas=${maxReplicas} \
--set autoscaling.maxReplicas=${maxReplicas} \
--force

# echo "Package and publish Helm chart"
# export HELM_EXPERIMENTAL_OCI=1
# helm registry login harbor.support.tools --username ${DOCKER_USERNAME} --password ${DOCKER_PASSWORD}
# helm package ./chart/ --version ${DRONE_BUILD_NUMBER} --app-version ${imagetag}
# helm push website-helm-${DRONE_BUILD_NUMBER}.tgz oci://harbor.support.tools/supporttools
# rm -f website-helm-${DRONE_BUILD_NUMBER}.tgz

# echo "Waiting for pods to become ready..."
# echo "Checking Deployments"
# for deployment in `kubectl -n ${namespace} get deployment -o name`
# do
#   echo "Checking ${deployment}"
#   kubectl -n ${namespace} rollout status ${deployment}
# done