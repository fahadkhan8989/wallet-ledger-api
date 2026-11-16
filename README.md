# Wallet Ledger API

An HTTP API that keeps a money ledger for many users: `credit`, `debit` and
`get_balance`, backed by PostgreSQL. Built with Node.js 24 and Express 5, in plain JavaScript.

- Every balance always equals the user's credits minus their debits in the ledger.
- Each credit or debit is **one SQL statement**. That makes it atomic, and it holds
  the user's row lock for as short a time as possible.
- Reads are a single primary-key lookup. Latency stays the same at 1M and at 10M ledger rows.

---

## Quick start

Requirements: Docker with the Compose plugin. Port 8080 must be free. Nothing else is
needed on the host, except `bash` and `curl` for the crash test script.

```bash
docker compose up                      # API on http://localhost:8080, plus PostgreSQL
                                       # (or `docker compose up -d --wait` to run it in the background)
docker compose run --rm seed           # load 10M ledger rows (about 1 minute)
docker compose run --rm test           # automated tests (60), including concurrency
docker compose run --rm loadtest       # k6 load test, prints p50/p99 per endpoint
docker compose run --rm loadtest run --quiet /scripts/sequential.js   # one request at a time, whale vs normal
./scripts/crash-test.sh                # kill API and DB mid-traffic, then reconcile

# Reconcile every balance against the ledger (all counts except users/ledger_rows must be 0)
docker compose exec -T db psql -U ledger -d ledger < db/reconcile.sql
```

**For your own reconciliation SQL:** balances live in `users.balance`, keyed by `users.id`
(the `user_id` string). Ledger rows are in `ledger(user_id, type, amount)`:

```sql
SELECT u.id, u.balance, l.total
FROM users u
JOIN (SELECT user_id, sum(CASE type WHEN 'credit' THEN amount ELSE -amount END) AS total
      FROM ledger GROUP BY user_id) l ON l.user_id = u.id
WHERE u.balance <> l.total;          -- expect 0 rows
```

- **Token:** `API_TOKEN` defaults to `recruitment-test-token`. To override it, start with
  `API_TOKEN=my-token docker compose up -d --wait`. The test and load-test containers
  pick up the same variable.
- **Smaller seed:** `SEED_ROWS=1000000 docker compose run --rm seed`.
- **Fresh database:** `docker compose down -v`. The seed refuses to run twice, because the
  ledger is append-only.
- **Test tooling runs in containers on the compose network,** so nothing but Docker is needed.
- **Database access from your machine** (DBeaver, psql, …): `localhost:5433`, database,
  user and password all `ledger`, e.g. `postgresql://ledger:ledger@localhost:5433/ledger`.
  It's bound to localhost only, and uses 5433 so it doesn't clash with a local PostgreSQL.
  If 5433 is taken, start with `DB_PORT=6543 docker compose up`.

```bash
curl -s -X POST localhost:8080/credit -H 'Authorization: Bearer recruitment-test-token' \
     -d '{"user_id":"u123","amount":10000}'
# {"user_id":"u123","balance":10000}
```

---

## API

| Endpoint | Body | Success |
|---|---|---|
| `POST /credit` | `{"user_id","amount"}` | `200 {"user_id","balance"}`: adds the amount and creates the user on first credit |
| `POST /debit` | `{"user_id","amount"}` | `200 {"user_id","balance"}`: subtracts the amount, but never below 0 |
| `GET /balance/{user_id}` | none | `200 {"user_id","balance"}` |
| `GET /health` | none | `200 {"status":"ok"}`, or `503` if the database is unreachable. **Public** (see below) |

