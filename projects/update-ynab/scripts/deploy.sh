#!/bin/bash

function_name="update-ynab-fn"

if aws lambda get-function --function-name $function_name --region us-east-1 &> /dev/null; then
  echo "Updating function"
  aws lambda update-function-code --function-name $function_name \
    --environment "Variables={DATABASE_URL=$DATABASE_URL" \
  	--zip-file fileb://$ZIPFILE \
    > /dev/null
else
  echo "Creating function"
  aws lambda create-function --function-name $function_name \
  	--runtime provided.al2023 \
  	--handler bootstrap \
  	--architectures arm64 \
  	--role $LAMBDA_ROLE_ARN \
    --environment "Variables={DATABASE_URL=$DATABASE_URL" \
  	--zip-file fileb://$ZIPFILE \
    > /dev/null
fi
