# Playwright trace analysis cookbook

A saved trace (`projects/scrape-txs/storage/runs/<runId>/trace.zip`) is your best evidence for a
scraper failure. It's a zip of newline-delimited JSON plus captured resources. These recipes pull out
the action timeline, the hung step, page navigations, DOM snapshots, and console output.

Unzip first. A failed run reports its trace as `error.tracePath` (`GET /scrape/runs/<runId>`, or the
`scrape_run.error` column); without a run id, take the newest one. (Traces from before the scraper
became a service are `<ts>_<bankKey>.zip` under `projects/scrape-txs/storage/playwright-traces/` or
`storage/scrape-txs/run/`.)

```bash
tf=projects/scrape-txs/storage/runs/<runId>/trace.zip
# or the newest trace of any run:
tf=$(ls -t projects/scrape-txs/storage/runs/*/trace.zip 2>/dev/null | head -1)
work=/tmp/trace-inspect && rm -rf "$work" && mkdir -p "$work"
unzip -oq "$tf" -d "$work"
ls "$work"        # trace.trace  trace.network  trace.stacks  resources/
```

`trace.trace` is the event log (one JSON object per line). Entry `type`s you'll use: `before` /
`after` (an action's start/end, joined by `callId`), `log` (Playwright's "waiting for…" Call log
per action), `frame-snapshot` (a DOM snapshot with `frameUrl`), `console` (page console),
`before`/`after` `params.selector` / `params.url` hold the locator/URL.

Sanity check what's in it:

```bash
jq -r '.type' "$work/trace.trace" | sort | uniq -c
```

## 1. Action timeline — find the hung step

Join `before`+`after` by `callId` and print each action's selector/url, **duration**, and Call
log. The action whose duration ≈ 30000 ms and whose log stays at `waiting for locator(...)` is the
break; everything before it (fast) succeeded.

```bash
jq -rn '
  [inputs] as $all
  | ($all | map(select(.type=="after"))  | map({(.callId): .}) | add) as $after
  | ($all | map(select(.type=="log")) | group_by(.callId)
          | map({key:.[0].callId, value:(map(.message))}) | from_entries) as $logs
  | $all | map(select(.type=="before")) | .[]
  | . as $b | ($after[$b.callId]) as $a
  | "▶ \($b.apiName)  \($b.params.selector // $b.params.url // "")  "
    + "dur=\((($a.endTime // 0) - $b.startTime)|floor)ms\n    "
    + (($logs[$b.callId] // []) | join(" | "))
' "$work/trace.trace" | cat -n
```

Notes:
- `apiName` may render as `null` in some trace versions — the `params.selector` / `params.url`
  column is the reliable identifier of what the step did.
- Don't depend on extracting a structured error from `after` (`.error.error.message`) — its shape
  varies and a timed-out action can still look "ok". The **duration** and the **Call log** are the
  trustworthy signals. The stdout logfile's `Attempt N failed with error:` line corroborates.

## 2. Page navigations — catch redirects (e.g. the retry/cookie bug)

List every DOM snapshot's `frameUrl` in capture order. Comparing where each attempt's `goto`
*lands* reveals unexpected redirects (a reused context being sent to a different URL on retry, an
auth redirect, a country/region redirect, etc.).

```bash
jq -rc 'select(.type=="frame-snapshot") | "\(.snapshot.timestamp)  \(.snapshot.frameUrl)"' \
  "$work/trace.trace" | sort -n | awk '!seen[$0]++'
```

You can also read the per-`goto` "navigated to …" lines straight from the Call log via recipe 1.

## 3. Extract a page's DOM snapshot — find the new selector

Snapshot `html` is a serialized nested-array DOM: `["TAG",{attrs…},child, child, …]`. Snapshots
are incremental — the first for a URL is the full DOM, later ones are diffs — so grab the
**largest** snapshot for the `frameUrl` you care about.

```bash
url='https://www.sucursalelectronica.com/redir/showLogin.go'   # the frameUrl of interest
jq -rc --arg u "$url" '
  select(.type=="frame-snapshot" and .snapshot.frameUrl==$u)
  | .snapshot.html | tostring | select(length>1000)
' "$work/trace.trace" | awk '{ print length, NR }' | sort -rn | head -1   # find the biggest line #

# then dump that snapshot and grep for candidate elements:
jq -rc --arg u "$url" 'select(.type=="frame-snapshot" and .snapshot.frameUrl==$u) | .snapshot.html' \
  "$work/trace.trace" | awk 'length>30000' | head -1 > "$work/dom.json"
grep -oE '\["(INPUT|BUTTON|A)",\{[^}]*\}' "$work/dom.json"          # form controls + their attrs
grep -oiE '"(id|name|type|class|value)","[^"]*(submit|login|ingres|confirm|btn)[^"]*"' "$work/dom.json"
```

This is how you find the replacement selector on **authenticated** pages you can't visit live.
Look for `id`/`name`/role-giving attributes and prefer them over utility classes.

## 4. Console output

Page-level console messages (JS errors, 404s). Usually noise (asset 404s), occasionally a clue
(a script error that blocks a control from working).

```bash
jq -rc 'select(.type=="console") | "\(.messageType)  \(.text)"' "$work/trace.trace" | sort | uniq -c
```

## 5. Open the trace in the Playwright UI (optional, for humans)

When you want to *see* it rather than grep it:

```bash
pnpm -C projects/scrape-txs exec playwright show-trace "$tf"
# or: npx playwright show-trace "$tf"
```

Opens the timeline with screenshots, DOM snapshots, network, and per-action Call logs — the same
data these recipes extract, visually.
