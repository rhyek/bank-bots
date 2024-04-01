data "aws_iam_policy_document" "assume_role" {
  statement {
    principals {
      type = "Service"
      identifiers = [
        "lambda.amazonaws.com",
        "scheduler.amazonaws.com" # for eventbridge scheduler to assume this role and exec the fn
      ]
    }
    actions = ["sts:AssumeRole"]
    effect  = "Allow"
  }
}

resource "aws_iam_role" "lambda_role" {
  name               = "lambda_role"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_role_policy_attachment" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
