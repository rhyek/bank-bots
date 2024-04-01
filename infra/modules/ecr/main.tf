resource "aws_ecr_repository" "scrape_txs" {
  name                 = "scrape_txs"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}
