// Load test: docker compose run --rm loadtest   (after seeding)
//
// Scenario "mixed" (60s, 100 VUs): random seeded users;
//   50% balance reads, 30% credits, 20% debits.
// Scenario "hot" (30s, 100 VUs): 90 VUs on ONE user (seed_whale_01) while
//   10 VUs keep serving random other users ("others"), to show isolation.
//
// Prints p50/p99 per scenario and endpoint. 200 and 409 are expected
// statuses; anything else counts as a failed request.
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
if (!__ENV.API_TOKEN) throw new Error('API_TOKEN must be set (docker compose run --rm loadtest passes it)');
const HEADERS = {
  Authorization: `Bearer ${__ENV.API_TOKEN}`,
  'Content-Type': 'application/json',
};
const HOT_USER = 'seed_whale_01';

http.setResponseCallback(http.expectedStatuses(200, 409));

const SERIES = [];
for (const scenario of ['mixed', 'hot', 'others']) {
  for (const name of ['balance', 'credit', 'debit']) SERIES.push(`{scenario:${scenario},name:${name}}`);
}

export const options = {
  summaryTrendStats: ['p(50)', 'p(99)', 'max', 'count'],
  scenarios: {
    mixed: { executor: 'constant-vus', vus: 100, duration: '60s', exec: 'mixed' },
    hot: { executor: 'constant-vus', vus: 90, duration: '30s', startTime: '65s', exec: 'hot' },
    others: { executor: 'constant-vus', vus: 10, duration: '30s', startTime: '65s', exec: 'others' },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
    // One (always-true) threshold per series makes k6 report it separately.
    ...Object.fromEntries(SERIES.map((s) => [`http_req_duration${s}`, ['max>=0']])),
  },
};

// 100,000 regular seeded users plus 20 whales.
function randomUser() {
  if (Math.random() < 0.01) return `seed_whale_${String(1 + Math.floor(Math.random() * 20)).padStart(2, '0')}`;
  return `seed_u${String(1 + Math.floor(Math.random() * 100000)).padStart(6, '0')}`;
}

function operation(userId) {
  const r = Math.random();
  const amount = 1 + Math.floor(Math.random() * 100);
  if (r < 0.5) {
    const res = http.get(`${BASE_URL}/balance/${userId}`, { headers: HEADERS, tags: { name: 'balance' } });
    check(res, { 'balance 200': (x) => x.status === 200 });
  } else if (r < 0.8) {
    const res = http.post(`${BASE_URL}/credit`, JSON.stringify({ user_id: userId, amount }), { headers: HEADERS, tags: { name: 'credit' } });
    check(res, { 'credit 200': (x) => x.status === 200 });
  } else {
    const res = http.post(`${BASE_URL}/debit`, JSON.stringify({ user_id: userId, amount }), { headers: HEADERS, tags: { name: 'debit' } });
    check(res, { 'debit 200/409': (x) => x.status === 200 || x.status === 409 });
  }
}

export function mixed() { operation(randomUser()); }
export function hot() { operation(HOT_USER); }
export function others() { operation(randomUser()); }

export function handleSummary(data) {
  const fmt = (v) => (v === undefined ? '-' : v.toFixed(2)).padStart(9);
  const lines = ['', 'scenario  endpoint      count   p50 ms   p99 ms   max ms'];
  for (const series of SERIES) {
    const m = data.metrics[`http_req_duration${series}`];
    if (!m) continue;
    const [, scenario, name] = series.match(/scenario:(\w+),name:(\w+)/);
    const v = m.values;
    lines.push(`${scenario.padEnd(9)} ${name.padEnd(9)} ${String(v.count).padStart(9)}${fmt(v['p(50)'])}${fmt(v['p(99)'])}${fmt(v.max)}`);
  }
  const reqs = data.metrics.http_reqs.values;
  const failed = data.metrics.http_req_failed.values;
  lines.push('', `total requests: ${reqs.count} (${reqs.rate.toFixed(0)}/s), unexpected statuses: ${failed.passes}`, '');
  return { stdout: lines.join('\n') };
}
