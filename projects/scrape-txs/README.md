# scrape-txs

The bank scraper, as a service. It scrapes every bank daily at 07:00 (America/Guatemala), and on
demand:

```bash
S=https://scrape-txs.bank-bots-dev.workstation.rhyek.com   # while a devtooie session runs it

# start a scrape of one bank; with "dryRun": true no transaction is written (bank_tx is untouched)
curl -s -X POST $S/scrape/bacGt -H 'content-type: application/json' \
  -d '{"months": ["2026-09"], "dryRun": true}'

# follow it
curl -s $S/scrape/runs/<runId>
curl -s $S/scrape/runs
```

Bank keys: `bancoIndustrialGt`, `bacGt`, `bacCr`. See `CLAUDE.md`.
