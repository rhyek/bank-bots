# bank bots

## Overview

"Bank Bots" is a personal project I worked on over a weekend or two that helps me solve the issue of needing to programmatically access my bank statements and a list of transactions then later sync the data to a budgeting app. I like to be precise with my monthly budget and expenses. Sadly, banks in Guatemala don't offer API access yet, so I had to take matters into my own hands!

It is a web scraping bot written in TypeScript, Node.js, and Go, using [Playwright](https://playwright.dev/) to extract the transaction data from my bank's website and stores it in a PostgreSQL database. A Go-based program communicates with the [YNAB](https://www.ynab.com/) budgeting app via their REST API, syncing the scraped transaction data for my personal budget management.

Banks supported so far are Banco Industrial (Guatemala only), and BAC (Central America).

## Technical Stack

- **Programming languages**: Go, TypeScript/Node.js
- **Database**: PostgreSQL
- **Compute**: AWS Lambda
- **Infrastructure as Code**: Terraform, Serverless Framework
- **CI/CD**: Github Actions
- **Other**: Docker, AWS ECR, AWS EventBridge Schedules
