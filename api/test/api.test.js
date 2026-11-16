// API contract: auth, input rules, status codes and response shapes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH, TOKEN, credit, dbClient, debit, getBalance, ledgerRowsFor, newUserId, request, waitForApi } from './helpers.js';

const db = dbClient();
before(waitForApi);
after(() => db.end());

const unauthorized = { error: 'unauthorized', message: 'Missing or invalid bearer token' };

describe('authentication', () => {
  const body = '{"user_id":"auth_user","amount":1}';
  const cases = {
    'missing header': {},
    'wrong token': { authorization: 'Bearer wrong-token' },
    'wrong scheme': { authorization: `Basic ${TOKEN}` },
    'lowercase scheme': { authorization: `bearer ${TOKEN}` },
    'empty token': { authorization: 'Bearer ' },
  };

  for (const [name, headers] of Object.entries(cases)) {
    test(`${name} -> 401 on every endpoint`, async () => {
      for (const [method, path] of [['POST', '/credit'], ['POST', '/debit'], ['GET', '/balance/auth_user']]) {
        const res = await request(method, path, { headers, body: method === 'POST' ? body : undefined });
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.deepEqual(res.body, unauthorized);
      }
    });
  }

  test('401 is checked before the body: no token + malformed JSON -> 401', async () => {
    const res = await request('POST', '/credit', { headers: {}, body: '{not json' });
    assert.equal(res.status, 401);
  });

  test('401 on unknown routes too', async () => {
    assert.equal((await request('GET', '/nope', { headers: {} })).status, 401);
  });

  test('rejected request writes nothing', async () => {
    const userId = newUserId('auth');
    await request('POST', '/credit', { headers: {}, body: { user_id: userId, amount: 5 } });
    assert.deepEqual(await ledgerRowsFor(db, userId), []);
  });
});

describe('input validation -> 400 invalid_request', () => {
  const badBodies = {
    'malformed JSON': '{"user_id":"u1",',
    'empty body': '',
    'JSON array': '[]',
    'JSON null': 'null',
    'missing user_id': { amount: 1 },
    'missing amount': { user_id: 'u1' },
    'amount as decimal 100.0': '{"user_id":"u1","amount":100.0}',
    'amount as float 1.5': '{"user_id":"u1","amount":1.5}',
    'amount in exponent form 1e2': '{"user_id":"u1","amount":1e2}',
    'amount as string': { user_id: 'u1', amount: '100' },
    'amount as boolean': { user_id: 'u1', amount: true },
    'amount null': { user_id: 'u1', amount: null },
    'amount 0': { user_id: 'u1', amount: 0 },
    'amount negative': { user_id: 'u1', amount: -5 },
    'amount -0': '{"user_id":"u1","amount":-0}',
    'amount above 1,000,000,000': { user_id: 'u1', amount: 1_000_000_001 },
    'amount huge': '{"user_id":"u1","amount":99999999999999999999}',
    'user_id as number': { user_id: 123, amount: 1 },
    'user_id empty': { user_id: '', amount: 1 },
    'user_id 65 chars': { user_id: 'a'.repeat(65), amount: 1 },
    'user_id with space': { user_id: 'a b', amount: 1 },
    'user_id with @': { user_id: 'a@b', amount: 1 },
    'user_id with non-ASCII letter': { user_id: 'é', amount: 1 },
    'user_id with trailing newline': { user_id: 'abc\n', amount: 1 },
  };

  for (const [name, body] of Object.entries(badBodies)) {
    test(name, async () => {
      for (const path of ['/credit', '/debit']) {
        const res = await request('POST', path, { body });
        assert.equal(res.status, 400, path);
        assert.equal(res.body.error, 'invalid_request');
        assert.equal(typeof res.body.message, 'string');
      }
    });
  }

  test('invalid user_id in /balance path', async () => {
    assert.equal((await request('GET', '/balance/bad@id')).status, 400);
    assert.equal((await request('GET', '/balance/')).status, 400);
    assert.equal((await request('GET', `/balance/${'a'.repeat(65)}`)).status, 400);
    assert.equal((await request('GET', '/balance/%E0%A4%A')).status, 400); // malformed %-encoding
  });

  test('unreadable body -> 400, not 500', async () => {
    const send = (headers) =>
      request('POST', '/credit', { headers: { ...AUTH, ...headers }, body: '{"user_id":"u1","amount":1}' });
    for (const headers of [{ 'content-encoding': 'gzip' }, { 'content-type': 'application/json; charset=foo' }]) {
      const res = await send(headers);
      assert.equal(res.status, 400, JSON.stringify(headers));
      assert.equal(res.body.error, 'invalid_request');
    }
  });

  test('boundaries are accepted: amount 1 and 1,000,000,000; user_id of 64 chars', async () => {
    const userId = newUserId('b').padEnd(64, 'x');
    assert.equal((await credit(userId, 1)).status, 200);
    assert.equal((await credit(userId, 1_000_000_000)).status, 200);
    assert.deepEqual((await getBalance(userId)).body, { user_id: userId, balance: 1_000_000_001 });
  });

  test('unknown fields are ignored', async () => {
    const userId = newUserId('extra');
    const res = await request('POST', '/credit', { body: { user_id: userId, amount: 7, note: 'hi', currency: 'KES' } });
    assert.deepEqual(res.body, { user_id: userId, balance: 7 });
  });

  test('invalid request writes nothing', async () => {
    const userId = newUserId('inv');
    await request('POST', '/credit', { body: `{"user_id":"${userId}","amount":1.5}` });
    assert.deepEqual(await ledgerRowsFor(db, userId), []);
    assert.equal((await getBalance(userId)).status, 404);
  });
});

