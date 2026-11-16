import { readFile } from 'node:fs/promises';
import pg from 'pg';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
export const TOKEN = process.env.API_TOKEN;
if (!TOKEN) throw new Error('API_TOKEN must be set (docker compose run --rm test passes it)');
export const AUTH = { authorization: `Bearer ${TOKEN}` };

// Unique user ids per test run, so tests never depend on earlier data.
const runId = Date.now().toString(36);
let counter = 0;
export const newUserId = (label) => `t_${runId}_${label}_${counter++}`;

// Sends a request and returns { status, body }. `body` may be an object
// (sent as JSON) or a raw string (sent as-is, for malformed-input tests).
export async function request(method, path, { body, headers = AUTH } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: typeof body === 'string' || body === undefined ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export const credit = (user_id, amount) => request('POST', '/credit', { body: { user_id, amount } });
export const debit = (user_id, amount) => request('POST', '/debit', { body: { user_id, amount } });
export const getBalance = (userId) => request('GET', `/balance/${userId}`);

export async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE_URL + '/health')).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API not reachable at ${BASE_URL}`);
}

// Direct database access, used only to check the ledger itself.
export function dbClient() {
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}

export async function ledgerRowsFor(db, userId) {
  const { rows } = await db.query(
    "SELECT type, amount::int AS amount FROM ledger WHERE user_id = $1 ORDER BY id",
    [userId],
  );
  return rows;
}

export async function reconcile(db) {
  const sql = await readFile(new URL('../db/reconcile.sql', import.meta.url), 'utf8');
  const { rows } = await db.query(sql);
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
}

export function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(q * (sorted.length - 1))];
}
