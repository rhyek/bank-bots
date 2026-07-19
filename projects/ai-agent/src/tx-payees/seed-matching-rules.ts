// Seeds matching_rule with the merchant patterns ported from scrape-txs'
// backfill-mappings-by-description.ts MATCHERS, preserving that array's order as `priority` so
// first-match-wins behaves identically.
//
// Patterns are stored as JS regex SOURCES — no delimiters, no flags. The `i` flag is applied by the
// regexp() function ReplicaDb registers, since all of these are case-insensitive. Note that a rule
// carries NO payee/category: it only selects which historical transaction to copy from.
//
// Idempotent — upserts on `label`, so re-running updates patterns/priorities in place.
//
// Run (from repo root, with .env.local sourced for DATABASE_URL):
//   pnpm -C projects/ai-agent run seed-matching-rules
import { db, matchingRule, pool, sql } from '@bank-bots/db';

const PATTERNS: [label: string, pattern: string][] = [
  ['san martin', String.raw`\bsan martin\b`],
  ['cpx', String.raw`\bcpx\b`],
  ['spotify', String.raw`\bspotify\b`],
  ['seguros el_a', String.raw`\bSEGUROS EL_A\b`],
  ['volaris', String.raw`\bvolaris\b`],
  ['farmacia galeno', String.raw`\bfarmacia galeno\b`],
  ['amazon', String.raw`\bamazon(\.com|\sMKTPL)\b`],
  ['starbucks', String.raw`\bstarbucks\b`],
  ['i/t transfer', String.raw`\bI\/T-\d+ I000\d+\b`],
  ['pago tarjeta', String.raw`\bPAGO TARJETA\b`],
  ['uber', String.raw`\buber.+(trip|rides)\b`],
  ['mcdonalds', String.raw`\bmcdonalds\b`],
  ['pollo campero', String.raw`\bpollo campero\b`],
  ['cafe barista', String.raw`\bcafe barista\b`],
  ['cemaco', String.raw`\bcemaco\b`],
  // PedidosYa is several sub-brands, each a different payee. Specific patterns come first, and the
  // generic one carries a negative lookahead so it can never swallow a propina/super/plus row.
  ['pedidosya propina', String.raw`\bpedidos\s*ya\s+propina`],
  ['pedidosya super', String.raw`\bpedidos\s*ya\s+(?:super|s[úu]per)`],
  ['pedidosya plus', String.raw`\bpedidos\s*ya\s+plus`],
  ['pedidosya', String.raw`\bpedidos\s*ya\b(?!\s+(?:propina|super|s[úu]per|plus))`],
  ['disney', String.raw`\bdisney\b`],
  ['tigo', String.raw`\btigo\b`],
];

async function main() {
  // Validate every pattern before writing any of them — a rule that isn't a valid JS regex would be
  // skipped at match time with only a warning, which is easy to miss.
  for (const [label, pattern] of PATTERNS) {
    try {
      new RegExp(pattern, 'i');
    } catch (err) {
      throw new Error(`rule '${label}' has an invalid pattern`, { cause: err });
    }
  }

  for (const [i, [label, pattern]] of PATTERNS.entries()) {
    await db
      .insert(matchingRule)
      .values({ label, pattern, priority: (i + 1) * 10, enabled: true })
      .onConflictDoUpdate({
        target: matchingRule.label,
        set: { pattern: sql`excluded.pattern`, priority: sql`excluded.priority` },
      });
  }
  console.log(`seeded ${PATTERNS.length} matching rules`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
