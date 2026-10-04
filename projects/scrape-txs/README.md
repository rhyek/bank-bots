# scrape-txs

The bank scraper, as a service. It scrapes every bank daily at 07:00 (America/Guatemala), and on
demand:

```bash
# start a scrape of one bank; with "dryRun": true no transaction is written (bank_tx is untouched)
curl -s -X POST localhost:22250/scrape/bacGt -H 'content-type: application/json' \
  -d '{"months": ["2026-09"], "dryRun": true}'

# follow it
curl -s localhost:22250/scrape/runs/<runId>
curl -s localhost:22250/scrape/runs
```

Bank keys: `bancoIndustrialGt`, `bacGt`, `bacCr`. See `CLAUDE.md`.
