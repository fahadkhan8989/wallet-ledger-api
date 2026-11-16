-- Runs automatically on the first `docker compose up` (empty database volume).

-- One row per user. The row is created by the user's first credit.
-- `id` is the client's own user_id string (e.g. 'u123'); we never generate it.
-- `balance` is a running total kept in step with the ledger by the same SQL
-- statement that writes the ledger row (see api/src/ledger.js).
CREATE TABLE users (
  id         VARCHAR(64) PRIMARY KEY,
  balance    BIGINT      NOT NULL CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The source of truth: one immutable row per credit or debit.
-- No secondary indexes: the API never reads this table, so extra indexes
-- would only slow down every write.
CREATE TABLE ledger (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    VARCHAR(64) NOT NULL,
  type       TEXT        NOT NULL CHECK (type IN ('credit', 'debit')),
  amount     BIGINT      NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger rows are never updated or deleted: the database refuses it.
CREATE FUNCTION reject_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable (% is not allowed)', TG_OP;
END;
$$;

CREATE TRIGGER ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_change();

CREATE TRIGGER ledger_no_truncate
  BEFORE TRUNCATE ON ledger
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_change();

-- Optional Idempotency-Key support: one row per key, written in the same
-- transaction as the credit/debit it belongs to. A retry with the same key
-- gets the saved outcome back instead of moving money twice.
CREATE TABLE idempotency_keys (
  key        VARCHAR(255) PRIMARY KEY,
  operation  TEXT        NOT NULL CHECK (operation IN ('credit', 'debit')),
  user_id    VARCHAR(64) NOT NULL,
  amount     BIGINT      NOT NULL,
  outcome    TEXT        NOT NULL,  -- 'ok', 'user_not_found' or 'insufficient_funds'
  balance    BIGINT,                -- balance returned with 'ok'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
