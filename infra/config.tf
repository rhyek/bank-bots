terraform {
  cloud {
    organization = "rhyek"

    workspaces {
      name = "bank-bots-dev"
    }
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}
