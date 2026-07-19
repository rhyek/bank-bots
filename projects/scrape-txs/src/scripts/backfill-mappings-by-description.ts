// Backfill payee_id + category_id onto unmapped bank_tx rows by matching their DESCRIPTION against
// already-mapped history. This is a Postgres re-implementation of update-ynab's `UpdateEmptyPayees`
// (ynab/ynab.go): for each transaction with no payee/category, find the MOST RECENT already-mapped
// transaction whose description matches — first by exact description, falling back to a fixed list
// of merchant regexes — and copy its payee_id + category_id.
//
// Differences from the Go original: the source of truth is bank_tx (not YNAB), we match on
// bank_tx.description directly (the Go matched the `desc:` it had written into the YNAB memo, which
// IS the bank description), and we do NOT limit the source history to the last year — the whole
// history is the source, so the most recent match is found no matter how far back it is.
//
// Dry-run by default: prints match stats + samples and touches nothing. Pass --apply to write.
// Pass --out <path> to dump the full planned assignment (id, description, via, payee, category) as
// JSON for review / as a revert manifest (revert = set those ids' payee_id/category_id back to NULL).
//
// Run (from repo root, with .env.local sourced for DATABASE_URL):
//   pnpm -C projects/scrape-txs exec node --import @swc-node/register/esm-register \
//     src/scripts/backfill-mappings-by-description.ts [--apply] [--out plan.json]

import fs from 'node:fs/promises';
import { db, pool, sql } from '@bank-bots/db';

// Merchant regexes ported verbatim from update-ynab ynab/ynab.go `matchers`. Go's `(?i)` inline
// flag becomes the JS `i` flag; `\b`, `\s`, `\d` behave the same. Order matters (first match wins),
// matching the Go's list order. In practice these are disjoint (each targets one merchant).
const MATCHERS: { label: string; re: RegExp }[] = [
  { label: 'san martin', re: /\bsan martin\b/i },
  { label: 'cpx', re: /\bcpx\b/i },
  { label: 'spotify', re: /\bspotify\b/i },
  { label: 'seguros el_a', re: /\bSEGUROS EL_A\b/i },
  { label: 'volaris', re: /\bvolaris\b/i },
  { label: 'farmacia galeno', re: /\bfarmacia galeno\b/i },
  { label: 'amazon', re: /\bamazon(\.com|\sMKTPL)\b/i },
  { label: 'starbucks', re: /\bstarbucks\b/i },
  { label: 'i/t transfer', re: /\bI\/T-\d+ I000\d+\b/i },
  { label: 'pago tarjeta', re: /\bPAGO TARJETA\b/i },
  { label: 'uber', re: /\buber.+(trip|rides)\b/i },
  { label: 'mcdonalds', re: /\bmcdonalds\b/i },
  { label: 'pollo campero', re: /\bpollo campero\b/i },
  { label: 'cafe barista', re: /\bcafe barista\b/i },
  { label: 'cemaco', re: /\bcemaco\b/i },
  // PedidosYa is several sub-brands, each a DIFFERENT payee (food→PedidosYa/Restaurants,
  // propinas→PedidosYa Propinas/Misc, supermercado→PedidosYa Súper/Groceries, Plus→a subscription).
  // So they get separate matchers, specific-first; the generic food one carries a negative lookahead
  // so it can never swallow a propina/súper/plus row. `PEDIDOS YA` (with a space) and `PEDIDOSYA` both
  // occur, hence `pedidos\s*ya`.
  { label: 'pedidosya propina', re: /\bpedidos\s*ya\s+propina/i },
  { label: 'pedidosya super', re: /\bpedidos\s*ya\s+(?:super|s[úu]per)/i },
  { label: 'pedidosya plus', re: /\bpedidos\s*ya\s+plus/i },
  { label: 'pedidosya', re: /\bpedidos\s*ya\b(?!\s+(?:propina|super|s[úu]per|plus))/i },
  { label: 'disney', re: /\bdisney\b/i },
  { label: 'tigo', re: /\btigo\b/i },
];

interface Row {
  id: number;
  date: string;
  description: string;
  payeeId: string | null;
  categoryId: string | null;
  transferBankAccountId: string | null;
  docNo: string;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : undefined;

