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

resource "aws_iam_policy" "lambda_invoke_policy" {
  name        = "lambda_invoke_policy"
  description = "Allows role to invoke any lambda function in the account"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "lambda:InvokeFunction"
        ],
        Resource = [
          "arn:*:lambda:*:*:function:*",
          "arn:*:lambda:*:*:function:*:*",
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_invoke_policy_attachment" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = aws_iam_policy.lambda_invoke_policy.arn
}