Errors use the shape `{"error": "<code>", "message": "<text>"}`:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON, body not an object, missing field, or a field breaking the input rules. Also an unreadable body (bad encoding or charset, over 1 KB) or malformed `%`-encoding in the URL |
| 401 | `unauthorized` | Missing header, wrong scheme or wrong token. Checked **before** the body is read and before any DB access |
| 404 | `user_not_found` | Balance or debit for a user who has never been credited |
| 404 | `not_found` | Unknown route |
| 409 | `insufficient_funds` | Debit larger than the balance. Nothing is written |
| 422 | `idempotency_key_reused` | An `Idempotency-Key` sent again with a different request (optional extra) |

**Input rules**
- **`user_id`:** a JSON string matching `^[A-Za-z0-9_-]{1,64}$`. The same rule applies to the
  `user_id` in the `/balance` path.
- **`amount`:** must be written in the JSON as an integer from 1 to 1,000,000,000.
  - `100.0`, `1e2`, `-0`, `"100"`, `true` and `null` are all rejected.
  - Plain `JSON.parse` turns `100`, `100.0` and `1e2` into the same number. So the parser
    uses Node 24's `JSON.parse` *source text* access (the reviver's third argument) to see
    exactly how each number was written.
- **Unknown fields** are ignored.
- **Bodies over 1 KB** are rejected.

**Authentication**
- **Scheme:** only the exact scheme `Bearer` is accepted.
- **Constant-time compare:** both the expected and the provided token are hashed with
  SHA-256, then compared with `crypto.timingSafeEqual`. The compare's timing therefore
  reveals neither the token's content nor its length.
- **Token handling:** the token comes only from the environment. It is never logged or
  returned, and the app refuses to start if it is empty.

**`/health` is public on purpose.** Load balancers and orchestrators call it without
credentials, and it returns no data. This is the one deliberate exception to "every
endpoint requires the header".

---

## Design

### Schema ([db/schema.sql](db/schema.sql))

```sql
users  (id VARCHAR(64) PRIMARY KEY,           -- the client's user_id, e.g. 'u123'
        balance BIGINT NOT NULL CHECK (balance >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())

ledger (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('credit','debit')),
        amount BIGINT NOT NULL CHECK (amount > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())
```

- **`ledger` is the source of truth.** It holds one immutable row per credit or debit.
  - Triggers reject `UPDATE`, `DELETE` and `TRUNCATE`, so "rows are never updated or
    deleted" is enforced by the database, not just by the code.
  - Its **only index is the primary key**. The API never reads the ledger, so every extra
    index would only slow down every write.
- **`users` holds one row per user, with the current balance.**
  - The row is created by the user's first credit; it is the user record.
  - Its key is the client's own id string. We never generate ids, and every query looks
    users up by that id.
  - A separate `balances` table was rejected: it would always be one-to-one with `users`,
    adding a write and a consistency risk for nothing.
- **`CHECK` constraints are a safety net.** Even with a bug in the API, the database
  refuses a zero or negative amount, an unknown type, or a negative balance.
- **`BIGINT`** for all money columns. `pg` returns `BIGINT` as a string, and the API writes
  that string straight into the JSON response, so balances above 2^53 are never rounded.
- **`idempotency_keys`** supports the optional `Idempotency-Key` header (see below).
- **All indexes:** `users_pkey` (users.id), `ledger_pkey` (ledger.id) and
  `idempotency_keys_pkey` (idempotency_keys.key). There are deliberately no others.

### How the balance is computed

The balance is **not** computed by summing the ledger on read. The brief rules that out at
this size. Instead, `users.balance` is a running total, updated **in the same SQL
statement** that inserts the ledger row. Both change together or neither does, so
`balance = sum(credits) − sum(debits)` holds at every commit.
[db/reconcile.sql](db/reconcile.sql) checks it for every user.

### Writes: one statement each ([api/src/ledger.js](api/src/ledger.js))

