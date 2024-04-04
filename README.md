# bank bots

## Overview

"Bank Bots" is a personal solution to the absence of banking APIs in Guatemala, enabling automated tracking of my bank transactions. It utilizes web scraping bots written in TypeScript, NodeJS, and using PlayWright to extract transaction data from my banks' websites and store it in a PostgreSQL database. Additionally, a Go-based program interfaces with the YNAB budgeting app via its REST API, syncing the scraped transaction data for my budget management.

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
