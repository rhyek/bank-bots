# bank bots

## Overview

"Bank Bots" is a personal project I wrote that helps me solve the issue of needing to programmatically access my bank (Banco Industrial) account's transactions. Even though they are the biggest bank in Guatemala, they don't have an API or SDK of any sort. So I had to take matters into my own hands!

It is a web scraping bot written in TypeScript, NodeJS, using PlayWright to extract the transaction data from my bank's website and stores it in a PostgreSQL database. Additionally, a Go-based program interfaces with the YNAB budgeting app via its REST API (using a Go community-built SDK), syncing the scraped transaction data for my personal budget management.

The project emphasizes automation, data integration, and the use of cloud technologies to overcome local banking constraints.

## Technical Stack

- **Programming languages**: TypeScript/NodeJS, Go
- **Database**: PostgreSQL
- **Compute**: AWS Lambda
- **Infrastructure as Code**: Terraform, Serverless Framework
- **CI/CD**: Github Actions
- **Other**: Docker, AWS ECR, AWS EventBridge Schedules, 

## Usage

> Note: This project is designed for personal use and tailored to specific banking websites in Guatemala. It will not work for you unless you live here, too. If you do, that's cool!