```sql
-- credit
WITH updated AS (
  INSERT INTO users (id, balance) VALUES ($1, $2)
  ON CONFLICT (id) DO UPDATE SET balance = users.balance + EXCLUDED.balance
  RETURNING balance
), entry AS (
  INSERT INTO ledger (user_id, type, amount) SELECT $1, 'credit', $2 FROM updated
)
SELECT balance FROM updated;

-- debit
WITH updated AS (
  UPDATE users SET balance = balance - $2
  WHERE id = $1 AND balance >= $2
  RETURNING balance
), entry AS (
  INSERT INTO ledger (user_id, type, amount) SELECT $1, 'debit', $2 FROM updated
)
SELECT balance FROM updated;

-- get_balance
SELECT balance FROM users WHERE id = $1;
```

- **Credit creates the user on first use.** `ON CONFLICT` turns a concurrent "first
  credit" into an add, so there are no duplicates and no lost credit.
- **Debit only subtracts when the balance covers it.** If no row is returned, nothing was
  written, and one primary-key lookup decides between **404** (no user row) and **409**.
- **One round trip each.** Statements are named, so `pg` prepares them once per connection.
- **No `FOREIGN KEY` from `ledger.user_id` to `users.id`.** The single statement already
  guarantees the user row exists whenever a ledger row is written. Skipping the key keeps
  the insert minimal, and it lets the seed load the ledger first and build `users` from it.

### Concurrency and isolation level

**Isolation level: PostgreSQL's default, READ COMMITTED.** The `UPDATE`/upsert takes a
row lock on the user's row:

- **Same user:** concurrent writes queue on that lock.
- **Different users:** they lock different rows and never wait for each other.
- **The re-check:** a debit that waited for the lock **re-evaluates `balance >= $2`
  against the newly committed balance** before applying. That is Postgres's
  "EvalPlanQual" behaviour, and it is what makes the conditional update safe without
  SERIALIZABLE.

How each rule from the brief is met:

| Rule | How |
|---|---|
| 1. Non-negative balance | Two debits of 60 against 100: the second waits for the lock, re-checks `40 >= 60`, updates nothing and returns 409. The `CHECK (balance >= 0)` constraint is a second line of defence |
| 2. No lost updates | `balance = balance + $2` is computed under the row lock, from the latest committed value |
| 3. Atomicity | One statement is one transaction: a crash mid-request rolls it back completely. Tested by killing the API and the DB with SIGKILL during traffic ([scripts/crash-test.sh](scripts/crash-test.sh)) |
| 4. Read-your-writes | A single primary and no cache: a 200 is sent only after COMMIT, and later reads see it |
| 5. Isolation across users | Row-level locks, plus the per-user queue below, so a hot user can't take every pool connection |
| 6. No silent failures | Each statement locks exactly one row, so deadlocks can't happen. Even so, `40001`/`40P01` are retried (3 attempts, jittered). Only a failed statement is retried, and a failed statement never committed, so a retry can't apply anything twice |

**Ledger order:** each ledger id is drawn *while the user's row lock is held*. So, per user,
ledger id order is exactly the order in which operations were applied, and the reconcile
query checks that no user's running balance ever dips below 0 in that order.
`created_at` is the transaction start time, so it can be slightly out of order under contention.

### Per-user queue ([api/src/userLimiter.js](api/src/userLimiter.js))

- **The problem:** the pool has 20 connections. Without the queue, 100 concurrent writes
  to one hot user would each take a pool connection and then sit waiting for that user's
  row lock. Every other user would then queue for a connection.
- **The fix:** an in-process queue per `user_id` (a `Map` of promise chains). Each user
  runs one write at a time. The hot user's requests wait in memory without holding
  connections, and other users always find free ones.
- **No throughput is lost.** Writes for one user are serialized by the row lock anyway.
  The queue moves the waiting from the database into the app.
- **Correctness doesn't depend on it.** It only rations connections; the database
  enforces every rule.
- **Reads skip it.** A plain `SELECT` never waits for row locks.
- **No memory growth.** A user's entry is deleted when their queue empties.

Measured in the load test, while 90 virtual users hammer one user: **other users' p99 stays
at 3.5 ms for reads and about 20 ms for writes.**

### Request path ([api/src/app.js](api/src/app.js))

