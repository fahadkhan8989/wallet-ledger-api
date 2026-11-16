// The six concurrency and consistency rules from the brief.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { credit, dbClient, debit, getBalance, ledgerRowsFor, newUserId, percentile, waitForApi } from './helpers.js';

const db = dbClient();
before(waitForApi);
after(() => db.end());

const sum = (rows) => rows.reduce((total, r) => total + (r.type === 'credit' ? r.amount : -r.amount), 0);

describe('concurrency rules', () => {
  test('1. non-negative: two concurrent debits of 60 against 100 -> one 200 and one 409 (x50)', async () => {
    for (let i = 0; i < 50; i++) {
      const userId = newUserId('neg');
      await credit(userId, 100);
      const results = await Promise.all([debit(userId, 60), debit(userId, 60)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal((await getBalance(userId)).body.balance, 40);
    }
  });

  test('1b. many concurrent debits never overdraw', async () => {
    const userId = newUserId('drain');
    await credit(userId, 1000);
    const results = await Promise.all(Array.from({ length: 200 }, () => debit(userId, 7)));
    const ok = results.filter((r) => r.status === 200).length;
    assert.equal(ok, Math.floor(1000 / 7)); // exactly 142 fit
    assert.ok(results.every((r) => r.status === 200 || r.status === 409));
    assert.equal((await getBalance(userId)).body.balance, 1000 - ok * 7);
  });

  test('2. no lost updates: 1,000 concurrent credits of 100 raise the balance by exactly 100,000', async () => {
    const userId = newUserId('lost');
    await credit(userId, 1);
    const results = await Promise.all(Array.from({ length: 1000 }, () => credit(userId, 100)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal((await getBalance(userId)).body.balance, 1 + 100_000);
    // Each response reports the balance right after its own credit, so all differ.
    assert.equal(new Set(results.map((r) => r.body.balance)).size, 1000);
  });

  test('2b. concurrent first credits of a new user all count', async () => {
    const userId = newUserId('first');
    const results = await Promise.all(Array.from({ length: 50 }, () => credit(userId, 10)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal((await getBalance(userId)).body.balance, 500);
  });

  test('3. atomicity: ledger rows match successful responses exactly, under concurrency', async () => {
    const userId = newUserId('atomic');
    await credit(userId, 500);
    const ops = Array.from({ length: 300 }, (_, i) => (i % 2 ? debit(userId, 13) : credit(userId, 5)));
    const results = await Promise.all(ops);
    const succeeded = results.filter((r) => r.status === 200).length;
    const rows = await ledgerRowsFor(db, userId);
    assert.equal(rows.length, 1 + succeeded); // one row per 200, none for 409
    assert.equal(sum(rows), (await getBalance(userId)).body.balance);
    // (Crash safety is checked by scripts/crash-test.sh.)
  });

  test('4. read-your-writes: a balance read right after a 200 reflects it', async () => {
    await Promise.all(Array.from({ length: 50 }, async () => {
      const userId = newUserId('ryw');
      let expected = 0;
      for (let i = 0; i < 10; i++) {
        const res = i % 3 === 2 ? await debit(userId, 3) : await credit(userId, 10);
        expected = res.body.balance;
        assert.equal((await getBalance(userId)).body.balance, expected);
      }
    }));
  });

  test('5. isolation: heavy traffic on one user does not slow other users', async () => {
    const hot = newUserId('hot');
    const others = Array.from({ length: 10 }, () => newUserId('calm'));
    await Promise.all([hot, ...others].map((id) => credit(id, 1)));

    const timeOthers = async (rounds) => {
      const times = [];
      for (let r = 0; r < rounds; r++) {
        await Promise.all(others.map(async (id) => {
          const start = performance.now();
          const res = r % 2 ? await getBalance(id) : await credit(id, 1);
          times.push(performance.now() - start);
          assert.equal(res.status, 200);
        }));
      }
      return times;
    };

    const baseline = percentile(await timeOthers(20), 0.99);

    // 90 clients hammer the hot user in a loop while we time the others.
    let running = true;
    let hotRequests = 0;
    const hammer = Promise.all(Array.from({ length: 90 }, async () => {
      while (running) {
        assert.equal((await credit(hot, 1)).status, 200);
        hotRequests++;
      }
    }));
    await new Promise((r) => setTimeout(r, 200));
    const underLoad = percentile(await timeOthers(20), 0.99);
    running = false;
    await hammer;

    console.log(`  others p99: ${baseline.toFixed(1)} ms alone, ${underLoad.toFixed(1)} ms during ${hotRequests} hot-user requests`);
    assert.ok(hotRequests > 100, 'hot user traffic actually ran');
    assert.ok(underLoad < Math.max(baseline * 5, 100), `others slowed down: p99 ${underLoad} ms`);
  });

  test('6. no silent failures: a random mix on one user returns only 200/409 and adds up', async () => {
    const userId = newUserId('mix');
    await credit(userId, 1000);
    const ops = Array.from({ length: 500 }, () => {
      const amount = 1 + Math.floor(Math.random() * 50);
      return Math.random() < 0.5 ? credit(userId, amount) : debit(userId, amount);
    });
    const results = await Promise.all(ops);
    assert.ok(results.every((r) => r.status === 200 || r.status === 409));
    const balance = (await getBalance(userId)).body.balance;
    assert.ok(balance >= 0);
    assert.equal(balance, sum(await ledgerRowsFor(db, userId)));
  });
});
