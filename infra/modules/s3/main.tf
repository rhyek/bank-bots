resource "aws_s3_bucket" "playwright_traces" {
  bucket = "bank-bots-playwright-traces"
}

resource "aws_s3_bucket_ownership_controls" "playwright_traces" {
  bucket = aws_s3_bucket.playwright_traces.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_public_access_block" "playwright_traces" {
  bucket                  = aws_s3_bucket.playwright_traces.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_cors_configuration" "playwright_traces" {
  bucket = aws_s3_bucket.playwright_traces.id

  cors_rule {
    allowed_methods = ["GET"]
    allowed_origins = ["https://trace.playwright.dev"]
  }
}

data "aws_iam_policy_document" "playwright_traces_bucket_policy" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.playwright_traces.arn}/*"]
    effect    = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "playwright_traces" {
  bucket = aws_s3_bucket.playwright_traces.id
  policy = data.aws_iam_policy_document.playwright_traces_bucket_policy.json
}

//

resource "aws_iam_policy" "lambda_s3_policy" {
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action   = "s3:PutObject"
        Effect   = "Allow"
        Resource = "${aws_s3_bucket.playwright_traces.arn}/*"
      }
    ]
  })
}

# Attach the policy to the role
resource "aws_iam_role_policy_attachment" "lambda_s3_policy_attachment" {
  role       = var.lambda_role_name
  policy_arn = aws_iam_policy.lambda_s3_policy.arn
}

//

# data "aws_iam_policy_document" "playwright_traces_put_object_policy" {
#   statement {
#     actions   = ["s3:PutObject"]
#     resources = ["${aws_s3_bucket.playwright_traces.arn}/*"]
#     effect    = "Allow"
#     principals {
#       type        = "AWS"
#       identifiers = [var.lambda_role_arn]
#     }
#   }
# }

# resource "aws_s3_bucket_policy" "playwright_traces_put_object_policy" {
#   bucket = aws_s3_bucket.playwright_traces.id
#   policy = data.aws_iam_policy_document.playwright_traces_put_object_policy.json
# }
