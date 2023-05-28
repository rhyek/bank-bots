#!/bin/bash
cd $(dirname "$0")
set -euo pipefail

aws_account_id=$(aws sts get-caller-identity --query "Account" --output text)
aws_region=$(cd ../../infra; pulumi config get aws:region)
repo_url=$(cd ../../infra; pulumi stack output imageRepos | jq -r .webApi.url)
tag=$(date +%s)
image=$repo_url:$tag

aws ecr get-login-password --region $aws_region | docker login --username AWS --password-stdin $aws_account_id.dkr.ecr.$aws_region.amazonaws.com
docker buildx build -t $image --push .
export IMAGE_URI=$image

cd infra
pulumi up --yes
