#!/usr/bin/env python3
import os
import subprocess

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# run a shell command and save the stdout output to a variable
aws_account_id = subprocess.check_output(
    'aws sts get-caller-identity --query "Account" --output text', shell=True, text=True
).strip()
aws_region = subprocess.check_output(
    "pulumi config --stack dev get aws:region", shell=True, text=True, cwd="./infra"
).strip()
repo_url = subprocess.check_output(
    "pulumi stack --stack dev output imageRepos | jq -r .bi.registerNewBiTxPushNotificationImageRepo.url",
    shell=True,
    text=True,
    cwd="../../../infra",
).strip()
tag = subprocess.check_output("date +%s", shell=True, text=True).strip()

image_name = f"{repo_url}:{tag}"

subprocess.run(
    f"aws ecr get-login-password --region {aws_region} | docker login --username AWS --password-stdin {aws_account_id}.dkr.ecr.{aws_region}.amazonaws.com",
    shell=True,
)
subprocess.run(
    "docker buildx create --use --driver=docker-container",
    shell=True,
)
subprocess.run(
    f"""
    docker buildx build \
        --platform linux/arm64 \
        -t {image_name} \
        --provenance=false \
        {"--cache-to type=gha,mode=max,scope=web-api --cache-from type=gha,scope=web-api" if os.environ.get("CI", False) else ''} \
        --push \
        .
    """,
    shell=True,
)
