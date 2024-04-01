#!/bin/bash

function_name="update-ynab-fn"

envs="Variables={DATABASE_URL=$DATABASE_URL}"

if aws lambda get-function --function-name $function_name --region us-east-1 &> /dev/null; then
  echo "Updating function"
  aws lambda update-function-code \
    --function-name $function_name \
  	--zip-file fileb://$ZIPFILE
  aws lambda wait function-updated \
    --function-name $function_name
  aws lambda update-function-configuration \
    --function-name $function_name \
    --environment $envs
else
  echo "Creating function"
  aws lambda create-function \
    --function-name $function_name \
  	--runtime provided.al2023 \
  	--handler bootstrap \
  	--architectures arm64 \
  	--role $LAMBDA_ROLE_ARN \
    --environment $envs
  	--zip-file fileb://$ZIPFILE
fi
