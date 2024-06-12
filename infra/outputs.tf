output "ecr_repository_scrape_txs_url" {
  value = module.ecr.ecr_repository_scrape_txs_url
}

output "iam_lambda_role_arn" {
  value = module.iam.iam_lambda_role_arn
}

output "playwright_traces_s3_bucket_id" {
  value = module.s3.playwright_traces_s3_bucket_id
}
