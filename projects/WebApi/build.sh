#!/bin/bash
cd $(dirname "$0")
set -euo pipefail

aws_account_id=$(aws sts get-caller-identity --query "Account" --output text)
aws_region=$(cd ../../infra; pulumi config --stack dev get aws:region)
repo_url=$(cd ../../infra; pulumi stack --stack dev output imageRepos | jq -r .webApi.url)
tag=$(date +%s)
image=$repo_url:$tag

aws ecr get-login-password --region $aws_region | docker login --username AWS --password-stdin $aws_account_id.dkr.ecr.$aws_region.amazonaws.com
docker buildx create --use --driver=docker-container
docker buildx build \
  --platform linux/arm64 \
  -t $image \
  --cache-to type=gha,mode=max,scope=web-api \
  --cache-from type=gha,scope=web-api \
  --push \
  .
echo $image
