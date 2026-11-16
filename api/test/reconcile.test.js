// Runs last: every user in the database must match the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbClient, reconcile } from './helpers.js';

test('every balance equals credits minus debits, and never went below 0', async () => {
  const db = dbClient();
  try {
    const result = await reconcile(db);
    console.log(`  ${JSON.stringify(result)}`);
    assert.equal(result.mismatched_users, 0);
    assert.equal(result.negative_balances, 0);
    assert.equal(result.users_ever_below_zero, 0);
  } finally {
    await db.end();
  }
});
