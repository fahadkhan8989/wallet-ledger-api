// Per-request latency with no other traffic: ONE request at a time.
//   docker compose run --rm loadtest run --quiet /scripts/sequential.js
//
// Alternates whale users (seed_whale_*, ~150,000 ledger rows each at 10M) and
// normal users (seed_u*, 1-200 rows) request by request, so measurement order
// can't favour either group. Prints p50/p99 per endpoint and user type.
import http from 'k6/http';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
if (!__ENV.API_TOKEN) throw new Error('API_TOKEN must be set (docker compose run --rm loadtest passes it)');
const HEADERS = { Authorization: `Bearer ${__ENV.API_TOKEN}`, 'Content-Type': 'application/json' };

const ENDPOINTS = ['balance', 'credit', 'debit'];
const TYPES = ['whale', 'normal'];
const PER_SERIES = 400;
const WARMUP = 60;

const SERIES = [];
for (const name of ENDPOINTS) for (const type of TYPES) SERIES.push(`{name:${name},user_type:${type}}`);

export const options = {
  summaryTrendStats: ['p(50)', 'p(99)', 'max', 'count'],
  scenarios: {
    sequential: {
      executor: 'per-vu-iterations', vus: 1,
      iterations: WARMUP + PER_SERIES * ENDPOINTS.length * TYPES.length, maxDuration: '10m',
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    ...Object.fromEntries(SERIES.map((s) => [`http_req_duration${s}`, ['max>=0']])),
  },
};

const whale = (i) => `seed_whale_${String(1 + (i % 20)).padStart(2, '0')}`;
const normal = (i) => `seed_u${String(1 + ((i * 499) % 100000)).padStart(6, '0')}`;

export default function () {
  const i = exec.scenario.iterationInTest;
  if (i < WARMUP) { // warm up connections and prepared statements; not measured
    http.get(`${BASE_URL}/balance/${normal(i)}`, { headers: HEADERS, tags: { name: 'warmup' } });
    return;
  }
  const n = i - WARMUP;
  const type = TYPES[n % 2];
  const name = ENDPOINTS[Math.floor(n / 2) % 3];
  const userId = type === 'whale' ? whale(n) : normal(n);
  const tags = { name, user_type: type };

  if (name === 'balance') http.get(`${BASE_URL}/balance/${userId}`, { headers: HEADERS, tags });
  else http.post(`${BASE_URL}/${name}`, JSON.stringify({ user_id: userId, amount: 1 }), { headers: HEADERS, tags });
}

export function handleSummary(data) {
  const fmt = (v) => v.toFixed(2).padStart(8);
  const lines = ['', 'endpoint  user type   count   p50 ms  p99 ms  max ms'];
  for (const series of SERIES) {
    const v = data.metrics[`http_req_duration${series}`].values;
    const [, name, type] = series.match(/name:(\w+),user_type:(\w+)/);
    lines.push(`${name.padEnd(9)} ${type.padEnd(9)} ${String(v.count).padStart(6)}${fmt(v['p(50)'])}${fmt(v['p(99)'])}${fmt(v.max)}`);
  }
  lines.push('', `unexpected statuses: ${data.metrics.http_req_failed.values.passes}`, '');
  return { stdout: lines.join('\n') };
}
