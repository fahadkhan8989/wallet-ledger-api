#!/usr/bin/env bash
# Crash test (rule 3): kill the API, then the database, with SIGKILL while
# credits and debits are in flight; restart both; check every balance still
# matches the ledger. Run with the stack up: ./scripts/crash-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Use whatever token the running API was started with.
TOKEN="$(docker compose exec -T api printenv API_TOKEN)"
URL="http://localhost:8080"

send() { # send <credit|debit> <user> <amount>
  curl -s -o /dev/null -m 5 -X POST "$URL/$1" -H "Authorization: Bearer $TOKEN" \
    -d "{\"user_id\":\"$2\",\"amount\":$3}" || true
}

echo "starting traffic: 20 parallel loops of credits and debits"
for i in $(seq 1 20); do
  ( while true; do
      user="crash_$((RANDOM % 5))"
      send credit "$user" 10
      send debit "$user" 7
    done ) &
done
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT

sleep 3
echo "killing the API (SIGKILL) mid-traffic"
docker compose kill api
sleep 1
docker compose start api

sleep 3
echo "killing the database (SIGKILL) mid-traffic"
docker compose kill db
sleep 1
docker compose start db
until docker compose exec -T db pg_isready -h 127.0.0.1 -U ledger -d ledger >/dev/null 2>&1; do sleep 1; done

sleep 3
kill $(jobs -p) 2>/dev/null || true
wait 2>/dev/null || true

echo "reconciling balances against the ledger"
docker compose exec -T db psql -U ledger -d ledger < db/reconcile.sql
result=$(docker compose exec -T db psql -U ledger -d ledger -At -F ' ' < db/reconcile.sql)
read -r users rows mismatched negative below_zero <<< "$result"
if [[ "$mismatched" == 0 && "$negative" == 0 && "$below_zero" == 0 ]]; then
  echo "PASS: data is consistent after both crashes"
else
  echo "FAIL: inconsistent data after crash"
  exit 1
fi