1. `requireToken` (401). This middleware is registered first, so it runs before the body is read.
2. `express.text` reads the body as raw text, from any `Content-Type`, up to 1 KB.
3. `parseOperation` parses the JSON, keeps each number's source text, and validates `user_id` and `amount` (400).
4. `ledger.apply` runs the per-user queue and then one SQL statement.
5. `errorHandler` formats every error as `{"error","message"}`. Unexpected errors become 500 and are
   logged without request headers.

### Optional extras

- **`Idempotency-Key`** on credit and debit: 1–255 visible ASCII characters, chosen by the client.
  - **First request:** the operation and a row in `idempotency_keys` (key, operation,
    user_id, amount, outcome, balance) are written in **one transaction**.
  - **Retry with the same key:** `INSERT … ON CONFLICT DO NOTHING` inserts nothing, the
    transaction is rolled back, and the saved outcome is returned. That includes saved 404
    and 409 responses.
  - **Same key, different request:** `422`.
  - **Concurrent duplicates:** they wait on the unique key and then replay, so money
    moves exactly once.
  - **Requests without the header** take the single-statement path, unchanged.
  - **Keys never expire** (see limits).
- **`GET /health`** checks that the database is reachable. Compose uses it as the API's
  healthcheck, so the `test` and `loadtest` containers start only once the API is ready.
- **Graceful shutdown.** On SIGTERM/SIGINT the server:
  - stops accepting connections;
  - sends `Connection: close` on in-flight responses, so busy keep-alive connections drain;
  - closes the pool once the last request finishes, then exits 0.

  Measured: `docker compose stop api` under traffic takes about 0.4 s, and every committed
  request got its response.
- **`pool.on('error')`.** When the database restarts, `pg` reports the dead idle
  connections as an `error` event; without a listener, Node would crash. The crash test found this.

---

## Alternatives considered and rejected

| Option | Why not |
|---|---|
| Compute the balance with `SUM` over the ledger on every read | Scans the user's whole history, which the brief rules out at 10M+ rows |
| `balance_after` column on each ledger row, read the latest row | Needs a `(user_id, id)` index on the big table, which every write would pay for. Still needs a per-user lock to compute the next value |
| Separate `balances` table next to `users` | Always one-to-one: an extra write and a second row to keep in sync |
| Numeric surrogate key for users | Would still need a unique index on `user_id`, and nothing would ever look users up by the number |
| SERIALIZABLE isolation | Under contention it aborts transactions that we would then have to retry. READ COMMITTED with a conditional update is already correct |
| `SELECT … FOR UPDATE`, then `UPDATE` | An extra round trip while holding the lock: longer lock hold, lower hot-user throughput |
| Advisory locks or an in-app mutex as the safety mechanism | The row lock already exists. An in-app mutex would break with several instances |
| Cache balances in memory or Redis | Breaks read-your-writes across instances, and adds a component |
| `synchronous_commit = off` | Faster commits, but a crash could lose writes that were already acknowledged |
| Index on `ledger.user_id` | The API never reads the ledger by user, so it would only slow down writes |
| Node `cluster` (several worker processes) | Measured with 2 and 4 workers: about +10% throughput on this 6-core laptop, where k6, Postgres and the API share the CPU. Not worth the extra moving parts here; see "Limits" |
| `lossless-json` package to detect `100.0` | Node 24's `JSON.parse` source text access does the same thing with no dependency |
| Fastify / NestJS | Express is the framework I can explain line by line. The database commit, not the framework, dominates write latency |

---

## Query plans (10.5M ledger rows)

Captured with `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)` against `seed_whale_01`, a user
with **176,326 ledger rows**. Credit and debit ran inside `BEGIN … ROLLBACK`, so nothing was kept.
None of the plans touches the user's history, so the size of the ledger doesn't matter.

