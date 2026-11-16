// Optional extras: /health and the Idempotency-Key header.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH, credit, dbClient, getBalance, ledgerRowsFor, newUserId, request, waitForApi } from './helpers.js';

const db = dbClient();
before(waitForApi);
after(() => db.end());

const withKey = (key) => ({ ...AUTH, 'idempotency-key': key });
const send = (path, body, key) => request('POST', path, { body, headers: withKey(key) });

describe('/health', () => {
  test('is public and reports ok', async () => {
    const res = await request('GET', '/health', { headers: {} });
    assert.deepEqual(res, { status: 200, body: { status: 'ok' } });
  });
});

describe('Idempotency-Key', () => {
  test('a retried credit is applied once and gets the same response', async () => {
    const userId = newUserId('idem');
    const key = `key-${userId}`;
    const first = await send('/credit', { user_id: userId, amount: 100 }, key);
    const retry = await send('/credit', { user_id: userId, amount: 100 }, key);
    assert.deepEqual(first, { status: 200, body: { user_id: userId, balance: 100 } });
    assert.deepEqual(retry, first);
    assert.deepEqual(await ledgerRowsFor(db, userId), [{ type: 'credit', amount: 100 }]);
  });

  test('20 concurrent requests with one key move money once', async () => {
    const userId = newUserId('idem_race');
    await credit(userId, 1000);
    const key = `key-${userId}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => send('/debit', { user_id: userId, amount: 300 }, key)),
    );
    assert.ok(results.every((r) => r.status === 200 && r.body.balance === 700));
    assert.equal((await getBalance(userId)).body.balance, 700);
    assert.equal((await ledgerRowsFor(db, userId)).length, 2);
  });

  test('a 409 outcome is replayed too, even after the balance has grown', async () => {
    const userId = newUserId('idem_409');
    await credit(userId, 10);
    const key = `key-${userId}`;
    assert.equal((await send('/debit', { user_id: userId, amount: 50 }, key)).status, 409);
    await credit(userId, 100);
    assert.equal((await send('/debit', { user_id: userId, amount: 50 }, key)).status, 409);
    assert.equal((await getBalance(userId)).body.balance, 110);
  });

  test('the same key for a different request -> 422, nothing written', async () => {
    const userId = newUserId('idem_reuse');
    const key = `key-${userId}`;
    await send('/credit', { user_id: userId, amount: 100 }, key);
    for (const [path, body] of [
      ['/credit', { user_id: userId, amount: 999 }],
      ['/debit', { user_id: userId, amount: 100 }],
      ['/credit', { user_id: `${userId}x`, amount: 100 }],
    ]) {
      const res = await send(path, body, key);
      assert.equal(res.status, 422);
      assert.equal(res.body.error, 'idempotency_key_reused');
    }
    assert.equal((await ledgerRowsFor(db, userId)).length, 1);
    assert.equal((await getBalance(`${userId}x`)).status, 404);
  });

  test('invalid keys -> 400', async () => {
    for (const key of ['', 'a'.repeat(256), 'has space']) {
      const res = await send('/credit', { user_id: 'u1', amount: 1 }, key);
      assert.equal(res.status, 400, JSON.stringify(key));
    }
  });

  test('without the header, every request is applied', async () => {
    const userId = newUserId('nokey');
    await credit(userId, 5);
    await credit(userId, 5);
    assert.equal((await getBalance(userId)).body.balance, 10);
  });
});
