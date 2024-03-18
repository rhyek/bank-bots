#!/bin/bash
set -e
__dirname=$(dirname $(readlink -f ${BASH_SOURCE[0]}))
cd $__dirname

host="${ECR_REPO_URL%%/*}"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $host

docker buildx build \
  --push -t ${ECR_REPO_URL}:${IMAGE_TAG} \
  -f ./Dockerfile \
  --cache-to type=gha,scope=scrape-txs,mode=max \
  --cache-from type=gha,scope=scrape-txs \
  $__dirname/../