**get_balance:** a primary-key lookup, 4 buffers.
```
 Index Scan using users_pkey on users (actual time=0.039..0.041 rows=1 loops=1)
   Index Cond: ((id)::text = 'seed_whale_01'::text)
   Buffers: shared hit=4
 Planning Time: 0.197 ms
 Execution Time: 0.093 ms
```

**credit:** upsert through `users_pkey`, then one ledger insert. No ledger scan.
```
 CTE Scan on updated (actual time=0.176..0.178 rows=1 loops=1)
   Buffers: shared hit=12
   CTE updated
     ->  Insert on users (actual time=0.174..0.174 rows=1 loops=1)
           Conflict Resolution: UPDATE
           Conflict Arbiter Indexes: users_pkey
           Tuples Inserted: 0
           Conflicting Tuples: 1
           Buffers: shared hit=12
           ->  Result (actual time=0.003..0.003 rows=1 loops=1)
   CTE entry
     ->  Insert on ledger (actual time=0.192..0.192 rows=0 loops=1)
           Buffers: shared hit=21
           ->  CTE Scan on updated updated_1 (actual time=0.086..0.087 rows=1 loops=1)
                 Buffers: shared hit=10
 Planning Time: 0.227 ms
 Execution Time: 0.554 ms
```

**debit:** a conditional update through `users_pkey`, then one ledger insert.
```
 CTE Scan on updated (actual time=0.066..0.069 rows=1 loops=1)
   Buffers: shared hit=6
   CTE updated
     ->  Update on users (actual time=0.064..0.066 rows=1 loops=1)
           Buffers: shared hit=6
           ->  Index Scan using users_pkey on users (actual time=0.030..0.031 rows=1 loops=1)
                 Index Cond: ((id)::text = 'seed_whale_01'::text)
                 Filter: (balance >= 400)
                 Buffers: shared hit=4
   CTE entry
     ->  Insert on ledger (actual time=0.037..0.037 rows=0 loops=1)
           Buffers: shared hit=3
           ->  CTE Scan on updated updated_1 (actual time=0.006..0.006 rows=1 loops=1)
                 Buffers: shared hit=1
 Planning Time: 0.214 ms
 Execution Time: 0.146 ms
```

---

## Seed ([db/seed.sql](db/seed.sql))

- **Volume:** 10,000,008 ledger rows for 100,020 users, generated inside PostgreSQL with
  `generate_series` and loaded in **one transaction**.
