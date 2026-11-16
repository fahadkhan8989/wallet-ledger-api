import pg from 'pg';
import { runForUser } from './userLimiter.js';

// Credit: create the user with this amount, or add to their balance, and
// write the ledger row -- all in ONE statement, so it is one transaction.
// While it runs, Postgres holds the lock on that user's row, so concurrent
// credits for the same user apply one after another and none is lost.
const CREDIT_SQL = `
  WITH updated AS (
    INSERT INTO users (id, balance) VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET balance = users.balance + EXCLUDED.balance
    RETURNING balance
  ), entry AS (
    INSERT INTO ledger (user_id, type, amount)
    SELECT $1, 'credit', $2 FROM updated
  )
  SELECT balance FROM updated`;

// Debit: subtract only if the balance covers it; write the ledger row only if
// the subtraction happened. If another debit for the same user is in flight,
// this waits for its row lock and then re-checks "balance >= $2" against the
// new balance (READ COMMITTED behaviour), so the balance can't go below 0.
const DEBIT_SQL = `
  WITH updated AS (
    UPDATE users SET balance = balance - $2
    WHERE id = $1 AND balance >= $2
    RETURNING balance
  ), entry AS (
    INSERT INTO ledger (user_id, type, amount)
    SELECT $1, 'debit', $2 FROM updated
  )
  SELECT balance FROM updated`;

const BALANCE_SQL = 'SELECT balance FROM users WHERE id = $1';

// Idempotency-Key: saved in the same transaction as the operation. If the key
// already exists, nothing is inserted (and the transaction is rolled back).
const SAVE_KEY_SQL = `
  INSERT INTO idempotency_keys (key, operation, user_id, amount, outcome, balance)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (key) DO NOTHING`;
const FIND_KEY_SQL = 'SELECT operation, user_id, amount, outcome, balance FROM idempotency_keys WHERE key = $1';

// serialization_failure and deadlock_detected. Neither should happen (each
// statement locks a single row), but if Postgres ever reports one, retry.
const RETRYABLE = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 3;

async function withRetry(run) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt === MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
    }
  }
}

// Runs a credit or debit with the given `query` function and returns
// { status: 'ok', balance } or { status: 'user_not_found' | 'insufficient_funds' }.
async function runOperation(query, operation, userId, amount) {
  const sql = operation === 'credit' ? CREDIT_SQL : DEBIT_SQL;
  const { rows } = await query(operation, sql, [userId, amount]);
  if (rows.length === 1) return { status: 'ok', balance: rows[0].balance };

  // Debit wrote nothing. Tell "never credited" apart from "not enough money".
  const found = await query('balance', BALANCE_SQL, [userId]);
  return { status: found.rows.length === 0 ? 'user_not_found' : 'insufficient_funds' };
}

export function createLedger(databaseUrl) {
  // No connectionTimeoutMillis: under load a request waits for a free
  // connection instead of failing. idleTimeoutMillis 0 keeps connections
  // (and their prepared statements) open.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20, idleTimeoutMillis: 0 });

  // If the database drops an idle connection (e.g. it restarts), pg removes
  // that connection and emits 'error'. Without a listener Node would crash.
  pool.on('error', (err) => console.error(`database connection lost: ${err.message}`));

  // A "name" makes pg prepare the statement once per connection and reuse it.
  const poolQuery = (name, text, values) => withRetry(() => pool.query({ name, text, values }));

  // With an Idempotency-Key: the operation and the saved key commit together.
  // If the key was already saved, roll back and return the saved outcome, or
  // { status: 'key_reused' } if the key was used for a different request.
  async function runIdempotent(key, operation, userId, amount) {
    return withRetry(async () => {
      const client = await pool.connect();
      let broken;
      try {
        const query = (name, text, values) => client.query({ name, text, values });
        await client.query('BEGIN');
        const result = await runOperation(query, operation, userId, amount);
        const saved = await query('save_key', SAVE_KEY_SQL,
          [key, operation, userId, amount, result.status, result.balance ?? null]);
        if (saved.rowCount === 1) {
          await client.query('COMMIT');
          return result;
        }

        await client.query('ROLLBACK');
        const { rows: [previous] } = await query('find_key', FIND_KEY_SQL, [key]);
        const sameRequest = previous.operation === operation && previous.user_id === userId
          && Number(previous.amount) === amount;
        if (!sameRequest) return { status: 'key_reused' };
        return { status: previous.outcome, balance: previous.balance };
      } catch (err) {
        broken = err;
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release(broken); // a connection that errored is discarded
      }
    });
  }

  return {
    // operation is 'credit' or 'debit'; idempotencyKey is optional.
    apply: (operation, userId, amount, idempotencyKey) =>
      runForUser(userId, () =>
        idempotencyKey
          ? runIdempotent(idempotencyKey, operation, userId, amount)
          : runOperation(poolQuery, operation, userId, amount)),

    // Reads skip the per-user queue: in Postgres a plain SELECT never waits
    // for row locks, and it always sees every committed write.
    getBalance: async (userId) => {
      const { rows } = await poolQuery('balance', BALANCE_SQL, [userId]);
      return rows.length === 1 ? rows[0].balance : null;
    },

    ping: () => pool.query('SELECT 1'),
    close: () => pool.end(),
  };
}
