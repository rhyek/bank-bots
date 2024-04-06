# bank bots

## Overview

"Bank Bots" is a personal project I wrote that helps me solve the issue of needing to programmatically access my bank (Banco Industrial) account's transactions. Even though they are the biggest bank in Guatemala, they don't have an API or SDK of any sort. So I had to take matters into my own hands!

It is a web scraping bot written in TypeScript, Node.js, using PlayWright to extract the transaction data from my bank's website and stores it in a PostgreSQL database. Additionally, a Go-based program interfaces with the [YNAB](https://www.ynab.com/) budgeting app via their REST API (using a Go community-built SDK), syncing the scraped transaction data for my personal budget management.

The project emphasizes automation, data integration, and the use of cloud technologies to overcome local banking constraints.

## Technical Stack

- **Programming languages**: Go, TypeScript/Node.js
- **Database**: PostgreSQL
- **Compute**: AWS Lambda
- **Infrastructure as Code**: Terraform, Serverless Framework
- **CI/CD**: Github Actions
- **Other**: Docker, AWS ECR, AWS EventBridge Schedules