- **Uneven spread:**

  | Users | Rows each | Share of rows |
  |---|---|---|
  | 20 "whales" | about 150,000 | 30% |
  | 100,000 regular users | 1 to about 208 (grows with the square of the user's position) | 70% |

- **Never negative at any point.** Each user's rows alternate credit, debit, credit, … and
  every debit is 80% of the credit just before it.
- **Ledger order matches operation order.** Ids increase with the row number within each
  user, and timestamps run forward one minute apart.
- **`users` is built from the ledger** with one `GROUP BY`, so it matches by construction.
- **The seed ends with `ANALYZE` and `CHECKPOINT`.** Without the checkpoint, Postgres flushes
  the freshly written ~1.5 GB in the background during the first traffic. In the first
  measurements that pushed max latency to about 3 s.

**Seed time** (AMD Ryzen 5 4500U, 6 cores, 14 GB RAM, NVMe SSD, Docker on Linux):

| Rows | Time |
|---|---|
| 10M | **39–64 s** across runs (e.g. ledger insert 45 s, users build 9 s) |
| 1M | 5–8 s |

[db/reconcile.sql](db/reconcile.sql) on the seeded data: 0 mismatched users, 0 negative
balances, 0 users whose running balance ever went below 0.

---

## Tests ([api/test/](api/test/))

Run with `docker compose run --rm test`. They use `node:test` (built in) and real HTTP calls
against the running stack, plus direct SQL to inspect the ledger. **60 tests:**

- **Authentication:**
  - every failure case returns 401 on every endpoint;
  - no token plus broken JSON → 401, not 400;
  - unknown routes → 401;
  - rejected requests write nothing.
- **Validation:** every input rule, for both `/credit` and `/debit`:
  - decimals, floats, exponent form, strings, booleans, 0, negatives, `-0`;
  - amounts too large;
  - bad `user_id` characters, length and type;
  - boundaries (amount 1 and 1,000,000,000; a 64-character `user_id`);
  - unknown fields;
  - an unreadable body or malformed URL encoding → 400, not 500.
- **Contract:**
  - the example from the brief;
  - the user is created on first credit;
  - 404 vs 409, including a user at balance 0 → 409;
  - exactly one ledger row per successful operation;
  - nothing written on 409.
- **Concurrency rules 1–6:**
  - two debits of 60 against 100, repeated 50 times;
  - 200 concurrent debits never overdraw;
  - 1,000 concurrent credits of 100 → +100,000 exactly, and every response reports a different balance;
  - concurrent first credits for a new user;
  - ledger rows match successful responses exactly, under concurrency;
  - read-your-writes;
  - hot-user isolation, which asserts other users' p99;
  - a random mix of 500 operations returns only 200 or 409 and adds up.
- **Extras:**
  - `/health`;
  - an `Idempotency-Key` replay;
  - 20 concurrent requests with one key move money once;
  - a 409 is replayed;
  - a reused key gets 422;
  - invalid keys get 400.
- **Reconcile:** runs last. It checks the whole database with [db/reconcile.sql](db/reconcile.sql).

**Crash test** ([scripts/crash-test.sh](scripts/crash-test.sh)):
1. Run 20 parallel loops of credits and debits.
2. `SIGKILL` the API, then restart it.
3. `SIGKILL` PostgreSQL, then restart it.
4. Reconcile. Result: **0 mismatches**.

---

## Load test ([loadtest/load.js](loadtest/load.js))

`docker compose run --rm loadtest` runs k6 1.0 in a container on the compose network:

- **`mixed`:** 60 s, 100 virtual users (VUs) with no think time, across random seeded
  users (1% whales). 50% balance reads, 30% credits, 20% debits.
- **`hot`:** 30 s, 90 VUs on **one** user (`seed_whale_01`), same mix.
- **`others`:** runs at the same time as `hot`. 10 VUs on random other users, to measure isolation.

Status 200 and 409 are expected; anything else counts as failed. **Both runs: 0 unexpected
statuses.** Raw output: [loadtest/results/](loadtest/results/).

**p50 / p99 in ms,** same machine as the seed, fresh database each time:

| Scenario | Endpoint | 1M rows | 10M rows |
|---|---|---|---|
| mixed (100 VUs) | balance | 14.8 / 45.7 | 13.5 / 51.0 |
| mixed (100 VUs) | credit | 17.1 / 64.4 | 15.8 / 71.6 |
| mixed (100 VUs) | debit | 17.1 / 64.6 | 15.8 / 72.4 |
| hot user (90 VUs) | balance | 1.2 / 3.9 | 1.2 / 4.2 |
| hot user (90 VUs) | credit | 199 / 794 | 211 / 2179 |
| hot user (90 VUs) | debit | 199 / 863 | 211 / 2392 |
| other users during hot | balance | 1.2 / 3.6 | 1.2 / 3.5 |
| other users during hot | credit | 2.8 / 17.0 | 2.9 / 23.1 |
| other users during hot | debit | 2.8 / 17.6 | 2.9 / 23.4 |
| **throughput** | | 5,052 req/s | 4,995 req/s |

How to read this:
- **Latency does not grow with the table.** 1M and 10M rows are the same within noise,
  as the query plans predict.
- **Mixed traffic is queueing, not query time.** With no think time, 100 VUs at about
  5,000 req/s means each request waits about 20 ms in line (Little's law). The real
  per-request cost is in the next section: **about 0.7 ms for a read and about 1.8 ms
  for a write**, mostly the commit's disk flush.

  During the mixed run, the API process sat at 100% of one core. k6 and Postgres used
  about 1.3 cores each, on a 6-core laptop with a load average of about 11. So these
  absolute numbers are machine-bound.
- **Hot user: writes to one user are serialized by design.** 90 VUs on one row means each
  write waits behind about 89 others: 90 × about 2.2 ms per commit ≈ 200 ms at p50. Any
  slow disk flush delays the whole line, so p99 varies between runs (0.8–2.4 s here).
  Hot-user **reads** stay at about 1 ms, because reads never wait for row locks.
- **Isolation holds.** Other users' latency during the hot test is the same as with no hot traffic.

### Per-request cost with no other traffic: whale vs normal user

Two measurements, both with no other traffic:

- **[loadtest/sequential.js](loadtest/sequential.js):** k6 with one VU, so one request at
  a time, 400 per row. It alternates whale users (`seed_whale_*`) and normal users
  (`seed_u*`) request by request, so measurement order can't favour either group.
- **[loadtest/db-timing.sql](loadtest/db-timing.sql):** database-side execution time,
  median of 50 `EXPLAIN ANALYZE` runs, rolled back.

Raw output: `loadtest/results/sequential-*.txt`.

**End to end over HTTP, p50 / p99 in ms:**

| Endpoint | User | 1M rows | 10M rows |
|---|---|---|---|
| balance | whale | 0.73 / 2.43 | 0.70 / 2.57 |
| balance | normal | 0.67 / 2.90 | 0.65 / 1.83 |
| credit | whale | 1.79 / 3.99 | 1.79 / 3.83 |
| credit | normal | 1.89 / 3.85 | 1.84 / 3.62 |
| debit | whale | 1.86 / 3.70 | 1.88 / 4.06 |
| debit | normal | 1.84 / 3.93 | 1.86 / 3.32 |

**Inside PostgreSQL, median in ms:**

| Query | 1M: whale (17,267 rows) | 1M: normal (18 rows) | 10M: whale (152,509 rows) | 10M: normal (203 rows) |
|---|---|---|---|---|
| get_balance | 0.021 | 0.022 | 0.021 | 0.021 |
| credit | 0.062 | 0.062 | 0.061 | 0.062 |
| debit | 0.062 | 0.062 | 0.060 | 0.061 |

**Neither the table size nor a user's history size changes the cost of a request.** No
query reads history: a read is one `users` lookup, and a write updates one `users` row and
appends one ledger row. The only thing that slows a user down is many concurrent writes
to that same user (see "hot user" above).

---

## Known limits

**What breaks first at 10× load**
1. **Writes to a single user.** One row lock means about 1 / commit time: 360–480
   writes/s for one user on this machine (measured in the hot-user test and the
   1,000-credit test). This limit can't be removed while keeping strict
   per-user ordering. It can be raised by batching a user's queued writes into one
   transaction (see "More time").
2. **The single Node process (one core).** It was at 100% CPU in the mixed test. Run several
   instances or `cluster` workers behind a load balancer. Correctness is unaffected,
   because the database enforces it.
3. **PostgreSQL connections and WAL flush rate.** N instances × 20 connections needs
   PgBouncer in front of Postgres (transaction pooling; named prepared statements need
   PgBouncer ≥ 1.21). After that, it's commit throughput: faster disks, and group-commit
   tuning such as `commit_delay`.
4. **Growth.** The ledger grows forever, by design. Partition it by time if history
   queries are added. `idempotency_keys` also grows forever, because keys don't expire yet.

**What changes with several API instances**
- **Correctness doesn't change.** Atomicity, the non-negative rule, no lost updates and
  idempotency are all enforced by PostgreSQL (row locks, single statements, constraints,
  a unique key).
- **The per-user queue becomes per instance.** A hot user can then hold up to one
  connection per instance instead of one in total. That is still bounded.
- **Read-your-writes holds while all instances use the primary.** Adding read replicas
  would require sending balance reads to the primary, or accepting replica lag.

**Other limits**
- **Overflow.** A single balance above 9.2 × 10^18 minor units would overflow `BIGINT`
  and return a 500. That takes about 9 billion maximum-size credits to one user.
- **Shutdown timer.** Graceful shutdown waits up to 10 s for in-flight requests, then exits.

## What I would do with more time

- **Batch a hot user's queued writes** into one transaction (application-level group
  commit), to cut hot-user tail latency.
- **Expire idempotency keys** after, for example, 24 hours, with a periodic cleanup.
- **Run the load generator on a separate machine,** then tune PostgreSQL (`shared_buffers`,
  WAL and checkpoint settings) and the pool size from cleaner measurements.
- **Add metrics:** p50/p99 per endpoint, pool wait time and queue depth per hot user.
- **Add a transaction-history endpoint** with a `(user_id, id)` index, and time-based
  partitioning of the ledger.

---

## Project layout

```
docker-compose.yml        db + api; tools (seed, test, loadtest) under the "tools" profile
db/schema.sql             tables, constraints, immutability triggers (applied on first start)
db/seed.sql               10M-row seed (SEED_ROWS to change)
db/reconcile.sql          balance-vs-ledger check used by tests, crash test and reviewers
api/src/server.js         starts the app, graceful shutdown
api/src/app.js            routes and middleware order
api/src/auth.js           bearer token check (constant time)
api/src/validate.js       JSON parsing and input rules
api/src/ledger.js         SQL, retries, Idempotency-Key transaction
api/src/userLimiter.js    per-user write queue
api/src/errors.js         error shape
api/src/config.js         environment variables
api/test/                 node:test suites
loadtest/load.js          k6 load test: mixed, hot-user and isolation scenarios
loadtest/sequential.js    k6, one request at a time: whale vs normal user
loadtest/db-timing.sql    database-side timing: whale vs normal user
loadtest/results/         raw output of the runs quoted in this README
scripts/crash-test.sh     kill API and DB mid-traffic, then reconcile
```

---

## Brief checklist

| Brief requirement | Where |
|---|---|
| `docker compose up`, port 8080, client-server SQL database | [docker-compose.yml](docker-compose.yml): PostgreSQL 17 + API |
| `API_TOKEN`, default `recruitment-test-token`, overridable | `docker-compose.yml`; read in [api/src/config.js](api/src/config.js) |
| 401 before any DB access, constant-time compare, token never in source or logs | [api/src/auth.js](api/src/auth.js), registered first in [api/src/app.js](api/src/app.js) |
| `credit`, `debit`, `get_balance`; input rules; error shape and codes | [api/src/app.js](api/src/app.js), [api/src/validate.js](api/src/validate.js), [api/src/errors.js](api/src/errors.js) |
| Immutable ledger rows (id, user_id, type, amount, server timestamp) | [db/schema.sql](db/schema.sql): `CHECK` constraints and triggers |
| Balance = credits − debits; fast `get_balance` at 10M+ rows | Single-statement writes in [api/src/ledger.js](api/src/ledger.js); query plans above |
| Seed: 10M+ rows, 100k+ users, users with 100k+ rows, never negative; time in README | [db/seed.sql](db/seed.sql); "Seed" section |
| Concurrency rules 1–6 | "Concurrency and isolation level"; [api/test/concurrency.test.js](api/test/concurrency.test.js); [scripts/crash-test.sh](scripts/crash-test.sh) |
| p50/p99 per endpoint, about 100 threads, hot user, 1M vs 10M, `EXPLAIN` | "Load test", "Per-request cost", "Query plans"; [loadtest/](loadtest/) |
| Schema with all indexes, tests, load-test script and results | `db/`, `api/test/`, `loadtest/` |
| README: run, design, query plans, limits, more time | This file |
| Optional: `Idempotency-Key`, health endpoint, graceful shutdown | "Optional extras" |
