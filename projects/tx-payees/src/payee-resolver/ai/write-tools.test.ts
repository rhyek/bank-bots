import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/replica-db/replica-schema';
import { buildWriteTools } from '~/payee-resolver/ai/write-tools';
import type { ReplicaDb } from '~/replica-db/replica-db.service';
import type { ReplicaSettled } from '~/events/replica-settled.service';

// These tests cover the validation the write tools do BEFORE they touch Postgres — which is where
// all the risk lives: a bad regex reaching matching_rule breaks every future match, and a
// hallucinated group id would violate a foreign key. The happy paths write to the real database, so
// they are covered by the live end-to-end run rather than mocked out here; faking Drizzle's Postgres
// surface would test the fake, not the code.
function makeReplica() {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema.CREATE_SCHEMA_SQL);
  sqlite.function('regexp', (pattern: string, value: string) =>
    value != null && new RegExp(pattern, 'i').test(value) ? 1 : 0,
  );
  return { raw: sqlite, db: drizzle(sqlite, { schema }) } as unknown as ReplicaDb;
}

/** A settle that fails the test if reached: every case here should be rejected before any write. */
const noWrite = {
  around: async () => {
    throw new Error('reached the Postgres write despite failing validation');
  },
} as unknown as ReplicaSettled;

let replica: ReplicaDb;
let tools: ReturnType<typeof buildWriteTools>;

interface InvokableTool {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ isError?: boolean; content: { type: string; text?: string }[] }>;
}

// The tools array is a union of differently-shaped schemas, so TS intersects their arg types when
// indexed generically. Each test supplies the args for the one tool it names.
function byName(name: string): InvokableTool {
  const t = tools.tools.find((x) => x.name === name);
  assert.ok(t, `no tool named ${name}`);
  return t as unknown as InvokableTool;
}

function textOf(result: { content: { type: string; text?: string }[] }) {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('write tools — validation', () => {
  before(() => {
    replica = makeReplica();
    replica.db
      .insert(schema.matchingRule)
      .values({
        id: 'r-tigo',
        label: 'tigo',
        pattern: String.raw`\btigo\b`,
        priority: 210,
        enabled: true,
        createdAt: 'T',
        updatedAt: 'T',
      })
      .run();
    tools = buildWriteTools({ replica, settle: noWrite });
  });
  after(() => (replica as unknown as { raw: Database.Database }).raw.close());

  it('rejects a rule whose pattern is not a valid regex', async () => {
    const res = await byName('create_matching_rule').handler(
      { label: 'broken', pattern: '([unclosed', priority: 500 },
      undefined,
    );
    assert.equal(res.isError, true);
    assert.match(textOf(res), /not a valid regex/);
  });

  it('rejects a rule that backtracks exponentially', async () => {
    const res = await byName('create_matching_rule').handler(
      { label: 'evil', pattern: '(a+)+$', priority: 500 },
      undefined,
    );
    assert.equal(res.isError, true);
    assert.match(textOf(res), /backtracks exponentially/);
  });

  // Adding a near-duplicate is the failure mode the prompt steers away from: a stale rule should be
  // widened, not shadowed by a second one.
  it('rejects a duplicate label and points at updating instead', async () => {
    const res = await byName('create_matching_rule').handler(
      { label: 'tigo', pattern: String.raw`\btigo\s+pago\b`, priority: 500 },
      undefined,
    );
    assert.equal(res.isError, true);
    assert.match(textOf(res), /already exists — update it/);
  });

  it('rejects updating a rule that does not exist', async () => {
    const res = await byName('update_matching_rule').handler(
      { id: 'r-nope', pattern: String.raw`\bx\b` },
      undefined,
    );
    assert.equal(res.isError, true);
    assert.match(textOf(res), /no rule with id/);
  });

  it('rejects an update that changes nothing', async () => {
    const res = await byName('update_matching_rule').handler({ id: 'r-tigo' }, undefined);
    assert.equal(res.isError, true);
    assert.match(textOf(res), /nothing to update/);
  });

  it('rejects an empty payee name', async () => {
    const res = await byName('create_payee').handler({ name: '   ' }, undefined);
    assert.equal(res.isError, true);
  });

  it('records no side effects when everything was rejected', () => {
    assert.deepEqual(tools.sideEffects, { created: {}, updated: {} });
  });
});
