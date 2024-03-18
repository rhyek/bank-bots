#!/bin/bash
set -e
__dirname=$(dirname $(readlink -f ${BASH_SOURCE[0]}))
cd $__dirname

docker build -t scrape-txs:${IMAGE_TAG} -f Dockerfile $__dirname/../
docker tag scrape-txs:${IMAGE_TAG} ${ECR_REPO_URL}:${IMAGE_TAG}

host="${ECR_REPO_URL%%/*}"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $host

docker push ${ECR_REPO_URL}:${IMAGE_TAG}
