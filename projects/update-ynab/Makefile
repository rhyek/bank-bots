test:
	go test ./...
build: # https://docs.aws.amazon.com/lambda/latest/dg/golang-package.html
	GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap main.go
	zip update-ynab.zip bootstrap
deploy:
	function_name="update-ynab-fn"
	if aws lambda get-function --function-name $function_name --region us-east-1 &> /dev/null
	then
		echo "Updating function"
		aws lambda update-function-code --function-name $function_name \
			--zip-file fileb://update-ynab.zip
	else
		echo "Creating function"
		aws lambda create-function --function-name $function_name \
			--runtime provided.al2023 \
			--handler bootstrap \
			--architectures arm64 \
			--role $LAMBDA_ROLE_ARN \
			--zip-file fileb://update-ynab.zip
	fi
