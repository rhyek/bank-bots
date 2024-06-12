module "ecr" {
  source = "./modules/ecr"
}

module "iam" {
  source = "./modules/iam"
}

module "s3" {
  source           = "./modules/s3"
  lambda_role_arn  = module.iam.iam_lambda_role_arn
  lambda_role_name = module.iam.iam_lambda_role_name
}
