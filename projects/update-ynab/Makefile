test:
	go test ./...
dev:
	go run ./main.go
build: # https://docs.aws.amazon.com/lambda/latest/dg/golang-package.html
	GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap main.go
