output "iam_lambda_role_arn" {
  value = aws_iam_role.lambda_role.arn
}

output "iam_lambda_role_name" {
  value = aws_iam_role.lambda_role.name
}
