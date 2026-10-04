# bank bots

## Overview

"Bank Bots" is a personal project I worked on over a weekend or two that helps me solve the issue of needing to programmatically access my bank statements and a list of transactions then later sync the data to a budgeting app. I like to be precise with my monthly budget and expenses. Sadly, banks in Guatemala don't offer API access yet, so I had to take matters into my own hands!

It is a web scraping bot written in TypeScript and Node.js, using [Playwright](https://playwright.dev/) to extract the transaction data from my bank's website and stores it in a PostgreSQL database.

Banks supported so far are Banco Industrial (Guatemala only), and BAC (Central America).

## Technical Stack

- **Programming languages**: TypeScript/Node.js
- **Database**: PostgreSQL
