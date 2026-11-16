-- Database-side execution time, whale vs normal user (median of 50 runs each).
--   docker compose exec -T db psql -U ledger -d ledger -q < loadtest/db-timing.sql
-- Runs inside a transaction that is rolled back, so nothing is kept.
\pset footer off
BEGIN;
CREATE TEMP TABLE timings (query TEXT, user_id TEXT, ms NUMERIC);

DO $$
DECLARE
  u TEXT; plan JSON;
BEGIN
  FOREACH u IN ARRAY ARRAY['seed_whale_02', 'seed_u099000'] LOOP
    FOR i IN 1..50 LOOP
      EXECUTE format('EXPLAIN (ANALYZE, FORMAT JSON) SELECT balance FROM users WHERE id = %L', u) INTO plan;
      INSERT INTO timings VALUES ('get_balance', u, (plan->0->>'Execution Time')::numeric);

      EXECUTE format($q$EXPLAIN (ANALYZE, FORMAT JSON)
        WITH updated AS (
          INSERT INTO users (id, balance) VALUES (%1$L, 1)
          ON CONFLICT (id) DO UPDATE SET balance = users.balance + EXCLUDED.balance
          RETURNING balance
        ), entry AS (INSERT INTO ledger (user_id, type, amount) SELECT %1$L, 'credit', 1 FROM updated)
        SELECT balance FROM updated$q$, u) INTO plan;
      INSERT INTO timings VALUES ('credit', u, (plan->0->>'Execution Time')::numeric);

      EXECUTE format($q$EXPLAIN (ANALYZE, FORMAT JSON)
        WITH updated AS (
          UPDATE users SET balance = balance - 1 WHERE id = %1$L AND balance >= 1 RETURNING balance
        ), entry AS (INSERT INTO ledger (user_id, type, amount) SELECT %1$L, 'debit', 1 FROM updated)
        SELECT balance FROM updated$q$, u) INTO plan;
      INSERT INTO timings VALUES ('debit', u, (plan->0->>'Execution Time')::numeric);
    END LOOP;
  END LOOP;
END $$;

WITH rows_per_user AS (
  SELECT user_id, count(*) AS ledger_rows FROM ledger
  WHERE user_id IN ('seed_whale_02', 'seed_u099000') GROUP BY user_id
)
SELECT t.query, t.user_id, r.ledger_rows - 100 AS ledger_rows,  -- minus this script's 100 rows
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY t.ms))::numeric, 3) AS median_ms
FROM timings t JOIN rows_per_user r USING (user_id)
GROUP BY t.query, t.user_id, r.ledger_rows
ORDER BY t.query, t.user_id DESC;

ROLLBACK;