  const [payees, categories, allTx] = await Promise.all([
    db.query.payee.findMany({ columns: { id: true, name: true } }),
    db.query.category.findMany({ columns: { id: true, name: true } }),
    db.query.bankTx.findMany({
      columns: {
        id: true,
        date: true,
        description: true,
        payeeId: true,
        categoryId: true,
        transferBankAccountId: true,
        docNo: true,
      },
    }),
  ]);
  const payeeName = new Map(payees.map((p) => [p.id, p.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  // --- source pool: rows that already have BOTH payee + category, most-recent-first ---
  const sources = (allTx as Row[])
    .filter((r) => r.payeeId != null && r.categoryId != null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));

  // exact-description index: description -> most recent source (first wins, list is sorted desc)
  const exactByDesc = new Map<string, Row>();
  for (const s of sources) if (!exactByDesc.has(s.description)) exactByDesc.set(s.description, s);

  // source to copy per matcher: the most-recent mapped tx whose description matches the regex.
  const matcherSource: (Row | undefined)[] = new Array(MATCHERS.length).fill(undefined);
  for (const s of sources) {
    for (let i = 0; i < MATCHERS.length; i++) {
      if (matcherSource[i] === undefined && MATCHERS[i].re.test(s.description))
        matcherSource[i] = s;
    }
  }

  // --- targets: fully-unmapped rows (both null), skipping transfers + manual RECONCILE rows ---
  const targets = (allTx as Row[]).filter(
    (r) =>
      r.payeeId == null &&
      r.categoryId == null &&
      r.transferBankAccountId == null &&
      r.docNo !== 'RECONCILE',
  );

  interface Plan {
    id: number;
    date: string;
    description: string;
    via: string;
    payeeId: string;
    categoryId: string;
  }
  const plan: Plan[] = [];
  const viaCounts = new Map<string, number>();
  const unmatched = new Map<string, number>(); // description -> count

  for (const t of targets) {
    let src: Row | undefined;
    let via = '';
    // 1. exact description match
    const exact = exactByDesc.get(t.description);
    if (exact) {
      src = exact;
      via = 'exact';
    }
    // 2. regex matchers
    if (!src) {
      for (let i = 0; i < MATCHERS.length; i++) {
        if (MATCHERS[i].re.test(t.description) && matcherSource[i]) {
          src = matcherSource[i];
          via = `regex:${MATCHERS[i].label}`;
          break;
        }
      }
    }

    if (!src) {
      unmatched.set(t.description, (unmatched.get(t.description) ?? 0) + 1);
      continue;
    }
    viaCounts.set(via, (viaCounts.get(via) ?? 0) + 1);
    plan.push({
      id: t.id,
      date: t.date,
      description: t.description,
      via,
      payeeId: src.payeeId!,
      categoryId: src.categoryId!,
    });
  }

  // --- report ---
  console.log(
    `sources (mapped): ${sources.length} | targets (unmapped): ${targets.length} | matched: ${plan.length} | unmatched: ${targets.length - plan.length}`,
  );
  console.log('\nmatched by method:');
  for (const [via, n] of [...viaCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${via}: ${n}`);
  }

  console.log('\nsample of matches (first 25):');
  for (const p of plan.slice(0, 25)) {
    console.log(
      `  [${p.date}] "${p.description}" --${p.via}--> ${payeeName.get(p.payeeId) ?? p.payeeId} / ${categoryName.get(p.categoryId) ?? p.categoryId}`,
    );
  }

  console.log('\ntop unmatched descriptions (by count):');
  for (const [desc, n] of [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${n}x  "${desc}"`);
  }

  if (outPath) {
    await fs.writeFile(outPath, JSON.stringify(plan, null, 2));
    console.log(`\nwrote full plan (${plan.length} rows) to ${outPath}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write these assignments.');
    return;
  }

  // --- apply: batched VALUES upserts (same pattern as backfill-ynab-mappings) ---
  console.log(`\napplying ${plan.length} updates...`);
  const chunk = 500;
  for (let i = 0; i < plan.length; i += chunk) {
    const batch = plan.slice(i, i + chunk);
    const values = sql.join(
      batch.map((u) => sql`(${u.id}::bigint, ${u.payeeId}::text, ${u.categoryId}::text)`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE bank_tx AS t SET payee_id = v.payee_id, category_id = v.category_id
      FROM (VALUES ${values}) AS v(id, payee_id, category_id)
      WHERE t.id = v.id`);
  }
  console.log('done.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
