-- Checks every user's balance against the ledger. All columns except
-- users and ledger_rows must be 0.
--   docker compose exec -T db psql -U ledger -d ledger < db/reconcile.sql

WITH totals AS (
  SELECT user_id,
         sum(CASE type WHEN 'credit' THEN amount ELSE -amount END) AS ledger_balance
  FROM ledger
  GROUP BY user_id
)
SELECT
  (SELECT count(*) FROM users)  AS users,
  (SELECT count(*) FROM ledger) AS ledger_rows,
  -- balance differs from credits minus debits, or a row exists on one side only
  (SELECT count(*)
     FROM users u FULL JOIN totals t ON t.user_id = u.id
    WHERE u.id IS NULL OR t.user_id IS NULL OR u.balance <> t.ledger_balance) AS mismatched_users,
  (SELECT count(*) FROM users WHERE balance < 0) AS negative_balances,
  -- running balance in ledger order dipped below 0 at some point
  (SELECT count(DISTINCT user_id)
     FROM (SELECT user_id,
                  sum(CASE type WHEN 'credit' THEN amount ELSE -amount END)
                    OVER (PARTITION BY user_id ORDER BY id) AS running
             FROM ledger) r
    WHERE running < 0) AS users_ever_below_zero;
