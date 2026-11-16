-- Seed: :rows ledger rows (default 10,000,000) for 100,020 users.
--   docker compose run --rm seed                       (10M rows)
--   SEED_ROWS=1000000 docker compose run --rm seed     (1M rows)
--
-- Users:
--   seed_whale_01..20     share 30% of the rows (150,000 rows each at 10M)
--   seed_u000001..100000  share the rest unevenly: from 1 row up to ~3x the average
--
-- Every user's rows alternate credit, debit, credit, debit, ... and each debit
-- is 80% of the credit just before it, so the running balance never drops
-- below 0. The users table is then built from the ledger rows, so it matches.

\set ON_ERROR_STOP on
\timing on

BEGIN;

-- Refuse to run twice (the ledger is append-only, so it can't be undone).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = 'seed_whale_01') THEN
    RAISE EXCEPTION 'seed data is already loaded (run "docker compose down -v" for a fresh database)';
  END IF;
END $$;

-- 1. Plan how many rows each user gets.
CREATE TEMP TABLE plan (idx INT PRIMARY KEY, user_id TEXT NOT NULL, n INT NOT NULL) ON COMMIT DROP;

-- Regular users: n grows with the square of the user's position, from 1 up to
-- about 3x the average, so most users are small and a few are large.
INSERT INTO plan
SELECT i,
       'seed_u' || lpad(i::text, 6, '0'),
       1 + floor(3 * (0.7 * :rows / 100000 - 1) * ((i - 0.5) / 100000.0) ^ 2)::int
FROM generate_series(1, 100000) AS i;

-- Whales split whatever is left, so the total is at least :rows.
INSERT INTO plan
SELECT 100000 + w,
       'seed_whale_' || lpad(w::text, 2, '0'),
       ceil((:rows - (SELECT sum(n) FROM plan)) / 20.0)::int
FROM generate_series(1, 20) AS w;

-- 2. Generate the ledger rows. Row k of a user is a credit when k is odd and
-- a debit of 80% of the previous credit when k is even. Credit amounts are a
-- deterministic spread from 100 to 10,000. Timestamps run forward per user,
-- one minute apart, ending now.
INSERT INTO ledger (user_id, type, amount, created_at)
SELECT p.user_id,
       CASE WHEN k % 2 = 1 THEN 'credit' ELSE 'debit' END,
       CASE WHEN k % 2 = 1
            THEN 100 + (k::bigint * 7919 + p.idx::bigint * 104729) % 9901
            ELSE (100 + ((k - 1)::bigint * 7919 + p.idx::bigint * 104729) % 9901) * 4 / 5
       END,
       now() - (p.n - k) * interval '1 minute'
FROM plan p
CROSS JOIN LATERAL generate_series(1, p.n) AS k
ORDER BY p.idx, k;   -- ids increase with k within each user

-- 3. Build each seeded user's balance from their ledger rows.
INSERT INTO users (id, balance, created_at)
SELECT l.user_id,
       sum(CASE l.type WHEN 'credit' THEN l.amount ELSE -l.amount END),
       min(l.created_at)
FROM ledger l
JOIN plan p ON p.user_id = l.user_id
GROUP BY l.user_id;

-- Summary of what was loaded.
SELECT count(*) AS seeded_users,
       sum(n)   AS seeded_rows,
       max(n)   AS max_rows_per_user,
       count(*) FILTER (WHERE n >= 100000) AS users_with_100k_plus_rows,
       min(n)   AS min_rows_per_user
FROM plan;

COMMIT;

ANALYZE users;
ANALYZE ledger;

-- Flush the seeded data to disk now, so the flush doesn't stall the first
-- traffic after seeding.
CHECKPOINT;