describe('credit, debit, balance', () => {
  test('example from the brief', async () => {
    const userId = newUserId('brief');
    assert.deepEqual(await credit(userId, 15000), { status: 200, body: { user_id: userId, balance: 15000 } });
    assert.deepEqual(await credit(userId, 10000), { status: 200, body: { user_id: userId, balance: 25000 } });
    assert.deepEqual(await debit(userId, 4000), { status: 200, body: { user_id: userId, balance: 21000 } });
    assert.deepEqual(await getBalance(userId), { status: 200, body: { user_id: userId, balance: 21000 } });
  });

  test('first credit creates the user', async () => {
    const userId = newUserId('new');
    assert.equal((await getBalance(userId)).status, 404);
    assert.equal((await credit(userId, 1)).status, 200);
    assert.equal((await getBalance(userId)).status, 200);
  });

  test('balance and debit of a never-credited user -> 404 user_not_found, nothing written', async () => {
    const userId = newUserId('ghost');
    for (const res of [await getBalance(userId), await debit(userId, 1)]) {
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'user_not_found');
    }
    assert.deepEqual(await ledgerRowsFor(db, userId), []);
  });

  test('debit larger than balance -> 409 insufficient_funds, nothing written', async () => {
    const userId = newUserId('poor');
    await credit(userId, 100);
    const res = await debit(userId, 101);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'insufficient_funds');
    assert.deepEqual(await ledgerRowsFor(db, userId), [{ type: 'credit', amount: 100 }]);
    assert.equal((await getBalance(userId)).body.balance, 100);
  });

  test('debit down to exactly 0 is allowed; then a user with balance 0 gets 409, not 404', async () => {
    const userId = newUserId('zero');
    await credit(userId, 50);
    assert.deepEqual((await debit(userId, 50)).body, { user_id: userId, balance: 0 });
    assert.equal((await debit(userId, 1)).status, 409);
    assert.deepEqual((await getBalance(userId)).body, { user_id: userId, balance: 0 });
  });

  test('every successful operation writes exactly one ledger row', async () => {
    const userId = newUserId('rows');
    await credit(userId, 300);
    await debit(userId, 100);
    await debit(userId, 500); // 409: no row
    await credit(userId, 5);
    assert.deepEqual(await ledgerRowsFor(db, userId), [
      { type: 'credit', amount: 300 },
      { type: 'debit', amount: 100 },
      { type: 'credit', amount: 5 },
    ]);
  });

  test('unknown route -> 404 with the error shape', async () => {
    const res = await request('GET', '/credit');
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(res.body), ['error', 'message']);
  });
});
